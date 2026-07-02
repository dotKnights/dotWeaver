import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const mocks = vi.hoisted(() => ({
	prismaTransaction: vi.fn(),
	transactionOutcomes: [] as string[],
	resolveSlug: vi.fn(),
	clientOrganizationFindFirst: vi.fn(),
	clientOrganizationFindMany: vi.fn(),
	clientOrganizationCreate: vi.fn(),
	clientInvitationFindUnique: vi.fn(),
	clientInvitationFindFirst: vi.fn(),
	clientInvitationCreate: vi.fn(),
	clientInvitationUpdate: vi.fn(),
	clientInvitationUpdateMany: vi.fn(),
	clientOrganizationMemberCreate: vi.fn(),
	clientOrganizationMemberUpsert: vi.fn(),
	clientOrganizationMemberFindFirst: vi.fn(),
	projectFindFirst: vi.fn(),
	accessGrantUpsert: vi.fn(),
	accessGrantFindMany: vi.fn(),
	accessGrantDeleteMany: vi.fn()
}));

vi.mock('$lib/server/teams/slug', () => ({ resolveSlug: mocks.resolveSlug }));
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		$transaction: mocks.prismaTransaction,
		clientOrganization: {
			findFirst: mocks.clientOrganizationFindFirst,
			findMany: mocks.clientOrganizationFindMany,
			create: mocks.clientOrganizationCreate
		},
		clientInvitation: {
			findUnique: mocks.clientInvitationFindUnique,
			findFirst: mocks.clientInvitationFindFirst,
			create: mocks.clientInvitationCreate,
			update: mocks.clientInvitationUpdate,
			updateMany: mocks.clientInvitationUpdateMany
		},
		clientOrganizationMember: {
			create: mocks.clientOrganizationMemberCreate,
			upsert: mocks.clientOrganizationMemberUpsert,
			findFirst: mocks.clientOrganizationMemberFindFirst
		},
		project: { findFirst: mocks.projectFindFirst },
		accessGrant: {
			upsert: mocks.accessGrantUpsert,
			findMany: mocks.accessGrantFindMany,
			deleteMany: mocks.accessGrantDeleteMany
		}
	}
}));

import {
	ClientAccessError,
	acceptClientInvitation,
	createClientOrganization,
	inviteClientMember,
	listClientOrganizations,
	listProjectAccessGrants,
	permissionsForPreset,
	removeProjectAccessGrant,
	upsertProjectAccessGrant
} from '$lib/server/client-access/service';
import { permissionPresets } from '$lib/authz/permissions';

const prismaTransaction = mocks.prismaTransaction as Mock;
const transactionOutcomes = mocks.transactionOutcomes;
const resolveSlug = mocks.resolveSlug as Mock;
const clientOrganizationFindFirst = mocks.clientOrganizationFindFirst as Mock;
const clientOrganizationFindMany = mocks.clientOrganizationFindMany as Mock;
const clientOrganizationCreate = mocks.clientOrganizationCreate as Mock;
const clientInvitationFindUnique = mocks.clientInvitationFindUnique as Mock;
const clientInvitationFindFirst = mocks.clientInvitationFindFirst as Mock;
const clientInvitationCreate = mocks.clientInvitationCreate as Mock;
const clientInvitationUpdate = mocks.clientInvitationUpdate as Mock;
const clientInvitationUpdateMany = mocks.clientInvitationUpdateMany as Mock;
const clientOrganizationMemberCreate = mocks.clientOrganizationMemberCreate as Mock;
const clientOrganizationMemberUpsert = mocks.clientOrganizationMemberUpsert as Mock;
const clientOrganizationMemberFindFirst = mocks.clientOrganizationMemberFindFirst as Mock;
const projectFindFirst = mocks.projectFindFirst as Mock;
const accessGrantUpsert = mocks.accessGrantUpsert as Mock;
const accessGrantFindMany = mocks.accessGrantFindMany as Mock;
const accessGrantDeleteMany = mocks.accessGrantDeleteMany as Mock;

