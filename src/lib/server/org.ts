import { error } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { auth } from '$lib/server/auth';
import { prisma } from '$lib/server/prisma';

type SessionLike = { activeOrganizationId?: string | null } | null;

export function resolveActiveOrgId(session: SessionLike): string {
	const id = session?.activeOrganizationId;
	if (!id) throw new Error('No active team');
	return id;
}

/**
 * Renvoie l'id de l'organisation active, ou 400 si aucune n'est sélectionnée.
 * Re-vérifie l'appartenance en direct : le `activeOrganizationId` stocké sur la
 * session peut être périmé si l'utilisateur a été retiré de l'équipe depuis sa
 * sélection (cf. `removeMember`). On refuse alors l'accès (403) plutôt que de
 * laisser lire/écrire dans une org qu'il ne possède plus.
 */
export async function requireActiveOrg(headers: Headers): Promise<string> {
	const { locals } = getRequestEvent();
	if (!locals.session || !locals.user) error(401, 'Not authenticated');
	const session = await auth.api.getSession({ headers });

	let organizationId: string;
	try {
		organizationId = resolveActiveOrgId(session?.session ?? null);
	} catch {
		error(400, 'No active team selected');
	}

	const membership = await prisma.member.findFirst({
		where: { organizationId, userId: locals.user.id },
		select: { id: true }
	});
	if (!membership) error(403, 'Not a member of the active team');

	return organizationId;
}
