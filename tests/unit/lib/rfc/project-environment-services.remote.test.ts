import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockAppServerWithTrackedRefresh } from './remote-test-helpers';

const mocks = vi.hoisted(() => {
	class ProjectEnvironmentServiceError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'ProjectEnvironmentServiceError';
		}
	}
	return {
		getRequestEvent: vi.fn(),
		requireHeaders: vi.fn(),
		requireActiveOrg: vi.fn(),
		refresh: vi.fn(),
		queryRefreshes: [] as unknown[],
		getProjectEnvironment: vi.fn((projectId: string) => ({
			refresh: vi.fn(async () => {
				mocks.queryRefreshes.push(projectId);
				await mocks.refresh(projectId);
			})
		})),
		enqueueProjectEnvironmentServiceProvision: vi.fn(),
		listProjectEnvironmentServicesForOrg: vi.fn(),
		createProjectEnvironmentServiceForOrg: vi.fn(),
		setProjectEnvironmentServiceEnabledForOrg: vi.fn(),
		updateProjectEnvironmentServiceEnvMappingsForOrg: vi.fn(),
		ProjectEnvironmentServiceError
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
vi.mock('$lib/server/runtime/queue', () => ({
	enqueueProjectEnvironmentServiceProvision: mocks.enqueueProjectEnvironmentServiceProvision
}));
vi.mock('$lib/server/project-environment-services/service', () => ({
	listProjectEnvironmentServicesForOrg: mocks.listProjectEnvironmentServicesForOrg,
	createProjectEnvironmentServiceForOrg: mocks.createProjectEnvironmentServiceForOrg,
	setProjectEnvironmentServiceEnabledForOrg: mocks.setProjectEnvironmentServiceEnabledForOrg,
	updateProjectEnvironmentServiceEnvMappingsForOrg:
		mocks.updateProjectEnvironmentServiceEnvMappingsForOrg,
	ProjectEnvironmentServiceError: mocks.ProjectEnvironmentServiceError
}));
vi.mock('$lib/rfc/project-environments.remote', () => ({
	getProjectEnvironment: mocks.getProjectEnvironment
}));

import {
	createProjectEnvironmentService,
	getProjectEnvironmentServices,
	provisionProjectEnvironmentService,
	setProjectEnvironmentServiceEnabled,
	updateProjectEnvironmentServiceEnvMappings
} from '$lib/rfc/project-environment-services.remote';

const getProjectEnvironmentServicesMock =
	getProjectEnvironmentServices as typeof getProjectEnvironmentServices & {
		serverHandler: (input: { projectId: string; profileId: string }) => Promise<unknown>;
	};

const service = {
	id: 'svc1',
	projectId: 'p1',
	profileId: 'profile1',
	kind: 'postgres',
	name: 'postgres',
	enabled: true,
	status: 'configured'
};

describe('project-environment-services.remote', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.requireHeaders.mockReturnValue(new Headers());
		mocks.requireActiveOrg.mockResolvedValue('org1');
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'u1' } } });
		mocks.refresh.mockResolvedValue(undefined);
		mocks.queryRefreshes.length = 0;
		mocks.listProjectEnvironmentServicesForOrg.mockResolvedValue([service]);
		mocks.createProjectEnvironmentServiceForOrg.mockResolvedValue(service);
		mocks.setProjectEnvironmentServiceEnabledForOrg.mockResolvedValue(undefined);
		mocks.updateProjectEnvironmentServiceEnvMappingsForOrg.mockResolvedValue({ updated: true });
		mocks.enqueueProjectEnvironmentServiceProvision.mockResolvedValue(undefined);
	});

	it('lists services for the active org', async () => {
		await expect(
			getProjectEnvironmentServicesMock.serverHandler({
				projectId: 'p1',
				profileId: 'profile1'
			})
		).resolves.toEqual([service]);
		expect(mocks.listProjectEnvironmentServicesForOrg).toHaveBeenCalledWith(
			'org1',
			'p1',
			'profile1'
		);
	});

	it('creates a service, enqueues provisioning, refreshes queries, and returns the service', async () => {
		const input = { projectId: 'p1', profileId: 'profile1', kind: 'postgres' as const };

		await expect(createProjectEnvironmentService(input)).resolves.toEqual(service);

		expect(mocks.createProjectEnvironmentServiceForOrg).toHaveBeenCalledWith('org1', 'u1', input);
		expect(mocks.enqueueProjectEnvironmentServiceProvision).toHaveBeenCalledWith({
			serviceId: 'svc1'
		});
		expect(mocks.queryRefreshes).toEqual([{ projectId: 'p1', profileId: 'profile1' }, 'p1']);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
	});

	it('maps create service errors to a 400 response', async () => {
		mocks.createProjectEnvironmentServiceForOrg.mockRejectedValueOnce(
			new mocks.ProjectEnvironmentServiceError('Service provider not found')
		);

		await expect(
			createProjectEnvironmentService({
				projectId: 'p1',
				profileId: 'profile1',
				kind: 'postgres'
			})
		).rejects.toMatchObject({
			status: 400,
			message: 'Service provider not found'
		});
		expect(mocks.enqueueProjectEnvironmentServiceProvision).not.toHaveBeenCalled();
	});

	it('verifies a service is in scope before enqueueing provisioning', async () => {
		await provisionProjectEnvironmentService({
			projectId: 'p1',
			profileId: 'profile1',
			serviceId: 'svc1'
		});

		expect(mocks.listProjectEnvironmentServicesForOrg).toHaveBeenCalledWith(
			'org1',
			'p1',
			'profile1'
		);
		expect(mocks.enqueueProjectEnvironmentServiceProvision).toHaveBeenCalledWith({
			serviceId: 'svc1'
		});
		expect(mocks.listProjectEnvironmentServicesForOrg.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.enqueueProjectEnvironmentServiceProvision.mock.invocationCallOrder[0]
		);
		expect(mocks.queryRefreshes).toEqual([{ projectId: 'p1', profileId: 'profile1' }]);
	});

	it('does not enqueue provisioning when the service is outside scope', async () => {
		mocks.listProjectEnvironmentServicesForOrg.mockResolvedValueOnce([
			{ ...service, id: 'svc-other' }
		]);

		await expect(
			provisionProjectEnvironmentService({
				projectId: 'p1',
				profileId: 'profile1',
				serviceId: 'svc1'
			})
		).rejects.toMatchObject({
			status: 400,
			message: 'Project environment service not found'
		});

		expect(mocks.enqueueProjectEnvironmentServiceProvision).not.toHaveBeenCalled();
		expect(mocks.queryRefreshes).toEqual([]);
	});

	it('maps provision service errors to a 400 response', async () => {
		mocks.listProjectEnvironmentServicesForOrg.mockRejectedValueOnce(
			new mocks.ProjectEnvironmentServiceError('Project environment profile not found')
		);

		await expect(
			provisionProjectEnvironmentService({
				projectId: 'p1',
				profileId: 'profile1',
				serviceId: 'svc1'
			})
		).rejects.toMatchObject({
			status: 400,
			message: 'Project environment profile not found'
		});
		expect(mocks.enqueueProjectEnvironmentServiceProvision).not.toHaveBeenCalled();
	});

	it('sets service enabled state and refreshes queries', async () => {
		const input = {
			projectId: 'p1',
			profileId: 'profile1',
			serviceId: 'svc1',
			enabled: false
		};

		await expect(setProjectEnvironmentServiceEnabled(input)).resolves.toEqual({ updated: true });

		expect(mocks.setProjectEnvironmentServiceEnabledForOrg).toHaveBeenCalledWith('org1', input);
		expect(mocks.queryRefreshes).toEqual([{ projectId: 'p1', profileId: 'profile1' }, 'p1']);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
	});

	it('updates service env mappings and refreshes queries', async () => {
		const input = {
			projectId: 'p1',
			profileId: 'profile1',
			serviceId: 'svc1',
			envMappings: [
				{ key: 'DIRECT_URL', template: '${url}', enabled: true, sensitive: 'auto' as const },
				{ key: 'DB_HOST', template: '${host}', enabled: true, sensitive: 'auto' as const }
			]
		};

		await expect(updateProjectEnvironmentServiceEnvMappings(input)).resolves.toEqual({
			updated: true
		});

		expect(mocks.updateProjectEnvironmentServiceEnvMappingsForOrg).toHaveBeenCalledWith(
			'org1',
			input
		);
		expect(mocks.queryRefreshes).toEqual([{ projectId: 'p1', profileId: 'profile1' }, 'p1']);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
	});

	it('maps update service env mapping errors to a 400 response', async () => {
		mocks.updateProjectEnvironmentServiceEnvMappingsForOrg.mockRejectedValueOnce(
			new mocks.ProjectEnvironmentServiceError(
				'Mapping BAD references unknown source field missing'
			)
		);

		await expect(
			updateProjectEnvironmentServiceEnvMappings({
				projectId: 'p1',
				profileId: 'profile1',
				serviceId: 'svc1',
				envMappings: [{ key: 'BAD', template: '${missing}', enabled: true, sensitive: 'auto' }]
			})
		).rejects.toMatchObject({
			status: 400,
			message: 'Mapping BAD references unknown source field missing'
		});

		expect(mocks.queryRefreshes).toEqual([]);
		expect(mocks.refresh).not.toHaveBeenCalled();
	});
});
