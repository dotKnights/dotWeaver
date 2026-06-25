import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	profileFindFirst: vi.fn(),
	serviceFindMany: vi.fn(),
	serviceCreate: vi.fn(),
	serviceFindFirst: vi.fn(),
	serviceUpdateMany: vi.fn(),
	eventAggregate: vi.fn(),
	eventCreate: vi.fn(),
	getEnvironmentServiceProvider: vi.fn(),
	runDockerCommand: vi.fn(),
	notifyProjectEnvironmentService: vi.fn(),
	encryptProjectSecretValue: vi.fn(),
	decryptProjectSecretValue: vi.fn()
}));

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		projectEnvironmentProfile: {
			findFirst: mocks.profileFindFirst
		},
		projectEnvironmentService: {
			findMany: mocks.serviceFindMany,
			create: mocks.serviceCreate,
			findFirst: mocks.serviceFindFirst,
			updateMany: mocks.serviceUpdateMany
		},
		projectEnvironmentServiceEvent: {
			aggregate: mocks.eventAggregate,
			create: mocks.eventCreate
		}
	}
}));

vi.mock('$lib/server/project-environment-services/providers', () => ({
	getEnvironmentServiceProvider: mocks.getEnvironmentServiceProvider
}));

vi.mock('$lib/server/project-environment-services/docker', async () => {
	const actual = await vi.importActual<
		typeof import('$lib/server/project-environment-services/docker')
	>('$lib/server/project-environment-services/docker');
	return {
		...actual,
		runDockerCommand: mocks.runDockerCommand
	};
});

vi.mock('$lib/server/project-environment-services/notifications', () => ({
	notifyProjectEnvironmentService: mocks.notifyProjectEnvironmentService
}));

vi.mock('$lib/server/project-agent-config-encryption', () => ({
	encryptProjectSecretValue: mocks.encryptProjectSecretValue,
	decryptProjectSecretValue: mocks.decryptProjectSecretValue
}));

vi.mock('$env/dynamic/private', () => ({
	env: {
		PROJECT_ENVIRONMENT_SERVICE_HEALTHCHECK_ATTEMPTS: '3',
		PROJECT_ENVIRONMENT_SERVICE_HEALTHCHECK_INTERVAL_MS: '0'
	}
}));

import {
	ProjectEnvironmentServiceError,
	createProjectEnvironmentServiceForOrg,
	executeProjectEnvironmentServiceProvision,
	listProjectEnvironmentServicesForOrg,
	setProjectEnvironmentServiceEnabledForOrg
} from '$lib/server/project-environment-services/service';

const profile = {
	id: 'profile1',
	projectId: 'p1',
	organizationId: 'org1'
};

const service = {
	id: 'svc1',
	organizationId: 'org1',
	projectId: 'p1',
	profileId: 'profile1',
	kind: 'postgres',
	name: 'database',
	enabled: true,
	status: 'configured',
	config: {
		image: 'postgres:test',
		password: { encrypted: true, valueEncrypted: 'encrypted:secret' },
		port: 5432
	}
};

const provider = {
	kind: 'postgres',
	version: 'test-provider-v1',
	defaultName: 'postgres',
	defaultConfig: vi.fn(() => ({
		image: 'postgres:test',
		password: 'generated-secret',
		port: 5432
	})),
	validateConfig: vi.fn(() => ({ warnings: [], errors: [] })),
	container: vi.fn((input) => ({
		image: String(input.config.image),
		env: { POSTGRES_PASSWORD: String(input.config.password) },
		volumeTarget: '/var/lib/postgresql/data',
		command: ['postgres']
	})),
	healthcheck: vi.fn((input) => ['exec', input.containerName, 'pg_isready']),
	buildOutputs: vi.fn((input) => [
		{
			key: 'DATABASE_URL',
			value: `postgres://${input.networkAlias}/app?password=${String(input.config.password)}`,
			sensitive: true
		},
		{ key: 'POSTGRES_HOST', value: input.networkAlias, sensitive: false }
	]),
	fingerprint: vi.fn((input) => ({
		kind: 'postgres',
		version: 'test-provider-v1',
		image: input.config.image,
		port: input.config.port
	}))
};

