import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockAppServerWithTrackedRefresh } from './remote-test-helpers';

const mocks = vi.hoisted(() => {
	class ProjectEnvironmentError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'ProjectEnvironmentError';
		}
	}
	return {
		getRequestEvent: vi.fn(),
		requireHeaders: vi.fn(),
		requireActiveOrg: vi.fn(),
		requireActor: vi.fn(),
		requireProjectPermission: vi.fn(),
		getGithubToken: vi.fn(),
		refresh: vi.fn(),
		queryRefreshes: [] as unknown[],
		getDefaultProjectEnvironmentForOrg: vi.fn(),
		detectProjectEnvironmentForOrg: vi.fn(),
		upsertProjectEnvironmentProfileForOrg: vi.fn(),
		requireProjectEnvironmentProfileForOrg: vi.fn(),
		listProjectEnvironmentPrepareEventsForOrg: vi.fn(),
		enqueueProjectEnvironmentPrepare: vi.fn(),
		ProjectEnvironmentError
	};
});

vi.mock('$app/server', () =>
	mockAppServerWithTrackedRefresh({
		getRequestEvent: mocks.getRequestEvent,
		queryRefreshes: mocks.queryRefreshes,
		refresh: mocks.refresh
	})
);

vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));

vi.mock('$lib/server/auth/request', () => ({ requireHeaders: mocks.requireHeaders }));
vi.mock('$lib/server/auth/org', () => ({ requireActiveOrg: mocks.requireActiveOrg }));
vi.mock('$lib/server/authz/actor', () => ({ requireActor: mocks.requireActor }));
vi.mock('$lib/server/authz/service', () => ({
	requireProjectPermission: mocks.requireProjectPermission
}));
vi.mock('$lib/server/integrations/github/service', () => ({
	getGithubToken: mocks.getGithubToken
}));
vi.mock('$lib/server/runtime/queue', () => ({
	enqueueProjectEnvironmentPrepare: mocks.enqueueProjectEnvironmentPrepare
}));
vi.mock('$lib/server/project-environments/service', () => ({
	getDefaultProjectEnvironmentForOrg: mocks.getDefaultProjectEnvironmentForOrg,
	detectProjectEnvironmentForOrg: mocks.detectProjectEnvironmentForOrg,
	upsertProjectEnvironmentProfileForOrg: mocks.upsertProjectEnvironmentProfileForOrg,
	requireProjectEnvironmentProfileForOrg: mocks.requireProjectEnvironmentProfileForOrg,
	listProjectEnvironmentPrepareEventsForOrg: mocks.listProjectEnvironmentPrepareEventsForOrg,
	ProjectEnvironmentError: mocks.ProjectEnvironmentError
}));

import {
	detectProjectEnvironment,
	getProjectEnvironment,
	prepareProjectEnvironment,
	saveProjectEnvironment
} from '$lib/rfc/project-environments.remote';

const getProjectEnvironmentMock = getProjectEnvironment as typeof getProjectEnvironment & {
	serverHandler: (projectId: string) => Promise<unknown>;
};

