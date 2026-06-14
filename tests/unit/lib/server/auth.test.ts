import { describe, expect, it, vi } from 'vitest';

const { betterAuth } = vi.hoisted(() => ({ betterAuth: vi.fn() }));

vi.mock('$env/dynamic/private', () => ({
	env: {
		BETTER_AUTH_URL: 'http://localhost:5173',
		BETTER_AUTH_SECRET: 'test-secret-with-more-than-32-characters',
		DATABASE_URL: 'postgres://user:password@localhost:5432/dotweaver_test',
		GITHUB_CLIENT_ID: 'github-client',
		GITHUB_CLIENT_SECRET: 'github-secret',
		GOOGLE_CLIENT_ID: 'google-client',
		GOOGLE_CLIENT_SECRET: 'google-secret',
		NODE_ENV: 'test'
	}
}));

vi.mock('better-auth', () => ({
	betterAuth
}));

vi.mock('better-auth/adapters/prisma', () => ({
	prismaAdapter: vi.fn(() => 'prisma-adapter')
}));

vi.mock('better-auth/plugins', () => ({
	organization: vi.fn(() => 'organization-plugin'),
	mcp: vi.fn(() => 'mcp-plugin')
}));

describe('auth config', () => {
	it('allows linking a Google mailbox with a different email than the signed-in account', async () => {
		await import('$lib/server/auth');

		expect(betterAuth).toHaveBeenCalledWith(
			expect.objectContaining({
				account: expect.objectContaining({
					accountLinking: expect.objectContaining({
						allowDifferentEmails: true
					})
				})
			})
		);
	});
});