function nextEventSeqs(...seqs: Array<number | null>) {
	mocks.eventAggregate.mockImplementation(async () => ({
		_max: { seq: seqs.length > 0 ? seqs.shift() : null }
	}));
}

function p2002() {
	return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

describe('project environment service lifecycle', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		provider.defaultConfig.mockClear();
		provider.validateConfig.mockClear();
		provider.container.mockClear();
		provider.healthcheck.mockClear();
		provider.buildOutputs.mockClear();
		provider.fingerprint.mockClear();
		mocks.profileFindFirst.mockResolvedValue(profile);
		mocks.serviceFindMany.mockResolvedValue([{ id: 'svc1', name: 'database' }]);
		mocks.serviceCreate.mockImplementation(async ({ data }) => ({
			id: 'svc1',
			...data
		}));
		mocks.serviceFindFirst.mockResolvedValue(service);
		mocks.serviceUpdateMany.mockResolvedValue({ count: 1 });
		nextEventSeqs(null, 0, 1, 2);
		mocks.eventCreate.mockImplementation(async ({ data }) => data);
		mocks.getEnvironmentServiceProvider.mockReturnValue(provider);
		mocks.runDockerCommand.mockResolvedValue(undefined);
		mocks.notifyProjectEnvironmentService.mockResolvedValue(undefined);
		mocks.encryptProjectSecretValue.mockImplementation((value: string) => `encrypted:${value}`);
		mocks.decryptProjectSecretValue.mockImplementation((value: string) =>
			value.startsWith('encrypted:') ? value.slice('encrypted:'.length) : value
		);
	});

	it('lists services scoped to organization, project and profile', async () => {
		mocks.serviceFindMany.mockResolvedValueOnce([
			{
				id: 'svc1',
				name: 'legacy',
				config: {
					image: 'postgres:test',
					password: 'legacy-secret',
					port: 5432
				},
				outputs: [
					{ key: 'DATABASE_URL', valueEncrypted: 'encrypted:url', sensitive: true },
					{ key: 'POSTGRES_HOST', value: 'db.internal', sensitive: false }
				]
			},
			{
				id: 'svc2',
				name: 'encrypted',
				config: {
					image: 'postgres:test',
					password: { encrypted: true, valueEncrypted: 'encrypted:new-secret' },
					port: 5432
				},
				outputs: []
			}
		]);

		await expect(listProjectEnvironmentServicesForOrg('org1', 'p1', 'profile1')).resolves.toEqual([
			{
				id: 'svc1',
				name: 'legacy',
				config: {
					image: 'postgres:test',
					password: { sensitive: true, hasValue: true },
					port: 5432
				},
				outputs: [
					{ key: 'DATABASE_URL', sensitive: true, hasValue: true },
					{ key: 'POSTGRES_HOST', value: 'db.internal', sensitive: false }
				]
			},
			{
				id: 'svc2',
				name: 'encrypted',
				config: {
					image: 'postgres:test',
					password: { sensitive: true, hasValue: true },
					port: 5432
				},
				outputs: []
			}
		]);

		expect(mocks.profileFindFirst).toHaveBeenCalledWith({
			where: { id: 'profile1', projectId: 'p1', organizationId: 'org1' },
			select: { id: true, projectId: true, organizationId: true }
		});
		expect(mocks.serviceFindMany).toHaveBeenCalledWith({
			where: { organizationId: 'org1', projectId: 'p1', profileId: 'profile1' },
			orderBy: { name: 'asc' }
		});
	});

	it('creates a configured service with provider defaults', async () => {
		const result = await createProjectEnvironmentServiceForOrg('org1', 'u1', {
			projectId: 'p1',
			profileId: 'profile1',
			kind: 'postgres',
			name: 'database'
		});

		expect(provider.defaultConfig).toHaveBeenCalledWith({ projectId: 'p1', name: 'database' });
		expect(provider.validateConfig).toHaveBeenCalledWith({
			image: 'postgres:test',
			password: 'generated-secret',
			port: 5432
		});
		expect(mocks.serviceCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				organizationId: 'org1',
				projectId: 'p1',
				profileId: 'profile1',
				kind: 'postgres',
				name: 'database',
				enabled: true,
				status: 'configured',
				config: {
					image: 'postgres:test',
					password: { encrypted: true, valueEncrypted: 'encrypted:generated-secret' },
					port: 5432
				},
				outputs: [],
				runtime: {},
				createdById: 'u1'
			})
		});
		expect(mocks.eventCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				serviceId: 'svc1',
				projectId: 'p1',
				organizationId: 'org1',
				seq: 0,
				type: 'system',
				payload: { text: 'Configured postgres service database' }
			})
		});
		expect(mocks.notifyProjectEnvironmentService).toHaveBeenCalledWith({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'profile1',
			serviceId: 'svc1',
			kind: 'service'
		});
		expect(result.config).toEqual({
			image: 'postgres:test',
			password: { sensitive: true, hasValue: true },
			port: 5432
		});
		expect(JSON.stringify(result)).not.toContain('generated-secret');
	});

	it('provisions a service and stores encrypted sensitive outputs', async () => {
		nextEventSeqs(null, 0);

		await executeProjectEnvironmentServiceProvision({ serviceId: 'svc1' });

		const containerName = 'dotweaver-p-p1-profile-profile1-svc-database';
		const volumeName = 'dotweaver-p-p1-profile-profile1-vol-database';
		const networkAlias = 'dotweaver-p-p1-pf-profile1-svc-database';
		expect(mocks.serviceUpdateMany).toHaveBeenNthCalledWith(1, {
			where: { id: 'svc1', enabled: true, status: { not: 'provisioning' } },
			data: { status: 'provisioning', lastError: null }
		});
		expect(mocks.runDockerCommand).toHaveBeenNthCalledWith(1, ['volume', 'create', volumeName]);
		expect(mocks.runDockerCommand).toHaveBeenNthCalledWith(2, ['rm', '-f', containerName]);
		expect(mocks.runDockerCommand.mock.calls[2][0]).toEqual(
			expect.arrayContaining([
				'run',
				'-d',
				'--name',
				containerName,
				'--network',
				'bridge',
				'--network-alias',
				networkAlias,
				'-v',
				`${volumeName}:/var/lib/postgresql/data`
			])
		);
		expect(mocks.runDockerCommand).toHaveBeenNthCalledWith(4, [
			'exec',
			containerName,
			'pg_isready'
		]);
		expect(provider.healthcheck).toHaveBeenCalledWith(
			expect.objectContaining({ containerName, networkAlias })
		);
		expect(provider.container).toHaveBeenCalledWith(
			expect.objectContaining({
				config: expect.objectContaining({ password: 'secret' })
			})
		);
		expect(provider.buildOutputs).toHaveBeenCalledWith(
			expect.objectContaining({
				config: expect.objectContaining({ password: 'secret' })
			})
		);
		expect(mocks.decryptProjectSecretValue).toHaveBeenCalledWith('encrypted:secret');
		const readyUpdate = mocks.serviceUpdateMany.mock.calls[1][0];
		expect(readyUpdate).toEqual({
			where: { id: 'svc1', enabled: true, status: 'provisioning' },
			data: expect.objectContaining({
				status: 'ready',
				lastError: null,
				runtime: expect.objectContaining({
					containerName,
					volumeName,
					networkAlias,
					image: 'postgres:test',
					provider: { kind: 'postgres', version: 'test-provider-v1' },
					fingerprint: {
						kind: 'postgres',
						version: 'test-provider-v1',
						image: 'postgres:test',
						port: 5432
					}
				}),
				outputs: [
					{
						key: 'DATABASE_URL',
						valueEncrypted:
							'encrypted:postgres://dotweaver-p-p1-pf-profile1-svc-database/app?password=secret',
						sensitive: true
					},
					{
						key: 'POSTGRES_HOST',
						value: 'dotweaver-p-p1-pf-profile1-svc-database',
						sensitive: false
					}
				],
				lastReadyAt: expect.any(Date)
			})
		});
		expect(JSON.stringify(readyUpdate.data.outputs)).not.toContain('"value":"postgres://');
	});

	it('throws without marking failed when the service is disabled', async () => {
		mocks.serviceFindFirst.mockResolvedValueOnce({
			...service,
			enabled: false,
			status: 'disabled'
		});

		const promise = executeProjectEnvironmentServiceProvision({ serviceId: 'svc1' });

		await expect(promise).rejects.toBeInstanceOf(ProjectEnvironmentServiceError);
		await expect(promise).rejects.toThrow('Project environment service is disabled');
		expect(mocks.serviceUpdateMany).not.toHaveBeenCalled();
		expect(mocks.runDockerCommand).not.toHaveBeenCalled();
		expect(mocks.eventCreate).not.toHaveBeenCalled();
	});

	it('throws without marking failed when the provisioning claim misses', async () => {
		mocks.serviceUpdateMany.mockResolvedValueOnce({ count: 0 });

		const promise = executeProjectEnvironmentServiceProvision({ serviceId: 'svc1' });

		await expect(promise).rejects.toBeInstanceOf(ProjectEnvironmentServiceError);
		await expect(promise).rejects.toThrow('Project environment service is already provisioning');
		expect(mocks.serviceUpdateMany).toHaveBeenCalledTimes(1);
		expect(mocks.serviceUpdateMany).toHaveBeenCalledWith({
			where: { id: 'svc1', enabled: true, status: { not: 'provisioning' } },
			data: { status: 'provisioning', lastError: null }
		});
		expect(mocks.runDockerCommand).not.toHaveBeenCalled();
		expect(mocks.eventCreate).not.toHaveBeenCalled();
	});

	it('retries healthcheck failures before marking the service ready', async () => {
		mocks.runDockerCommand
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('healthcheck not ready'))
			.mockResolvedValueOnce(undefined);

		await executeProjectEnvironmentServiceProvision({ serviceId: 'svc1' });

		expect(mocks.runDockerCommand).toHaveBeenNthCalledWith(4, [
			'exec',
			'dotweaver-p-p1-profile-profile1-svc-database',
			'pg_isready'
		]);
		expect(mocks.runDockerCommand).toHaveBeenNthCalledWith(5, [
			'exec',
			'dotweaver-p-p1-profile-profile1-svc-database',
			'pg_isready'
		]);
		expect(mocks.serviceUpdateMany).toHaveBeenLastCalledWith({
			where: { id: 'svc1', enabled: true, status: 'provisioning' },
			data: expect.objectContaining({ status: 'ready', lastError: null })
		});
	});

	it('does not mark a service ready when it was disabled during provisioning', async () => {
		mocks.serviceUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

		await executeProjectEnvironmentServiceProvision({ serviceId: 'svc1' });

		expect(mocks.serviceUpdateMany).toHaveBeenNthCalledWith(2, {
			where: { id: 'svc1', enabled: true, status: 'provisioning' },
			data: expect.objectContaining({ status: 'ready', lastError: null })
		});
		expect(mocks.eventCreate.mock.calls).not.toEqual(
			expect.arrayContaining([
				[
					{
						data: expect.objectContaining({ type: 'result' })
					}
				]
			])
		);
		expect(
			mocks.notifyProjectEnvironmentService.mock.calls.filter(
				([notification]) => notification.kind === 'service'
			)
		).toHaveLength(1);
	});

	it('marks failed when all healthcheck attempts fail', async () => {
		mocks.runDockerCommand
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('healthcheck not ready'))
			.mockRejectedValueOnce(new Error('healthcheck not ready'))
			.mockRejectedValueOnce(new Error('healthcheck not ready'));

		const promise = executeProjectEnvironmentServiceProvision({ serviceId: 'svc1' });

		await expect(promise).rejects.toThrow('healthcheck not ready');
		expect(mocks.runDockerCommand).toHaveBeenCalledTimes(6);
		expect(mocks.serviceUpdateMany).toHaveBeenLastCalledWith({
			where: { id: 'svc1', enabled: true, status: 'provisioning' },
			data: { status: 'failed', lastError: 'healthcheck not ready' }
		});
	});

	it('does not mark a service failed when it was disabled during provisioning', async () => {
		mocks.serviceUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
		mocks.runDockerCommand
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('docker run exploded'));

		const promise = executeProjectEnvironmentServiceProvision({ serviceId: 'svc1' });

		await expect(promise).rejects.toThrow('docker run exploded');
		expect(mocks.serviceUpdateMany).toHaveBeenLastCalledWith({
			where: { id: 'svc1', enabled: true, status: 'provisioning' },
			data: { status: 'failed', lastError: 'docker run exploded' }
		});
		expect(mocks.eventCreate.mock.calls).not.toEqual(
			expect.arrayContaining([
				[
					{
						data: expect.objectContaining({ type: 'error' })
					}
				]
			])
		);
		expect(
			mocks.notifyProjectEnvironmentService.mock.calls.filter(
				([notification]) => notification.kind === 'service'
			)
		).toHaveLength(1);
	});

	it('retries event sequence collisions before creating the event', async () => {
		nextEventSeqs(0, 1);
		mocks.eventCreate
			.mockRejectedValueOnce(p2002())
			.mockImplementationOnce(async ({ data }) => data);

		await createProjectEnvironmentServiceForOrg('org1', 'u1', {
			projectId: 'p1',
			profileId: 'profile1',
			kind: 'postgres',
			name: 'database'
		});

		expect(mocks.eventCreate).toHaveBeenNthCalledWith(1, {
			data: expect.objectContaining({ serviceId: 'svc1', seq: 1 })
		});
		expect(mocks.eventCreate).toHaveBeenNthCalledWith(2, {
			data: expect.objectContaining({ serviceId: 'svc1', seq: 2 })
		});
		expect(mocks.notifyProjectEnvironmentService).toHaveBeenCalledWith({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'profile1',
			serviceId: 'svc1',
			kind: 'event',
			seq: 2
		});
	});

	it('marks the service failed when provisioning throws', async () => {
		mocks.runDockerCommand
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('docker run exploded'));

		const promise = executeProjectEnvironmentServiceProvision({ serviceId: 'svc1' });

		await expect(promise).rejects.toBeInstanceOf(ProjectEnvironmentServiceError);
		await expect(promise).rejects.toThrow('docker run exploded');
		expect(mocks.serviceUpdateMany).toHaveBeenLastCalledWith({
			where: { id: 'svc1', enabled: true, status: 'provisioning' },
			data: { status: 'failed', lastError: 'docker run exploded' }
		});
		expect(mocks.eventCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				serviceId: 'svc1',
				projectId: 'p1',
				organizationId: 'org1',
				type: 'error',
				payload: { message: 'docker run exploded' }
			})
		});
		expect(mocks.notifyProjectEnvironmentService).toHaveBeenCalledWith({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'profile1',
			serviceId: 'svc1',
			kind: 'service'
		});
	});

	it('toggles enabled state via scoped updateMany calls', async () => {
		await setProjectEnvironmentServiceEnabledForOrg('org1', {
			projectId: 'p1',
			profileId: 'profile1',
			serviceId: 'svc1',
			enabled: false
		});
		await setProjectEnvironmentServiceEnabledForOrg('org1', {
			projectId: 'p1',
			profileId: 'profile1',
			serviceId: 'svc1',
			enabled: true
		});

		expect(mocks.serviceUpdateMany).toHaveBeenNthCalledWith(1, {
			where: { id: 'svc1', organizationId: 'org1', projectId: 'p1', profileId: 'profile1' },
			data: { enabled: false, status: 'disabled' }
		});
		expect(mocks.serviceUpdateMany).toHaveBeenNthCalledWith(2, {
			where: { id: 'svc1', organizationId: 'org1', projectId: 'p1', profileId: 'profile1' },
			data: { enabled: true, status: 'configured' }
		});
		expect(mocks.notifyProjectEnvironmentService).toHaveBeenCalledWith({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'profile1',
			serviceId: 'svc1',
			kind: 'service'
		});
	});

	it('throws a scoped error when the enabled update misses', async () => {
		mocks.serviceUpdateMany.mockResolvedValueOnce({ count: 0 });

		const promise = setProjectEnvironmentServiceEnabledForOrg('org1', {
			projectId: 'p1',
			profileId: 'profile1',
			serviceId: 'svc1',
			enabled: true
		});

		await expect(promise).rejects.toThrow(ProjectEnvironmentServiceError);
		await expect(promise).rejects.toThrow('Project environment service not found');
		expect(mocks.serviceUpdateMany).toHaveBeenCalledWith({
			where: { id: 'svc1', organizationId: 'org1', projectId: 'p1', profileId: 'profile1' },
			data: { enabled: true, status: 'configured' }
		});
		expect(mocks.notifyProjectEnvironmentService).not.toHaveBeenCalled();
	});
});
