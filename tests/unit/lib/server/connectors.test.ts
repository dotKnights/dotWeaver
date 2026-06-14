import { describe, it, expect, vi } from 'vitest';
import { computeConnectorStatus, buildGithubOrgAccessUrl } from '$lib/server/connectors';
import { GMAIL_READONLY_SCOPE } from '$lib/constants/mail';

vi.mock('$lib/server/prisma', () => {
	const mailThread = { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) };
	const mailSyncState = { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) };
	return {
		prisma: {
			mailThread,
			mailSyncState,
			$transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops))
		}
	};
});

describe('computeConnectorStatus', () => {
	it('reports both providers connected with gmail scope', () => {
		const status = computeConnectorStatus(
			[
				{ providerId: 'github', scopes: ['repo'] },
				{ providerId: 'google', scopes: ['openid', GMAIL_READONLY_SCOPE] }
			],
			GMAIL_READONLY_SCOPE
		);
		expect(status.github.connected).toBe(true);
		expect(status.google.connected).toBe(true);
		expect(status.google.hasGmailScope).toBe(true);
		expect(status.google.needsReconnect).toBe(false);
	});

	it('flags google needsReconnect when gmail scope is missing', () => {
		const status = computeConnectorStatus(
			[{ providerId: 'google', scopes: ['openid', 'email'] }],
			GMAIL_READONLY_SCOPE
		);
		expect(status.google.connected).toBe(true);
		expect(status.google.hasGmailScope).toBe(false);
		expect(status.google.needsReconnect).toBe(true);
	});

	it('blocks disconnect when a provider is the only login method', () => {
		const status = computeConnectorStatus(
			[{ providerId: 'github', scopes: ['repo'] }],
			GMAIL_READONLY_SCOPE
		);
		expect(status.github.connected).toBe(true);
		expect(status.github.canDisconnect).toBe(false);
		expect(status.hasPassword).toBe(false);
	});

	it('allows disconnect when a password login also exists', () => {
		const status = computeConnectorStatus(
			[
				{ providerId: 'credential', scopes: [] },
				{ providerId: 'github', scopes: ['repo'] }
			],
			GMAIL_READONLY_SCOPE
		);
		expect(status.hasPassword).toBe(true);
		expect(status.github.canDisconnect).toBe(true);
	});

	it('allows disconnect when another social login also exists', () => {
		const status = computeConnectorStatus(
			[
				{ providerId: 'github', scopes: ['repo'] },
				{ providerId: 'google', scopes: [GMAIL_READONLY_SCOPE] }
			],
			GMAIL_READONLY_SCOPE
		);
		expect(status.github.canDisconnect).toBe(true);
		expect(status.google.canDisconnect).toBe(true);
	});

	it('marks disconnected providers as not connected and not disconnectable', () => {
		const status = computeConnectorStatus(
			[{ providerId: 'credential', scopes: [] }],
			GMAIL_READONLY_SCOPE
		);
		expect(status.github.connected).toBe(false);
		expect(status.github.canDisconnect).toBe(false);
		expect(status.google.connected).toBe(false);
	});
});

describe('buildGithubOrgAccessUrl', () => {
	it('builds the OAuth app connections URL from the client id', () => {
		expect(buildGithubOrgAccessUrl('abc123')).toBe(
			'https://github.com/settings/connections/applications/abc123'
		);
	});
});

describe('purgeGmailData', () => {
	it('deletes mail threads and sync state scoped to the user', async () => {
		const { purgeGmailData } = await import('$lib/server/connectors');
		const { prisma } = await import('$lib/server/prisma');
		await purgeGmailData('user_1');
		expect(prisma.mailThread.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user_1' } });
		expect(prisma.mailSyncState.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user_1' } });
	});
});
