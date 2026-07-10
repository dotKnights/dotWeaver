import { Prisma } from '@prisma/client';
import { assertPermissions, permissionPresets } from '$lib/authz/permissions';
import type { PermissionKey, PermissionPresetKey } from '$lib/authz/permissions';
import { prisma } from '$lib/server/prisma';
import { resolveSlug } from '$lib/server/teams/slug';

const CLIENT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SERIALIZABLE_RETRY_ATTEMPTS = 3;

export class ClientAccessError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ClientAccessError';
	}
}

type ClientMemberRole = 'admin' | 'member';
type AccessGrantSubjectType = 'client_organization' | 'client_member';

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
	if (error instanceof Prisma.PrismaClientKnownRequestError) {
		return error.code === 'P2002';
	}
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === 'P2002'
	);
}

function isPrismaSerializationError(error: unknown): boolean {
	if (error instanceof Prisma.PrismaClientKnownRequestError) {
		return error.code === 'P2034';
	}
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === 'P2034'
	);
}

function mapPrismaConsistencyError(error: unknown): never {
	if (isPrismaUniqueConstraintError(error)) {
		throw new ClientAccessError('Client access already exists');
	}
	if (isPrismaSerializationError(error)) {
		throw new ClientAccessError('Client access update conflict');
	}
	throw error;
}

async function serializableTransactionWithRetry<T>(
	callback: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
	let lastError: unknown;

	for (let attempt = 0; attempt < SERIALIZABLE_RETRY_ATTEMPTS; attempt++) {
		try {
			return await prisma.$transaction(callback, {
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			});
		} catch (e) {
			if (!isPrismaSerializationError(e)) throw e;
			lastError = e;
		}
	}

	throw lastError;
}

async function requireProjectInOrganization(organizationId: string, projectId: string) {
	const project = await prisma.project.findFirst({
		where: { id: projectId, organizationId },
		select: { id: true }
	});
	if (!project) throw new ClientAccessError('Project not found');
	return project;
}

async function requireAccessSubjectInOrganization({
	organizationId,
	subjectType,
	subjectId
}: {
	organizationId: string;
	subjectType: AccessGrantSubjectType;
	subjectId: string;
}) {
	if (subjectType === 'client_organization') {
		const subject = await prisma.clientOrganization.findFirst({
			where: { id: subjectId, organizationId },
			select: { id: true }
		});
		if (!subject) throw new ClientAccessError('Access subject not found');
		return subject;
	}

	if (subjectType === 'client_member') {
		const subject = await prisma.clientOrganizationMember.findFirst({
			where: { id: subjectId, organizationId },
			select: { id: true }
		});
		if (!subject) throw new ClientAccessError('Access subject not found');
		return subject;
	}

	throw new ClientAccessError('Access subject not found');
}

function validatePermissions(permissions: readonly string[]): PermissionKey[] {
	try {
		return assertPermissions(permissions);
	} catch (e) {
		if (e instanceof Error) throw new ClientAccessError(e.message);
		throw e;
	}
}

export async function createClientOrganization({
	organizationId,
	userId,
	name
}: {
	organizationId: string;
	userId: string;
	name: string;
}) {
	const slug = await resolveSlug(
		name,
		async (candidate) =>
			(await prisma.clientOrganization.findFirst({
				where: { organizationId, slug: candidate },
				select: { id: true }
			})) !== null
	);

	const clientOrganization = await prisma.clientOrganization.create({
		data: {
			organizationId,
			name,
			slug,
			createdById: userId
		},
		select: { id: true, slug: true }
	});

	return clientOrganization;
}

export async function listClientOrganizations(organizationId: string) {
	return await prisma.clientOrganization.findMany({
		where: { organizationId },
		orderBy: { createdAt: 'desc' },
		include: {
			members: {
				orderBy: { createdAt: 'asc' },
				select: {
					id: true,
					role: true,
					createdAt: true,
					user: {
						select: {
							id: true,
							name: true,
							email: true,
							image: true
						}
					}
				}
			},
			invitations: {
				where: { status: 'pending' },
				orderBy: { createdAt: 'desc' },
				select: {
					id: true,
					email: true,
					role: true,
					status: true,
					expiresAt: true,
					createdAt: true
				}
			}
		}
	});
}

export async function inviteClientMember({
	organizationId,
	clientOrganizationId,
	userId,
	email,
	role,
	now = new Date()
}: {
	organizationId: string;
	clientOrganizationId: string;
	userId: string;
	email: string;
	role: ClientMemberRole;
	now?: Date;
}) {
	const clientOrganization = await prisma.clientOrganization.findFirst({
		where: { id: clientOrganizationId, organizationId },
		select: { id: true }
	});
	if (!clientOrganization) throw new ClientAccessError('Client organization not found');

	const normalizedEmail = normalizeEmail(email);

	try {
		return await serializableTransactionWithRetry(async (tx) => {
			const existingInvitation = await tx.clientInvitation.findFirst({
				where: {
					organizationId,
					clientOrganizationId,
					email: normalizedEmail,
					status: 'pending',
					expiresAt: { gt: now }
				},
				select: { id: true }
			});
			if (existingInvitation) return { invitationId: existingInvitation.id };

			const invitation = await tx.clientInvitation.create({
				data: {
					organizationId,
					clientOrganizationId,
					email: normalizedEmail,
					role,
					status: 'pending',
					invitedById: userId,
					expiresAt: new Date(now.getTime() + CLIENT_INVITATION_TTL_MS)
				},
				select: { id: true }
			});

			return { invitationId: invitation.id };
		});
	} catch (e) {
		mapPrismaConsistencyError(e);
	}
}

