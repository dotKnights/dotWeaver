import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { auth } from '$lib/server/auth';
import { requireHeaders } from '$lib/server/utils';
import { GMAIL_READONLY_SCOPE } from '$lib/constants/mail';
import {
	buildGithubOrgAccessUrl,
	computeConnectorStatus,
	purgeGmailData,
	type AccountInfo
} from '$lib/server/auth/connectors';

function normalizeScopes(scopes: unknown): string[] {
	if (Array.isArray(scopes)) return scopes as string[];
	if (typeof scopes === 'string') return scopes.split(/[ ,]+/).filter(Boolean);
	return [];
}

export const listConnectors = query(async () => {
	const headers = requireHeaders();
	const accounts = await auth.api.listUserAccounts({ headers });
	const normalized: AccountInfo[] = accounts.map((a) => ({
		providerId: a.providerId,
		scopes: normalizeScopes((a as { scopes?: unknown }).scopes)
	}));
	const status = computeConnectorStatus(normalized, GMAIL_READONLY_SCOPE);
	return {
		...status,
		githubOrgAccessUrl: buildGithubOrgAccessUrl(env.GITHUB_CLIENT_ID ?? '')
	};
});

export const disconnectGithub = command(async () => {
	const headers = requireHeaders();
	const accounts = await auth.api.listUserAccounts({ headers });
	if (accounts.length <= 1)
		error(400, 'Impossible de déconnecter votre seule méthode de connexion.');
	await auth.api.unlinkAccount({ body: { providerId: 'github' }, headers });
	await listConnectors().refresh();
	return { ok: true as const };
});

export const disconnectGoogle = command(async () => {
	const headers = requireHeaders();
	const session = await auth.api.getSession({ headers });
	if (!session?.user) error(401, 'Not authenticated');
	const accounts = await auth.api.listUserAccounts({ headers });
	if (accounts.length <= 1)
		error(400, 'Impossible de déconnecter votre seule méthode de connexion.');
	// Purge avant unlink (choix délibéré). En cas d'échec partiel :
	// - purge OK puis unlink KO → mails effacés mais compte encore lié : récupérable via re-sync.
	// - unlink d'abord puis purge KO → données mail orphelines, plus difficile à nettoyer.
	// On préfère la première (données reconstructibles) à la seconde (orphelines).
	await purgeGmailData(session.user.id);
	await auth.api.unlinkAccount({ body: { providerId: 'google' }, headers });
	await listConnectors().refresh();
	return { ok: true as const };
});
