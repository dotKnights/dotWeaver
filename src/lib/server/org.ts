import { error } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { auth } from '$lib/server/auth';

type SessionLike = { activeOrganizationId?: string | null } | null;

export function resolveActiveOrgId(session: SessionLike): string {
	const id = session?.activeOrganizationId;
	if (!id) throw new Error('No active team');
	return id;
}

/** Renvoie l'id de l'organisation active, ou 400 si aucune n'est sélectionnée. */
export async function requireActiveOrg(headers: Headers): Promise<string> {
	const { locals } = getRequestEvent();
	if (!locals.session) error(401, 'Not authenticated');
	const session = await auth.api.getSession({ headers });
	try {
		return resolveActiveOrgId(session?.session ?? null);
	} catch {
		error(400, 'No active team selected');
	}
}
