import { describe, it, expect, vi } from 'vitest';

// Mock better-auth so getGithubToken's behaviour can be exercised without a real session.
// `vi.hoisted` so the mock factory (hoisted to top of file) can reference the spy.
const { getAccessToken } = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock('$lib/server/auth', () => ({ auth: { api: { getAccessToken } } }));

import { mapRepoListItem, mapRepoToProjectInput, getGithubToken, type GithubRepo } from '$lib/server/github';

const repo: GithubRepo = {
	id: 12345,
	name: 'my-repo',
	full_name: 'octocat/my-repo',
	private: true,
	default_branch: 'main',
	clone_url: 'https://github.com/octocat/my-repo.git',
	owner: { login: 'octocat' }
};

describe('mapRepoListItem', () => {
	it('projects a GitHub repo into a list item', () => {
		expect(mapRepoListItem(repo)).toEqual({
			githubRepoId: '12345',
			owner: 'octocat',
			name: 'my-repo',
			fullName: 'octocat/my-repo',
			private: true,
			defaultBranch: 'main'
		});
	});
});

describe('mapRepoToProjectInput', () => {
	it('builds a Prisma create input scoped to org + importer', () => {
		expect(mapRepoToProjectInput(repo, 'org_1', 'user_1')).toEqual({
			organizationId: 'org_1',
			githubRepoId: '12345',
			owner: 'octocat',
			name: 'my-repo',
			defaultBranch: 'main',
			cloneUrl: 'https://github.com/octocat/my-repo.git',
			private: true,
			importedById: 'user_1'
		});
	});
});

describe('getGithubToken', () => {
	// Regression (DOT-16): a user without a linked GitHub account makes better-auth throw
	// APIError "Account not found". getGithubToken MUST swallow it and return null — an
	// uncaught throw here produced an unhandled rejection that crashed the dev server.
	it('returns null when getAccessToken throws (no GitHub account linked)', async () => {
		getAccessToken.mockRejectedValueOnce(
			Object.assign(new Error('Account not found'), { status: 'BAD_REQUEST' })
		);
		expect(await getGithubToken(new Headers())).toBeNull();
	});

	it('returns null when no access token is present', async () => {
		getAccessToken.mockResolvedValueOnce({});
		expect(await getGithubToken(new Headers())).toBeNull();
	});

	it('returns the access token when available', async () => {
		getAccessToken.mockResolvedValueOnce({ accessToken: 'gho_xxx' });
		expect(await getGithubToken(new Headers())).toBe('gho_xxx');
	});
});
