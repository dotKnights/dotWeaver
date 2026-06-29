import { beforeEach, describe, it, expect, vi } from 'vitest';

const { getAccessToken } = vi.hoisted(() => ({ getAccessToken: vi.fn() }));

vi.mock('$lib/server/auth', () => ({ auth: { api: { getAccessToken } } }));

import { authedCloneUrl, getGithubTokenForUser } from '$lib/server/integrations/github/git-auth';

beforeEach(() => {
	getAccessToken.mockReset();
});

describe('authedCloneUrl', () => {
	it('injects the x-access-token username into an https clone url', () => {
		expect(authedCloneUrl('https://github.com/o/r.git')).toBe(
			'https://x-access-token@github.com/o/r.git'
		);
	});
	it('leaves non-https urls unchanged', () => {
		expect(authedCloneUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
	});
});

describe('getGithubTokenForUser', () => {
	it('returns null when Better Auth throws', async () => {
		getAccessToken.mockRejectedValueOnce(new Error('Account not found'));

		await expect(getGithubTokenForUser('user_1')).resolves.toBeNull();
		expect(getAccessToken).toHaveBeenCalledWith({
			body: { providerId: 'github', userId: 'user_1' }
		});
	});

	it('returns null when no access token is present', async () => {
		getAccessToken.mockResolvedValueOnce({});

		await expect(getGithubTokenForUser('user_1')).resolves.toBeNull();
		expect(getAccessToken).toHaveBeenCalledWith({
			body: { providerId: 'github', userId: 'user_1' }
		});
	});

	it('returns the access token when available', async () => {
		getAccessToken.mockResolvedValueOnce({ accessToken: 'gho_xxx' });

		await expect(getGithubTokenForUser('user_1')).resolves.toBe('gho_xxx');
		expect(getAccessToken).toHaveBeenCalledWith({
			body: { providerId: 'github', userId: 'user_1' }
		});
	});
});
