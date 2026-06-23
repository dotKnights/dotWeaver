import { error } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { prisma } from '$lib/server/prisma';

type SessionLike = { activeOrganizationId?: string | null } | null;

export function resolveActiveOrgId(session: SessionLike): string {
	const id = session?.activeOrganizationId;
	if (!id) throw new Error('No active team');
	return id;
}

export async function resolveEffectiveActiveOrg(
	headers: Headers
): Promise<{ userId: string; organizationId: string }> {
	const session = await auth.api.getSession({ headers });
	const userId = session?.user?.id;
	if (!userId) error(401, 'Authentication required');

	try {
		return { userId, organizationId: resolveActiveOrgId(session.session ?? null) };
	} catch {
		// Fall back to the persisted preference only after confirming live membership.
	}

	const user = await prisma.user.findUnique({
		where: { id: userId },
		select: {
			preferredOrganizationId: true,
			preferredOrganization: {
				select: {
					id: true,
					members: {
						where: { userId },
						select: { id: true },
						take: 1
					}
				}
			}
		}
	});

	if (
		user?.preferredOrganizationId &&
		user.preferredOrganization?.id === user.preferredOrganizationId &&
		user.preferredOrganization.members.length > 0
	) {
		return { userId, organizationId: user.preferredOrganizationId };
	}

	error(400, 'No active team selected');
}

/**
 * Renvoie l'id de l'organisation active, ou 400 si aucune n'est sélectionnée.
 * Re-vérifie l'appartenance en direct : le `activeOrganizationId` stocké sur la
 * session peut être périmé si l'utilisateur a été retiré de l'équipe depuis sa
 * sélection (cf. `removeMember`). On refuse alors l'accès (403) plutôt que de
 * laisser lire/écrire dans une org qu'il ne possède plus.
 */
export async function requireActiveOrg(headers: Headers): Promise<string> {
	const { userId, organizationId } = await resolveEffectiveActiveOrg(headers);

	const membership = await prisma.member.findFirst({
		where: { organizationId, userId },
		select: { id: true }
	});
	if (!membership) error(403, 'Not a member of the active team');

	return organizationId;
}