describe('client access service', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		transactionOutcomes.length = 0;
		prismaTransaction.mockImplementation(async (callback) => {
			try {
				const result = await callback({
					clientInvitation: {
						findUnique: clientInvitationFindUnique,
						findFirst: clientInvitationFindFirst,
						create: clientInvitationCreate,
						update: clientInvitationUpdate,
						updateMany: clientInvitationUpdateMany
					},
					clientOrganizationMember: {
						upsert: clientOrganizationMemberUpsert,
						findFirst: clientOrganizationMemberFindFirst
					}
				});
				transactionOutcomes.push('resolved');
				return result;
			} catch (e) {
				transactionOutcomes.push('rejected');
				throw e;
			}
		});
		resolveSlug.mockImplementation(async (name: string, exists: (slug: string) => Promise<boolean>) => {
			if (await exists('acme')) return 'acme-2';
			return name.toLowerCase();
		});
		clientOrganizationFindFirst.mockResolvedValue(null);
		clientOrganizationCreate.mockResolvedValue({ id: 'client_org1', slug: 'acme-2' });
		clientInvitationCreate.mockResolvedValue({ id: 'invite1' });
		clientInvitationUpdate.mockResolvedValue({ id: 'invite1' });
		clientInvitationUpdateMany.mockResolvedValue({ count: 1 });
		clientOrganizationMemberCreate.mockResolvedValue({ id: 'client_member1' });
		clientOrganizationMemberUpsert.mockResolvedValue({ id: 'client_member1' });
		projectFindFirst.mockResolvedValue({ id: 'project1' });
		clientOrganizationMemberFindFirst.mockResolvedValue({ id: 'client_member1' });
		accessGrantUpsert.mockResolvedValue({ id: 'grant1' });
		accessGrantFindMany.mockResolvedValue([{ id: 'grant1' }]);
		accessGrantDeleteMany.mockResolvedValue({ count: 1 });
	});

	it('creates client organization slugs scoped to the owner team', async () => {
		clientOrganizationFindFirst.mockResolvedValueOnce({ id: 'existing' });

		await expect(
			createClientOrganization({
				organizationId: 'org1',
				userId: 'user1',
				name: 'Acme'
			})
		).resolves.toEqual({ id: 'client_org1', slug: 'acme-2' });

		expect(resolveSlug).toHaveBeenCalledWith('Acme', expect.any(Function));
		expect(clientOrganizationFindFirst).toHaveBeenCalledWith({
			where: { organizationId: 'org1', slug: 'acme' },
			select: { id: true }
		});
		expect(clientOrganizationCreate).toHaveBeenCalledWith({
			data: {
				organizationId: 'org1',
				name: 'Acme',
				slug: 'acme-2',
				createdById: 'user1'
			},
			select: { id: true, slug: true }
		});
	});

	it('lists client organizations for a team with members and pending invitations newest first', async () => {
		clientOrganizationFindMany.mockResolvedValue([{ id: 'client_org1', name: 'Acme' }]);

		await expect(listClientOrganizations('org1')).resolves.toEqual([
			{ id: 'client_org1', name: 'Acme' }
		]);

		expect(clientOrganizationFindMany).toHaveBeenCalledWith({
			where: { organizationId: 'org1' },
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
	});

	it('creates invitations that expire after seven days', async () => {
		const now = new Date('2026-07-02T10:00:00.000Z');
		clientOrganizationFindFirst.mockResolvedValue({ id: 'client_org1' });
		clientInvitationFindFirst.mockResolvedValue(null);

		await expect(
			inviteClientMember({
				organizationId: 'org1',
				clientOrganizationId: 'client_org1',
				userId: 'user1',
				email: ' Client@Example.com ',
				role: 'admin',
				now
			})
		).resolves.toEqual({ invitationId: 'invite1' });

		expect(clientInvitationCreate).toHaveBeenCalledWith({
			data: {
				organizationId: 'org1',
				clientOrganizationId: 'client_org1',
				email: 'client@example.com',
				role: 'admin',
				status: 'pending',
				invitedById: 'user1',
				expiresAt: new Date('2026-07-09T10:00:00.000Z')
			},
			select: { id: true }
		});
		expect(prismaTransaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: 'Serializable'
		});
	});

	it('coalesces duplicate pending non-expired invitations for the same normalized email', async () => {
		const now = new Date('2026-07-02T10:00:00.000Z');
		clientOrganizationFindFirst.mockResolvedValue({ id: 'client_org1' });
		clientInvitationFindFirst.mockResolvedValue({ id: 'invite_existing' });

		await expect(
			inviteClientMember({
				organizationId: 'org1',
				clientOrganizationId: 'client_org1',
				userId: 'user1',
				email: ' Client@Example.com ',
				role: 'member',
				now
			})
		).resolves.toEqual({ invitationId: 'invite_existing' });

		expect(clientInvitationFindFirst).toHaveBeenCalledWith({
			where: {
				organizationId: 'org1',
				clientOrganizationId: 'client_org1',
				email: 'client@example.com',
				status: 'pending',
				expiresAt: { gt: now }
			},
			select: { id: true }
		});
		expect(clientInvitationCreate).not.toHaveBeenCalled();
		expect(prismaTransaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: 'Serializable'
		});
	});

	it('retries serializable invite conflicts and then returns an existing pending invitation', async () => {
		const now = new Date('2026-07-02T10:00:00.000Z');
		clientOrganizationFindFirst.mockResolvedValue({ id: 'client_org1' });
		clientInvitationFindFirst
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ id: 'invite_existing' });
		clientInvitationCreate.mockRejectedValueOnce(
			Object.assign(new Error('write conflict'), { code: 'P2034' })
		);

		await expect(
			inviteClientMember({
				organizationId: 'org1',
				clientOrganizationId: 'client_org1',
				userId: 'user1',
				email: 'client@example.com',
				role: 'member',
				now
			})
		).resolves.toEqual({ invitationId: 'invite_existing' });

		expect(prismaTransaction).toHaveBeenCalledTimes(2);
		expect(prismaTransaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
			isolationLevel: 'Serializable'
		});
		expect(prismaTransaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
			isolationLevel: 'Serializable'
		});
		expect(clientInvitationFindFirst).toHaveBeenCalledTimes(2);
		expect(clientInvitationCreate).toHaveBeenCalledTimes(1);
	});

	it('rejects invitations when the client organization is outside the owner org', async () => {
		await expect(
			inviteClientMember({
				organizationId: 'org1',
				clientOrganizationId: 'client_org_other',
				userId: 'user1',
				email: 'client@example.com',
				role: 'member'
			})
		).rejects.toThrow(new ClientAccessError('Client organization not found'));

		expect(clientOrganizationFindFirst).toHaveBeenCalledWith({
			where: { id: 'client_org_other', organizationId: 'org1' },
			select: { id: true }
		});
		expect(clientInvitationCreate).not.toHaveBeenCalled();
		expect(clientInvitationFindFirst).not.toHaveBeenCalled();
	});

	it('accepts pending invitations atomically with conditional claim and membership upsert', async () => {
		const now = new Date('2026-07-02T10:00:00.000Z');
		clientInvitationFindUnique.mockResolvedValue({
			id: 'invite1',
			organizationId: 'org1',
			clientOrganizationId: 'client_org1',
			email: 'Client@Example.com',
			role: 'member',
			status: 'pending',
			expiresAt: new Date('2026-07-02T10:01:00.000Z')
		});

		await expect(
			acceptClientInvitation({
				invitationId: 'invite1',
				userId: 'user_client',
				email: 'client@example.com',
				now
			})
		).resolves.toEqual({ clientOrganizationId: 'client_org1' });

		expect(prismaTransaction).toHaveBeenCalledTimes(1);
		expect(clientInvitationFindUnique).toHaveBeenCalledWith({
			where: { id: 'invite1' }
		});
		expect(clientInvitationUpdateMany).toHaveBeenCalledWith({
			where: { id: 'invite1', status: 'pending' },
			data: { status: 'accepted', acceptedAt: now }
		});
		expect(clientOrganizationMemberUpsert).toHaveBeenCalledWith({
			where: {
				clientOrganizationId_userId: {
					clientOrganizationId: 'client_org1',
					userId: 'user_client'
				}
			},
			create: {
				organizationId: 'org1',
				clientOrganizationId: 'client_org1',
				userId: 'user_client',
				role: 'member'
			},
			update: { role: 'member' },
			select: { id: true }
		});
		expect(clientInvitationUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
			clientOrganizationMemberUpsert.mock.invocationCallOrder[0]
		);
		expect(clientOrganizationMemberCreate).not.toHaveBeenCalled();
	});

	it('rejects missing invitations as not found', async () => {
		clientInvitationFindUnique.mockResolvedValue(null);

		await expect(
			acceptClientInvitation({
				invitationId: 'invite_missing',
				userId: 'user_client',
				email: 'client@example.com'
			})
		).rejects.toThrow(new ClientAccessError('Invitation not found'));

		expect(clientOrganizationMemberCreate).not.toHaveBeenCalled();
		expect(clientOrganizationMemberUpsert).not.toHaveBeenCalled();
		expect(clientInvitationUpdate).not.toHaveBeenCalled();
		expect(clientInvitationUpdateMany).not.toHaveBeenCalled();
	});

	it('rejects non-pending invitations as not found', async () => {
		clientInvitationFindUnique.mockResolvedValue({
			id: 'invite1',
			organizationId: 'org1',
			clientOrganizationId: 'client_org1',
			email: 'client@example.com',
			role: 'member',
			status: 'canceled',
			expiresAt: new Date('2026-07-09T10:00:00.000Z')
		});

		await expect(
			acceptClientInvitation({
				invitationId: 'invite1',
				userId: 'user_client',
				email: 'client@example.com'
			})
		).rejects.toThrow(new ClientAccessError('Invitation not found'));

		expect(clientOrganizationMemberCreate).not.toHaveBeenCalled();
		expect(clientOrganizationMemberUpsert).not.toHaveBeenCalled();
		expect(clientInvitationUpdate).not.toHaveBeenCalled();
		expect(clientInvitationUpdateMany).not.toHaveBeenCalled();
	});

	it('rejects mismatched invitation emails case-insensitively', async () => {
		clientInvitationFindUnique.mockResolvedValue({
			id: 'invite1',
			organizationId: 'org1',
			clientOrganizationId: 'client_org1',
			email: 'Client@Example.com',
			role: 'member',
			status: 'pending',
			expiresAt: new Date('2026-07-09T10:00:00.000Z')
		});

		await expect(
			acceptClientInvitation({
				invitationId: 'invite1',
				userId: 'user_client',
				email: 'other@example.com'
			})
		).rejects.toThrow(new ClientAccessError('Invitation email does not match this account'));

		expect(clientOrganizationMemberCreate).not.toHaveBeenCalled();
		expect(clientOrganizationMemberUpsert).not.toHaveBeenCalled();
		expect(clientInvitationUpdate).not.toHaveBeenCalled();
		expect(clientInvitationUpdateMany).not.toHaveBeenCalled();
	});

	it('marks expired invitations as expired before rejecting them', async () => {
		const now = new Date('2026-07-09T10:00:00.000Z');
		clientInvitationFindUnique.mockResolvedValue({
			id: 'invite1',
			organizationId: 'org1',
			clientOrganizationId: 'client_org1',
			email: 'client@example.com',
			role: 'member',
			status: 'pending',
			expiresAt: now
		});

		await expect(
			acceptClientInvitation({
				invitationId: 'invite1',
				userId: 'user_client',
				email: 'client@example.com',
				now
			})
		).rejects.toThrow(new ClientAccessError('Invitation expired'));

		expect(prismaTransaction).toHaveBeenCalledTimes(1);
		expect(transactionOutcomes).toEqual(['resolved']);
		expect(clientInvitationUpdateMany).toHaveBeenCalledWith({
			where: { id: 'invite1', status: 'pending' },
			data: { status: 'expired' }
		});
		expect(clientOrganizationMemberCreate).not.toHaveBeenCalled();
		expect(clientOrganizationMemberUpsert).not.toHaveBeenCalled();
		expect(clientInvitationUpdate).not.toHaveBeenCalled();
	});

	it('returns idempotent success when an invitation is already accepted and membership exists', async () => {
		clientInvitationFindUnique.mockResolvedValue({
			id: 'invite1',
			organizationId: 'org1',
			clientOrganizationId: 'client_org1',
			email: 'client@example.com',
			role: 'member',
			status: 'accepted',
			expiresAt: new Date('2026-07-09T10:00:00.000Z')
		});
		clientOrganizationMemberFindFirst.mockResolvedValue({ id: 'client_member1' });

		await expect(
			acceptClientInvitation({
				invitationId: 'invite1',
				userId: 'user_client',
				email: 'client@example.com'
			})
		).resolves.toEqual({ clientOrganizationId: 'client_org1' });

		expect(clientOrganizationMemberFindFirst).toHaveBeenCalledWith({
			where: {
				clientOrganizationId: 'client_org1',
				userId: 'user_client',
				organizationId: 'org1'
			},
			select: { id: true }
		});
		expect(clientInvitationUpdateMany).not.toHaveBeenCalled();
		expect(clientOrganizationMemberUpsert).not.toHaveBeenCalled();
	});

	it('rejects accepted invitations without membership as not found', async () => {
		clientInvitationFindUnique.mockResolvedValue({
			id: 'invite1',
			organizationId: 'org1',
			clientOrganizationId: 'client_org1',
			email: 'client@example.com',
			role: 'member',
			status: 'accepted',
			expiresAt: new Date('2026-07-09T10:00:00.000Z')
		});
		clientOrganizationMemberFindFirst.mockResolvedValue(null);

		await expect(
			acceptClientInvitation({
				invitationId: 'invite1',
				userId: 'user_client',
				email: 'client@example.com'
			})
		).rejects.toThrow(new ClientAccessError('Invitation not found'));

		expect(clientInvitationUpdateMany).not.toHaveBeenCalled();
		expect(clientOrganizationMemberUpsert).not.toHaveBeenCalled();
	});

	it('returns idempotent success if the conditional claim loses a race after membership exists', async () => {
		const pendingInvitation = {
			id: 'invite1',
			organizationId: 'org1',
			clientOrganizationId: 'client_org1',
			email: 'client@example.com',
			role: 'member',
			status: 'pending',
			expiresAt: new Date('2026-07-09T10:00:00.000Z')
		};
		clientInvitationFindUnique
			.mockResolvedValueOnce(pendingInvitation)
			.mockResolvedValueOnce({ ...pendingInvitation, status: 'accepted' });
		clientInvitationUpdateMany.mockResolvedValue({ count: 0 });
		clientOrganizationMemberFindFirst.mockResolvedValue({ id: 'client_member1' });

		await expect(
			acceptClientInvitation({
				invitationId: 'invite1',
				userId: 'user_client',
				email: 'client@example.com'
			})
		).resolves.toEqual({ clientOrganizationId: 'client_org1' });

		expect(clientInvitationFindUnique).toHaveBeenCalledTimes(2);
		expect(clientOrganizationMemberUpsert).not.toHaveBeenCalled();
	});

	it('rejects unknown permissions on grant upsert', async () => {
		await expect(
			upsertProjectAccessGrant({
				organizationId: 'org1',
				userId: 'user1',
				projectId: 'project1',
				subjectType: 'client_member',
				subjectId: 'client_member1',
				permissions: ['project.view', 'project.destroy']
			})
		).rejects.toThrow('Unknown permission: project.destroy');

		expect(accessGrantUpsert).not.toHaveBeenCalled();
	});

	it('upserts known project grants', async () => {
		await expect(
			upsertProjectAccessGrant({
				organizationId: 'org1',
				userId: 'user1',
				projectId: 'project1',
				subjectType: 'client_member',
				subjectId: 'client_member1',
				permissions: ['project.view', 'run.view']
			})
		).resolves.toEqual({ id: 'grant1' });

		expect(accessGrantUpsert).toHaveBeenCalledWith({
			where: {
				organizationId_subjectType_subjectId_resourceType_resourceId: {
					organizationId: 'org1',
					subjectType: 'client_member',
					subjectId: 'client_member1',
					resourceType: 'project',
					resourceId: 'project1'
				}
			},
			create: {
				organizationId: 'org1',
				subjectType: 'client_member',
				subjectId: 'client_member1',
				resourceType: 'project',
				resourceId: 'project1',
				createdById: 'user1',
				permissions: ['project.view', 'run.view']
			},
			update: { permissions: ['project.view', 'run.view'] },
			select: { id: true }
		});
	});

	it('deletes grant by project and subject after verifying the project owner', async () => {
		await expect(
			removeProjectAccessGrant({
				organizationId: 'org1',
				projectId: 'project1',
				subjectType: 'client_organization',
				subjectId: 'client_org1'
			})
		).resolves.toEqual({ removed: true });

		expect(projectFindFirst).toHaveBeenCalledWith({
			where: { id: 'project1', organizationId: 'org1' },
			select: { id: true }
		});
		expect(accessGrantDeleteMany).toHaveBeenCalledWith({
			where: {
				organizationId: 'org1',
				resourceType: 'project',
				resourceId: 'project1',
				subjectType: 'client_organization',
				subjectId: 'client_org1'
			}
		});
	});

	it('rejects grant upsert when project is outside the owner org', async () => {
		projectFindFirst.mockResolvedValue(null);

		await expect(
			upsertProjectAccessGrant({
				organizationId: 'org1',
				userId: 'user1',
				projectId: 'project_other',
				subjectType: 'client_member',
				subjectId: 'client_member1',
				permissions: ['project.view']
			})
		).rejects.toThrow(new ClientAccessError('Project not found'));

		expect(clientOrganizationMemberFindFirst).not.toHaveBeenCalled();
		expect(accessGrantUpsert).not.toHaveBeenCalled();
	});

	it('rejects grant upsert when subject is outside the owner org or missing', async () => {
		clientOrganizationMemberFindFirst.mockResolvedValue(null);

		await expect(
			upsertProjectAccessGrant({
				organizationId: 'org1',
				userId: 'user1',
				projectId: 'project1',
				subjectType: 'client_member',
				subjectId: 'client_member_other',
				permissions: ['project.view']
			})
		).rejects.toThrow(new ClientAccessError('Access subject not found'));

		expect(accessGrantUpsert).not.toHaveBeenCalled();
	});

	it('rejects grant upsert when client organization subject is outside the owner org or missing', async () => {
		clientOrganizationFindFirst.mockResolvedValue(null);

		await expect(
			upsertProjectAccessGrant({
				organizationId: 'org1',
				userId: 'user1',
				projectId: 'project1',
				subjectType: 'client_organization',
				subjectId: 'client_org_other',
				permissions: ['project.view']
			})
		).rejects.toThrow(new ClientAccessError('Access subject not found'));

		expect(clientOrganizationFindFirst).toHaveBeenCalledWith({
			where: { id: 'client_org_other', organizationId: 'org1' },
			select: { id: true }
		});
		expect(clientOrganizationMemberFindFirst).not.toHaveBeenCalled();
		expect(accessGrantUpsert).not.toHaveBeenCalled();
	});

	it('returns copied permissions for presets', () => {
		const permissions = permissionsForPreset('project_access');

		permissions.push('run.view');

		expect(permissions).toEqual(['project.view', 'run.view']);
		expect(permissionPresets.project_access.permissions).toEqual(['project.view']);
	});

	it('lists project access grants after verifying the project owner', async () => {
		await expect(listProjectAccessGrants('org1', 'project1')).resolves.toEqual([{ id: 'grant1' }]);

		expect(projectFindFirst).toHaveBeenCalledWith({
			where: { id: 'project1', organizationId: 'org1' },
			select: { id: true }
		});
		expect(accessGrantFindMany).toHaveBeenCalledWith({
			where: { organizationId: 'org1', resourceType: 'project', resourceId: 'project1' },
			orderBy: { createdAt: 'desc' }
		});
	});
});
