import { prisma } from '$lib/server/prisma';

export interface AccountInfo {
	providerId: string;
	scopes: string[];
}

export interface ProviderStatus {
	connected: boolean;
	canDisconnect: boolean;
}

export interface GoogleStatus extends ProviderStatus {
	hasGmailScope: boolean;
	needsReconnect: boolean;
}

export interface ConnectorStatus {
	github: ProviderStatus;
	google: GoogleStatus;
	hasPassword: boolean;
}

/** Une déconnexion n'est permise que s'il reste >= 1 méthode de login après retrait. */
function canDisconnect(connected: boolean, loginCount: number): boolean {
	return connected && loginCount > 1;
}

export function computeConnectorStatus(accounts: AccountInfo[], gmailScope: string): ConnectorStatus {
	const loginCount = accounts.length;
	const github = accounts.find((a) => a.providerId === 'github');
	const google = accounts.find((a) => a.providerId === 'google');
	const hasGmailScope = Boolean(google?.scopes.includes(gmailScope));

	return {
		github: {
			connected: Boolean(github),
			canDisconnect: canDisconnect(Boolean(github), loginCount)
		},
		google: {
			connected: Boolean(google),
			hasGmailScope,
			needsReconnect: Boolean(google) && !hasGmailScope,
			canDisconnect: canDisconnect(Boolean(google), loginCount)
		},
		hasPassword: accounts.some((a) => a.providerId === 'credential')
	};
}

export function buildGithubOrgAccessUrl(clientId: string): string {
	return `https://github.com/settings/connections/applications/${clientId}`;
}

/** Supprime toutes les données Gmail synchronisées d'un utilisateur (threads + état de sync). */
export async function purgeGmailData(userId: string): Promise<void> {
	await prisma.$transaction([
		prisma.mailThread.deleteMany({ where: { userId } }),
		prisma.mailSyncState.deleteMany({ where: { userId } })
	]);
}
