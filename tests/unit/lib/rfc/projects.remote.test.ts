import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRefreshableRemoteCommand, mockRemoteQueryState } from './remote-test-helpers';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	requireHeaders: vi.fn(),
	requireActiveOrg: vi.fn(),
	getGithubToken: vi.fn(),
	listAllUserRepos: vi.fn(),
	listProjectsForOrg: vi.fn(),
	getProjectForOrg: vi.fn(),
	importGithubProjectForOrg: vi.fn(),
	listBranchesForProject: vi.fn(),
	GithubProjectImportError: class GithubProjectImportError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'GithubProjectImportError';
		}
	}
}));

vi.mock('$app/server', () => ({
	command: vi.fn((schemaOrHandler, maybeHandler) =>
		mockRefreshableRemoteCommand(maybeHandler ?? schemaOrHandler)
	),
	query: vi.fn((schemaOrHandler, maybeHandler) => {
		const handler = maybeHandler ?? schemaOrHandler;
		return mockRemoteQueryState(handler);
	}),
	getRequestEvent: mocks.getRequestEvent
}));

vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));

vi.mock('$lib/server/auth/request', () => ({ requireHeaders: mocks.requireHeaders }));
vi.mock('$lib/server/auth/org', () => ({ requireActiveOrg: mocks.requireActiveOrg }));
vi.mock('$lib/server/integrations/github/service', () => ({
	getGithubToken: mocks.getGithubToken,
	listAllUserRepos: mocks.listAllUserRepos
}));
vi.mock('$lib/server/projects/service', () => ({
	listProjectsForOrg: mocks.listProjectsForOrg,
	getProjectForOrg: mocks.getProjectForOrg,
	importGithubProjectForOrg: mocks.importGithubProjectForOrg,
	GithubProjectImportError: mocks.GithubProjectImportError
}));
vi.mock('$lib/server/projects/branches', () => ({
	listBranchesForProject: mocks.listBranchesForProject
}));

import { importProject } from '$lib/rfc/projects.remote';

describe('projects.remote commands', () => {
	const headers = new Headers({ cookie: 'session=abc' });

	beforeEach(() => {
		vi.resetAllMocks();
		mocks.requireHeaders.mockReturnValue(headers);
		mocks.requireActiveOrg.mockResolvedValue('org1');
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'user1' } } });
		mocks.getGithubToken.mockResolvedValue('gh-token');
	});

	it('importProject maps GithubProjectImportError to 400', async () => {
		mocks.importGithubProjectForOrg.mockRejectedValue(
			new mocks.GithubProjectImportError('Connect your GitHub account to continue')
		);

		await expect(importProject({ owner: 'acme', name: 'repo' })).rejects.toMatchObject({
			status: 400,
			message: 'Connect your GitHub account to continue'
		});
	});
});
