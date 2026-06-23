import { error } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { auth } from '$lib/server/auth';
import { prisma } from '$lib/server/prisma';

type SessionLike = { activeOrganizationId?: string | null } | null;
type Membership = { id: string } | null;

export function resolveActiveOrgId(session: SessionLike): string {
	const id = session?.activeOrganizationId;
	if (!id) throw new Error('No active team');
	return id;
}

function getActiveOrganizationId(session: SessionLike): string | null {
	return session?.activeOrganizationId ?? null;
}

async function findMembership(userId: string, organizationId: string): Promise<Membership> {
	return prisma.member.findFirst({
		where: { organizationId, userId },
		select: { id: true }
	});
}

async function persistPreferredOrganization(userId: string, organizationId: string | null) {
	await prisma.user.update({
		where: { id: userId },
		data: { preferredOrganizationId: organizationId },
		select: { id: true }
	});
}

async function syncActiveOrganization(headers: Headers, organizationId: string) {
	try {
		await auth.api.setActiveOrganization({ body: { organizationId }, headers });
	} catch {
		// Best-effort cookie/session sync; Prisma preference remains durable.
	}
}

export async function resolveEffectiveActiveOrg(headers: Headers): Promise<string | null> {
	const { locals } = getRequestEvent();
	if (!locals.session || !locals.user) error(401, 'Not authenticated');

	const session = await auth.api.getSession({ headers });
	const userId = locals.user.id;
	const activeOrganizationId =
		getActiveOrganizationId(session?.session ?? null) ??
		getActiveOrganizationId(locals.session as SessionLike);

	if (activeOrganizationId && (await findMembership(userId, activeOrganizationId))) {
		await persistPreferredOrganization(userId, activeOrganizationId);
		return activeOrganizationId;
	}

	const user = await prisma.user.findUnique({
		where: { id: userId },
		select: {
			preferredOrganizationId: true,
			preferredOrganization: {
				select: {
					id: true
				}
			}
		}
	});

	const persistedPreferredOrganizationId = user?.preferredOrganizationId ?? null;
	const preferredOrganizationId =
		user?.preferredOrganization?.id === persistedPreferredOrganizationId
			? persistedPreferredOrganizationId
			: null;

	if (preferredOrganizationId && (await findMembership(userId, preferredOrganizationId))) {
		await syncActiveOrganization(headers, preferredOrganizationId);
		return preferredOrganizationId;
	}

	if (persistedPreferredOrganizationId) {
		await persistPreferredOrganization(userId, null);
	}

	const firstMembership = await prisma.member.findFirst({
		where: { userId },
		orderBy: { createdAt: 'asc' },
		select: { organizationId: true }
	});
	if (!firstMembership) return null;

	await persistPreferredOrganization(userId, firstMembership.organizationId);
	await syncActiveOrganization(headers, firstMembership.organizationId);
	return firstMembership.organizationId;
}

/**
 * Renvoie une organisation accessible, ou 400 si l'utilisateur n'a aucune équipe.
 * La résolution valide l'appartenance avant de retourner l'id, puis répare les
 * préférences persistées et la session Better Auth lorsque c'est possible.
 */
export async function requireActiveOrg(headers: Headers): Promise<string> {
	const organizationId = await resolveEffectiveActiveOrg(headers);
	if (!organizationId) error(400, 'No active team selected');

	return organizationId;
}