export async function acceptClientInvitation({
	invitationId,
	userId,
	email,
	now = new Date()
}: {
	invitationId: string;
	userId: string;
	email: string;
	now?: Date;
}) {
	const normalizedEmail = normalizeEmail(email);

	try {
		const result = await prisma.$transaction(async (tx) => {
			const invitation = await tx.clientInvitation.findUnique({
				where: { id: invitationId }
			});

			async function returnIdempotentAcceptedInvitation(acceptedInvitation: {
				organizationId: string;
				clientOrganizationId: string;
				email: string;
				status: string;
			}) {
				if (
					acceptedInvitation.status !== 'accepted' ||
					normalizeEmail(acceptedInvitation.email) !== normalizedEmail
				) {
					throw new ClientAccessError('Invitation not found');
				}

				const membership = await tx.clientOrganizationMember.findFirst({
					where: {
						clientOrganizationId: acceptedInvitation.clientOrganizationId,
						userId,
						organizationId: acceptedInvitation.organizationId
					},
					select: { id: true }
				});
				if (!membership) throw new ClientAccessError('Invitation not found');

				return {
					status: 'accepted' as const,
					clientOrganizationId: acceptedInvitation.clientOrganizationId
				};
			}

			if (!invitation) {
				throw new ClientAccessError('Invitation not found');
			}

			if (invitation.status !== 'pending') {
				return await returnIdempotentAcceptedInvitation(invitation);
			}

			if (normalizeEmail(invitation.email) !== normalizedEmail) {
				throw new ClientAccessError('Invitation email does not match this account');
			}

			if (invitation.expiresAt <= now) {
				const expired = await tx.clientInvitation.updateMany({
					where: { id: invitation.id, status: 'pending' },
					data: { status: 'expired' }
				});
				if (expired.count === 0) {
					const currentInvitation = await tx.clientInvitation.findUnique({
						where: { id: invitationId }
					});
					if (!currentInvitation) throw new ClientAccessError('Invitation not found');

					return await returnIdempotentAcceptedInvitation(currentInvitation);
				}
				return { status: 'expired' as const };
			}

			const claim = await tx.clientInvitation.updateMany({
				where: { id: invitation.id, status: 'pending' },
				data: { status: 'accepted', acceptedAt: now }
			});

			if (claim.count === 0) {
				const currentInvitation = await tx.clientInvitation.findUnique({
					where: { id: invitationId }
				});
				if (!currentInvitation) throw new ClientAccessError('Invitation not found');

				return await returnIdempotentAcceptedInvitation(currentInvitation);
			}

			await tx.clientOrganizationMember.upsert({
				where: {
					clientOrganizationId_userId: {
						clientOrganizationId: invitation.clientOrganizationId,
						userId
					}
				},
				create: {
					organizationId: invitation.organizationId,
					clientOrganizationId: invitation.clientOrganizationId,
					userId,
					role: invitation.role
				},
				update: { role: invitation.role },
				select: { id: true }
			});

			return {
				status: 'accepted' as const,
				clientOrganizationId: invitation.clientOrganizationId
			};
		});

		if (result.status === 'expired') {
			throw new ClientAccessError('Invitation expired');
		}

		return { clientOrganizationId: result.clientOrganizationId };
	} catch (e) {
		if (e instanceof ClientAccessError) throw e;
		mapPrismaConsistencyError(e);
	}
}

export async function upsertProjectAccessGrant({
	organizationId,
	userId,
	projectId,
	subjectType,
	subjectId,
	permissions
}: {
	organizationId: string;
	userId: string;
	projectId: string;
	subjectType: AccessGrantSubjectType;
	subjectId: string;
	permissions: readonly string[];
}) {
	await requireProjectInOrganization(organizationId, projectId);
	await requireAccessSubjectInOrganization({ organizationId, subjectType, subjectId });
	const validatedPermissions = validatePermissions(permissions);

	const grant = await prisma.accessGrant.upsert({
		where: {
			organizationId_subjectType_subjectId_resourceType_resourceId: {
				organizationId,
				subjectType,
				subjectId,
				resourceType: 'project',
				resourceId: projectId
			}
		},
		create: {
			organizationId,
			subjectType,
			subjectId,
			resourceType: 'project',
			resourceId: projectId,
			createdById: userId,
			permissions: validatedPermissions
		},
		update: { permissions: validatedPermissions },
		select: { id: true }
	});

	return { id: grant.id };
}

export function permissionsForPreset(preset: PermissionPresetKey): string[] {
	return [...permissionPresets[preset].permissions];
}

export async function listProjectAccessGrants(organizationId: string, projectId: string) {
	await requireProjectInOrganization(organizationId, projectId);
	return await prisma.accessGrant.findMany({
		where: { organizationId, resourceType: 'project', resourceId: projectId },
		orderBy: { createdAt: 'desc' }
	});
}

export async function removeProjectAccessGrant({
	organizationId,
	projectId,
	subjectType,
	subjectId
}: {
	organizationId: string;
	projectId: string;
	subjectType: AccessGrantSubjectType;
	subjectId: string;
}) {
	await requireProjectInOrganization(organizationId, projectId);
	const result = await prisma.accessGrant.deleteMany({
		where: {
			organizationId,
			resourceType: 'project',
			resourceId: projectId,
			subjectType,
			subjectId
		}
	});

	return { removed: result.count > 0 };
}