describe('project-environments.remote', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.requireHeaders.mockReturnValue(new Headers());
		mocks.requireActiveOrg.mockResolvedValue('org1');
		mocks.requireActor.mockResolvedValue({ userId: 'u1' });
		mocks.requireProjectPermission.mockResolvedValue({ id: 'p1', organizationId: 'org1' });
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'u1' } } });
		mocks.getGithubToken.mockResolvedValue('gh-token');
		mocks.queryRefreshes.length = 0;
		mocks.refresh.mockResolvedValue(undefined);
		mocks.getDefaultProjectEnvironmentForOrg.mockResolvedValue({ id: 'env1' });
		mocks.detectProjectEnvironmentForOrg.mockResolvedValue({ id: 'env1' });
		mocks.upsertProjectEnvironmentProfileForOrg.mockResolvedValue({ id: 'env1' });
		mocks.requireProjectEnvironmentProfileForOrg.mockResolvedValue({ id: 'env1' });
	});

	it('gets the default project environment for the active org', async () => {
		await expect(getProjectEnvironmentMock.serverHandler('p1')).resolves.toEqual({ id: 'env1' });
		expect(mocks.requireProjectPermission).toHaveBeenCalledWith(
			{ userId: 'u1' },
			'project.config.view',
			'p1'
		);
		expect(mocks.getDefaultProjectEnvironmentForOrg).toHaveBeenCalledWith('org1', 'p1');
	});

	it('blocks environment reads without project.config.view', async () => {
		mocks.requireProjectPermission.mockRejectedValueOnce(
			Object.assign(new Error('Forbidden'), { status: 403 })
		);

		await expect(getProjectEnvironmentMock.serverHandler('p1')).rejects.toMatchObject({
			status: 403,
			message: 'Forbidden'
		});
		expect(mocks.getDefaultProjectEnvironmentForOrg).not.toHaveBeenCalled();
	});

	it('maps missing projects to a 404 response', async () => {
		mocks.getDefaultProjectEnvironmentForOrg.mockRejectedValueOnce(
			new mocks.ProjectEnvironmentError('Project not found')
		);

		await expect(getProjectEnvironmentMock.serverHandler('p1')).rejects.toMatchObject({
			status: 404,
			message: 'Project not found'
		});
	});

	it('maps other project environment errors to a 400 response', async () => {
		mocks.getDefaultProjectEnvironmentForOrg.mockRejectedValueOnce(
			new mocks.ProjectEnvironmentError('Unsupported project runtime')
		);

		await expect(getProjectEnvironmentMock.serverHandler('p1')).rejects.toMatchObject({
			status: 400,
			message: 'Unsupported project runtime'
		});
	});

	it('detects and refreshes project environment', async () => {
		await detectProjectEnvironment({ projectId: 'p1' });
		expect(mocks.detectProjectEnvironmentForOrg).toHaveBeenCalledWith({
			organizationId: 'org1',
			userId: 'u1',
			projectId: 'p1',
			githubToken: 'gh-token'
		});
		expect(mocks.refresh).toHaveBeenCalled();
	});

	it('saves and refreshes project environment', async () => {
		await saveProjectEnvironment({
			projectId: 'p1',
			runtime: 'node',
			adapterId: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			testCommand: '',
			buildCommand: '',
			devCommand: ''
		});
		expect(mocks.requireProjectPermission).toHaveBeenCalledWith(
			{ userId: 'u1' },
			'project.config.manage',
			'p1'
		);
		expect(mocks.upsertProjectEnvironmentProfileForOrg).toHaveBeenCalled();
		expect(mocks.refresh).toHaveBeenCalled();
	});

	it('blocks environment saves without project.config.manage', async () => {
		mocks.requireProjectPermission.mockRejectedValueOnce(
			Object.assign(new Error('Forbidden'), { status: 403 })
		);

		await expect(
			saveProjectEnvironment({
				projectId: 'p1',
				runtime: 'node',
				adapterId: 'node',
				packageManager: 'bun',
				installCommand: 'bun install',
				testCommand: '',
				buildCommand: '',
				devCommand: ''
			})
		).rejects.toMatchObject({
			status: 403,
			message: 'Forbidden'
		});
		expect(mocks.upsertProjectEnvironmentProfileForOrg).not.toHaveBeenCalled();
	});

	it('enqueues standalone prepare', async () => {
		await prepareProjectEnvironment({ projectId: 'p1', profileId: 'env1', force: true });
		expect(mocks.requireProjectEnvironmentProfileForOrg).toHaveBeenCalledWith('org1', 'p1', 'env1');
		expect(mocks.enqueueProjectEnvironmentPrepare).toHaveBeenCalledWith({
			profileId: 'env1',
			requestedById: 'u1',
			force: true
		});
		expect(mocks.requireProjectEnvironmentProfileForOrg.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.enqueueProjectEnvironmentPrepare.mock.invocationCallOrder[0]
		);
		expect(mocks.queryRefreshes).toEqual(['p1', { projectId: 'p1', profileId: 'env1' }]);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
	});

	it('does not enqueue prepare when the environment profile is outside scope', async () => {
		mocks.requireProjectEnvironmentProfileForOrg.mockRejectedValueOnce(
			new mocks.ProjectEnvironmentError('Project environment profile not found')
		);

		await expect(
			prepareProjectEnvironment({ projectId: 'p1', profileId: 'env1', force: true })
		).rejects.toMatchObject({
			status: 400,
			message: 'Project environment profile not found'
		});

		expect(mocks.enqueueProjectEnvironmentPrepare).not.toHaveBeenCalled();
		expect(mocks.queryRefreshes).toEqual([]);
	});
});
