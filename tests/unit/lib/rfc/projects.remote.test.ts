import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	mockRefreshableRemoteCommand,
	mockRemoteQueryState,
	type RemoteQueryMock
} from './remote-test-helpers';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	requireHeaders: vi.fn(),
	requireActiveOrg: vi.fn(),
	requireActor: vi.fn(),
	getGithubToken: vi.fn(),
	listAllUserRepos: vi.fn(),
	listProjectsForOrg: vi.fn(),
	getProjectForOrg: vi.fn(),
	listProjectsForActor: vi.fn(),
	getProjectForActor: vi.fn(),
	listProjectPermissions: vi.fn(),
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
vi.mock('$lib/server/authz/actor', () => ({ requireActor: mocks.requireActor }));
vi.mock('$lib/server/integrations/github/service', () => ({
	getGithubToken: mocks.getGithubToken,
	listAllUserRepos: mocks.listAllUserRepos
}));
vi.mock('$lib/server/projects/service', () => ({
	listProjectsForOrg: mocks.listProjectsForOrg,
	getProjectForOrg: mocks.getProjectForOrg,
	listProjectsForActor: mocks.listProjectsForActor,
	getProjectForActor: mocks.getProjectForActor,
	importGithubProjectForOrg: mocks.importGithubProjectForOrg,
	GithubProjectImportError: mocks.GithubProjectImportError
}));
vi.mock('$lib/server/projects/branches', () => ({
	listBranchesForProject: mocks.listBranchesForProject
}));
vi.mock('$lib/server/authz/service', () => ({
	listProjectPermissions: mocks.listProjectPermissions
}));

import {
	listProjects,
	getProject,
	getProjectCapabilities,
	listProjectBranches,
	importProject
} from '$lib/rfc/projects.remote';

const listProjectsQuery = listProjects as unknown as RemoteQueryMock<
	() => Promise<unknown>,
	unknown
>;
const getProjectQuery = getProject as unknown as RemoteQueryMock<
	(id: string) => Promise<unknown>,
	unknown
>;
const getProjectCapabilitiesQuery = getProjectCapabilities as unknown as RemoteQueryMock<
	(id: string) => Promise<unknown>,
	unknown
>;
const listProjectBranchesQuery = listProjectBranches as unknown as RemoteQueryMock<
	(id: string) => Promise<unknown>,
	unknown
>;

describe('projects.remote commands', () => {
	const headers = new Headers({ cookie: 'session=abc' });
	const actor = { userId: 'user1', internalMemberships: [], clientMemberships: [] };

	beforeEach(() => {
		vi.resetAllMocks();
		mocks.requireHeaders.mockReturnValue(headers);
		mocks.requireActiveOrg.mockResolvedValue('org1');
		mocks.requireActor.mockResolvedValue(actor);
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'user1' } } });
		mocks.getGithubToken.mockResolvedValue('gh-token');
		mocks.listProjectPermissions.mockResolvedValue(['project.view', 'run.view']);
	});

	it('listProjects utilise la visibilité actor-aware sans organisation active', async () => {
		mocks.listProjectsForActor.mockResolvedValue([{ id: 'project1' }]);

		await expect(listProjectsQuery.serverHandler()).resolves.toEqual([{ id: 'project1' }]);

		expect(mocks.requireHeaders).toHaveBeenCalled();
		expect(mocks.requireActor).toHaveBeenCalled();
		expect(mocks.listProjectsForActor).toHaveBeenCalledWith(actor);
		expect(mocks.requireActiveOrg).not.toHaveBeenCalled();
	});

	it("getProject renvoie 404 quand l'acteur ne peut pas voir le projet", async () => {
		mocks.getProjectForActor.mockResolvedValue(null);

		await expect(getProjectQuery.serverHandler('project1')).rejects.toMatchObject({
			status: 404,
			message: 'Project not found'
		});

		expect(mocks.requireHeaders).toHaveBeenCalled();
		expect(mocks.requireActor).toHaveBeenCalled();
		expect(mocks.getProjectForActor).toHaveBeenCalledWith(actor, 'project1');
	});

	it("getProject renvoie le projet visible par l'acteur sans organisation active", async () => {
		const project = { id: 'project1', owner: 'acme', name: 'repo' };
		mocks.getProjectForActor.mockResolvedValue(project);

		await expect(getProjectQuery.serverHandler('project1')).resolves.toBe(project);

		expect(mocks.requireHeaders).toHaveBeenCalled();
		expect(mocks.requireActor).toHaveBeenCalled();
		expect(mocks.getProjectForActor).toHaveBeenCalledWith(actor, 'project1');
		expect(mocks.requireActiveOrg).not.toHaveBeenCalled();
	});

	it('getProjectCapabilities exposes an actor permission map without active organization', async () => {
		await expect(getProjectCapabilitiesQuery.serverHandler('project1')).resolves.toMatchObject({
			'project.view': true,
			'project.manage_access': false,
			'run.view': true,
			'run.create': false
		});

		expect(mocks.requireHeaders).toHaveBeenCalled();
		expect(mocks.requireActor).toHaveBeenCalled();
		expect(mocks.listProjectPermissions).toHaveBeenCalledWith(actor, 'project1');
		expect(mocks.requireActiveOrg).not.toHaveBeenCalled();
	});

	it('listProjectBranches charge le projet visible avant le token GitHub et les branches', async () => {
		const project = { id: 'project1', owner: 'acme', name: 'repo' };
		mocks.getProjectForActor.mockResolvedValue(project);
		mocks.listBranchesForProject.mockResolvedValue([{ name: 'main' }]);

		await expect(listProjectBranchesQuery.serverHandler('project1')).resolves.toEqual([
			{ name: 'main' }
		]);

		expect(mocks.getProjectForActor).toHaveBeenCalledWith(actor, 'project1');
		expect(mocks.getGithubToken).toHaveBeenCalledWith(headers);
		expect(mocks.listBranchesForProject).toHaveBeenCalledWith(project, 'gh-token');
		expect(mocks.getProjectForActor.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.getGithubToken.mock.invocationCallOrder[0]
		);
		expect(mocks.getProjectForActor.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.listBranchesForProject.mock.invocationCallOrder[0]
		);
	});

	it('listProjectBranches renvoie 404 quand le projet est absent ou non visible', async () => {
		mocks.getProjectForActor.mockResolvedValue(null);

		await expect(listProjectBranchesQuery.serverHandler('project1')).rejects.toMatchObject({
			status: 404,
			message: 'Project not found'
		});

		expect(mocks.requireHeaders).toHaveBeenCalled();
		expect(mocks.requireActor).toHaveBeenCalled();
		expect(mocks.getProjectForActor).toHaveBeenCalledWith(actor, 'project1');
		expect(mocks.requireActiveOrg).not.toHaveBeenCalled();
		expect(mocks.getGithubToken).not.toHaveBeenCalled();
		expect(mocks.listBranchesForProject).not.toHaveBeenCalled();
	});

	it('importProject maps GithubProjectImportError to 400', async () => {
		mocks.importGithubProjectForOrg.mockRejectedValue(
			new mocks.GithubProjectImportError('Connect your GitHub account to continue')
		);

		await expect(importProject({ owner: 'acme', name: 'repo' })).rejects.toMatchObject({
			status: 400,
			message: 'Connect your GitHub account to continue'
		});
		expect(mocks.requireActiveOrg).toHaveBeenCalledWith(headers);
		expect(mocks.importGithubProjectForOrg).toHaveBeenCalledWith({
			organizationId: 'org1',
			userId: 'user1',
			token: 'gh-token',
			owner: 'acme',
			name: 'repo'
		});
	});
});
