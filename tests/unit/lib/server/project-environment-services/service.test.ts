import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	profileFindFirst: vi.fn(),
	profileUpdateMany: vi.fn(),
	serviceFindMany: vi.fn(),
	serviceCreate: vi.fn(),
	serviceFindFirst: vi.fn(),
	serviceUpdateMany: vi.fn(),
	envVarFindMany: vi.fn(),
	eventAggregate: vi.fn(),
	eventCreate: vi.fn(),
	getEnvironmentServiceProvider: vi.fn(),
	runDockerCommand: vi.fn(),
	ensureDockerNetwork: vi.fn(),
	notifyProjectEnvironmentService: vi.fn(),
	notifyProjectEnvironmentPrepare: vi.fn(),
	encryptProjectSecretValue: vi.fn(),
	decryptProjectSecretValue: vi.fn()
}));

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		projectEnvironmentProfile: {
			findFirst: mocks.profileFindFirst,
			updateMany: mocks.profileUpdateMany
		},
		projectEnvironmentService: {
			findMany: mocks.serviceFindMany,
			create: mocks.serviceCreate,
			findFirst: mocks.serviceFindFirst,
			updateMany: mocks.serviceUpdateMany
		},
		projectEnvVar: {
			findMany: mocks.envVarFindMany
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

vi.mock('$lib/server/runtime/docker-network', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/runtime/docker-network')>(
		'$lib/server/runtime/docker-network'
	);
	return {
		...actual,
		ensureDockerNetwork: mocks.ensureDockerNetwork
	};
});

vi.mock('$lib/server/project-environment-services/notifications', () => ({
	notifyProjectEnvironmentService: mocks.notifyProjectEnvironmentService
}));

vi.mock('$lib/server/project-environments/notifications', () => ({
	notifyProjectEnvironmentPrepare: mocks.notifyProjectEnvironmentPrepare
}));

vi.mock('$lib/server/project-agent-config/encryption', () => ({
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
	buildProjectEnvironmentServiceOutputsForOrg,
	createProjectEnvironmentServiceForOrg,
	executeProjectEnvironmentServiceProvision,
	listProjectEnvironmentServicesForOrg,
	setProjectEnvironmentServiceEnabledForOrg,
	updateProjectEnvironmentServiceEnvMappingsForOrg
} from '$lib/server/project-environment-services/service';
import {
	resolveServiceEnvMappings,
	serviceSourceFieldsFromOutputs
} from '$lib/server/project-environment-services/env-mapping';
import { postgresProvider } from '$lib/server/project-environment-services/providers/postgres';
import { redisProvider } from '$lib/server/project-environment-services/providers/redis';

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

const serviceUpdatedAt = new Date('2026-06-26T10:00:00.000Z');

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

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
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
		mocks.profileUpdateMany.mockResolvedValue({ count: 1 });
		mocks.serviceFindMany.mockResolvedValue([{ id: 'svc1', name: 'database' }]);
		mocks.serviceCreate.mockImplementation(async ({ data }) => ({
			id: 'svc1',
			...data
		}));
		mocks.serviceFindFirst.mockResolvedValue(service);
		mocks.serviceUpdateMany.mockResolvedValue({ count: 1 });
		mocks.envVarFindMany.mockResolvedValue([]);
		nextEventSeqs(null, 0, 1, 2);
		mocks.eventCreate.mockImplementation(async ({ data }) => data);
		mocks.getEnvironmentServiceProvider.mockReturnValue(provider);
		mocks.runDockerCommand.mockResolvedValue(undefined);
		mocks.ensureDockerNetwork.mockResolvedValue(undefined);
		mocks.notifyProjectEnvironmentService.mockResolvedValue(undefined);
		mocks.notifyProjectEnvironmentPrepare.mockResolvedValue(undefined);
		mocks.encryptProjectSecretValue.mockImplementation((value: string) => `encrypted:${value}`);
		mocks.decryptProjectSecretValue.mockImplementation((value: string) =>
			value.startsWith('encrypted:') ? value.slice('encrypted:'.length) : value
		);
	});

	it('lists services scoped to organization, project and profile', async () => {
		mocks.serviceFindMany.mockResolvedValueOnce([
			{
				id: 'svc1',
				kind: 'postgres',
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
				kind: 'postgres',
				name: 'encrypted',
				config: {
					image: 'postgres:test',
					password: { encrypted: true, valueEncrypted: 'encrypted:new-secret' },
					port: 5432
				},
				outputs: []
			}
		]);

		const result = await listProjectEnvironmentServicesForOrg('org1', 'p1', 'profile1');

		expect(result).toEqual([
			{
				id: 'svc1',
				kind: 'postgres',
				name: 'legacy',
				config: {
					image: 'postgres:test',
					password: { sensitive: true, hasValue: true },
					port: 5432
				},
				envMappings: [
					{ key: 'DATABASE_URL', template: '${url}', enabled: true, sensitive: 'auto' },
					{ key: 'POSTGRES_HOST', template: '${host}', enabled: true, sensitive: 'auto' }
				],
				sourceFields: [
					{ key: 'url', sensitive: true, hasValue: true },
					{ key: 'host', value: 'db.internal', sensitive: false }
				],
				outputs: [
					{ key: 'DATABASE_URL', sensitive: true, hasValue: true },
					{ key: 'POSTGRES_HOST', value: 'db.internal', sensitive: false }
				],
				mappingWarnings: [],
				mappingErrors: []
			},
			{
				id: 'svc2',
				kind: 'postgres',
				name: 'encrypted',
				config: {
					image: 'postgres:test',
					password: { sensitive: true, hasValue: true },
					port: 5432
				},
				envMappings: [],
				sourceFields: [],
				outputs: [],
				mappingWarnings: [],
				mappingErrors: []
			}
		]);
		expect(JSON.stringify(result)).not.toContain('legacy-secret');
		expect(JSON.stringify(result)).not.toContain('new-secret');

		expect(mocks.profileFindFirst).toHaveBeenCalledWith({
			where: { id: 'profile1', projectId: 'p1', organizationId: 'org1' },
			select: { id: true, projectId: true, organizationId: true }
		});
		expect(mocks.serviceFindMany).toHaveBeenCalledWith({
			where: { organizationId: 'org1', projectId: 'p1', profileId: 'profile1' },
			orderBy: { name: 'asc' }
		});
	});

	it('lists resolved env mappings with masked previews', async () => {
		mocks.serviceFindMany.mockResolvedValueOnce([
			{
				id: 'svc1',
				kind: 'postgres',
				name: 'database',
				enabled: true,
				status: 'ready',
				lastError: null,
				config: {
					envMappings: [
						{ key: 'DATABASE_URL', template: '${url}', enabled: true, sensitive: 'auto' },
						{ key: 'DB_HOST', template: '${host}', enabled: true, sensitive: 'auto' }
					]
				},
				outputs: [
					{
						key: 'url',
						valueEncrypted: 'encrypted:postgres://secret@db.internal/app',
						sensitive: true
					},
					{ key: 'host', value: 'db.internal', sensitive: false }
				]
			}
		]);

		const result = await listProjectEnvironmentServicesForOrg('org1', 'p1', 'profile1');

		expect(result[0]).toMatchObject({
			envMappings: [
				{ key: 'DATABASE_URL', template: '${url}', enabled: true, sensitive: 'auto' },
				{ key: 'DB_HOST', template: '${host}', enabled: true, sensitive: 'auto' }
			],
			sourceFields: expect.arrayContaining([
				{ key: 'url', sensitive: true, hasValue: true },
				{ key: 'host', value: 'db.internal', sensitive: false }
			]),
			outputs: [
				{ key: 'DATABASE_URL', sensitive: true, hasValue: true },
				{ key: 'DB_HOST', value: 'db.internal', sensitive: false }
			],
			mappingWarnings: [],
			mappingErrors: []
		});
		expect(JSON.stringify(result)).not.toContain('secret');
	});

	it('lists mapping errors instead of throwing for malformed public service outputs', async () => {
		mocks.serviceFindMany.mockResolvedValueOnce([
			{
				id: 'svc1',
				kind: 'postgres',
				name: 'database',
				config: {},
				outputs: [{ key: 'url', sensitive: true }]
			}
		]);

		const result = await listProjectEnvironmentServicesForOrg('org1', 'p1', 'profile1');

		expect(result[0]).toMatchObject({
			envMappings: [],
			sourceFields: [],
			outputs: [],
			mappingWarnings: [],
			mappingErrors: [expect.stringContaining('Service outputs could not be read')]
		});
	});

	it('lists mapping errors for public custom mappings with missing sources', async () => {
		mocks.serviceFindMany.mockResolvedValueOnce([
			{
				id: 'svc1',
				kind: 'postgres',
				name: 'database',
				config: {
					envMappings: [
						{ key: 'POSTGRES_PASSWORD', template: '${password}', enabled: true, sensitive: 'auto' }
					]
				},
				outputs: [{ key: 'host', value: 'db.internal', sensitive: false }]
			}
		]);

		const result = await listProjectEnvironmentServicesForOrg('org1', 'p1', 'profile1');

		expect(result[0]).toMatchObject({
			envMappings: [
				{ key: 'POSTGRES_PASSWORD', template: '${password}', enabled: true, sensitive: 'auto' }
			],
			sourceFields: [{ key: 'host', value: 'db.internal', sensitive: false }],
			outputs: [],
			mappingWarnings: [],
			mappingErrors: ['Mapping POSTGRES_PASSWORD references missing source field password']
		});
	});

	it('redacts public templates for sensitive custom mappings with literal values', async () => {
		mocks.serviceFindMany.mockResolvedValueOnce([
			{
				id: 'svc1',
				kind: 'postgres',
				name: 'database',
				config: {
					envMappings: [
						{
							key: 'DATABASE_URL',
							template: 'postgres://user:literal-secret@${host}/app',
							enabled: true,
							sensitive: 'auto'
						},
						{ key: 'DB_HOST', template: '${host}', enabled: true, sensitive: false }
					]
				},
				outputs: [{ key: 'host', value: 'db.internal', sensitive: false }]
			}
		]);

		const result = await listProjectEnvironmentServicesForOrg('org1', 'p1', 'profile1');

		expect(result[0]).toMatchObject({
			envMappings: [
				{ key: 'DATABASE_URL', template: '${masked}', enabled: true, sensitive: 'auto' },
				{ key: 'DB_HOST', template: '${host}', enabled: true, sensitive: false }
			]
		});
		expect(JSON.stringify(result)).not.toContain('literal-secret');
	});

	it('uses enabled mapping templates when redacting public resolved outputs', async () => {
		mocks.serviceFindMany.mockResolvedValueOnce([
			{
				id: 'svc1',
				kind: 'postgres',
				name: 'database',
				config: {
					envMappings: [
						{
							key: 'DATABASE_URL',
							template: 'postgres://user:literal-secret@${host}/app',
							enabled: true,
							sensitive: false
						},
						{ key: 'DATABASE_URL', template: '${host}', enabled: false, sensitive: false }
					]
				},
				outputs: [{ key: 'host', value: 'db.internal', sensitive: false }]
			}
		]);

		const result = await listProjectEnvironmentServicesForOrg('org1', 'p1', 'profile1');

		expect(result[0]).toMatchObject({
			outputs: [{ key: 'DATABASE_URL', sensitive: true, hasValue: true }]
		});
		expect(JSON.stringify(result)).not.toContain('literal-secret');
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
		expect(mocks.profileUpdateMany).toHaveBeenCalledWith({
			where: { id: 'profile1', organizationId: 'org1', projectId: 'p1' },
			data: { lastPreparedFingerprint: null }
		});
		expect(mocks.notifyProjectEnvironmentPrepare).toHaveBeenCalledWith({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'profile1',
			kind: 'profile'
		});
		expect(result.config).toEqual({
			image: 'postgres:test',
			password: { sensitive: true, hasValue: true },
			port: 5432
		});
		expect(JSON.stringify(result)).not.toContain('generated-secret');
	});

	it('rejects service creation when default env keys collide with project env vars', async () => {
		mocks.envVarFindMany.mockResolvedValueOnce([{ key: 'DATABASE_URL' }]);

		await expect(
			createProjectEnvironmentServiceForOrg('org1', 'u1', {
				projectId: 'p1',
				profileId: 'profile1',
				kind: 'postgres',
				name: 'database'
			})
		).rejects.toThrow('DATABASE_URL is already configured as a project env var');
		expect(mocks.serviceCreate).not.toHaveBeenCalled();
	});

	it('builds ready service env outputs and fingerprint inputs without exposing secret values', async () => {
		mocks.serviceFindMany.mockResolvedValueOnce([
			{
				id: 'svc1',
				organizationId: 'org1',
				projectId: 'p1',
				profileId: 'profile1',
				kind: 'postgres',
				name: 'database',
				enabled: true,
				status: 'ready',
				config: {
					image: 'postgres:test',
					password: { encrypted: true, valueEncrypted: 'encrypted:secret' },
					port: 5432
				},
				outputs: [
					{ key: 'host', value: 'db.internal', sensitive: false },
					{ key: 'port', value: '5432', sensitive: false },
					{ key: 'database', value: 'app', sensitive: false },
					{ key: 'user', value: 'dotweaver', sensitive: false },
					{ key: 'password', valueEncrypted: 'encrypted:secret', sensitive: true },
					{
						key: 'url',
						valueEncrypted: 'encrypted:postgres://secret@db.internal/app',
						sensitive: true
					}
				]
			}
		]);

		const result = await buildProjectEnvironmentServiceOutputsForOrg('org1', 'p1', 'profile1');

		expect(result.env).toEqual([
			{
				key: 'DATABASE_URL',
				value: 'postgres://secret@db.internal/app',
				sensitive: true
			},
			{ key: 'POSTGRES_DB', value: 'app', sensitive: false },
			{ key: 'POSTGRES_HOST', value: 'db.internal', sensitive: false },
			{ key: 'POSTGRES_PASSWORD', value: 'secret', sensitive: true },
			{ key: 'POSTGRES_PORT', value: '5432', sensitive: false },
			{ key: 'POSTGRES_USER', value: 'dotweaver', sensitive: false }
		]);
		expect(result.warnings).toEqual([]);
		expect(result.fingerprintInputs).toEqual([
			{
				kind: 'postgres',
				name: 'database',
				enabled: true,
				status: 'ready',
				providerVersion: 'test-provider-v1',
				config: {
					kind: 'postgres',
					version: 'test-provider-v1',
					image: 'postgres:test',
					port: 5432
				},
				outputKeys: [
					'DATABASE_URL',
					'POSTGRES_DB',
					'POSTGRES_HOST',
					'POSTGRES_PASSWORD',
					'POSTGRES_PORT',
					'POSTGRES_USER'
				],
				outputValueHashes: [
					sha256('postgres://secret@db.internal/app'),
					sha256('app'),
					sha256('db.internal'),
					sha256('secret'),
					sha256('5432'),
					sha256('dotweaver')
				]
			}
		]);
		expect(provider.fingerprint).toHaveBeenCalledWith(
			expect.objectContaining({
				config: expect.objectContaining({ password: 'secret' })
			})
		);
		expect(JSON.stringify(result.fingerprintInputs)).not.toContain('secret');
		expect(JSON.stringify(result.fingerprintInputs)).not.toContain('postgres://secret');
	});

	it('resolves custom service env mappings from service config', async () => {
		mocks.serviceFindMany.mockResolvedValueOnce([
			{
				id: 'svc1',
				organizationId: 'org1',
				projectId: 'p1',
				profileId: 'profile1',
				kind: 'postgres',
				name: 'database',
				enabled: true,
				status: 'ready',
				config: {
					image: 'postgres:test',
					password: { encrypted: true, valueEncrypted: 'encrypted:secret' },
					port: 5432,
					envMappings: [
						{ key: 'DIRECT_URL', template: '${url}', enabled: true, sensitive: 'auto' },
						{ key: 'DB_HOST', template: '${host}', enabled: true, sensitive: 'auto' }
					]
				},
				outputs: [
					{
						key: 'url',
						valueEncrypted: 'encrypted:postgres://secret@db.internal/app',
						sensitive: true
					},
					{ key: 'host', value: 'db.internal', sensitive: false }
				]
			}
		]);

		const result = await buildProjectEnvironmentServiceOutputsForOrg('org1', 'p1', 'profile1');

		expect(result.env).toEqual([
			{ key: 'DB_HOST', value: 'db.internal', sensitive: false },
			{ key: 'DIRECT_URL', value: 'postgres://secret@db.internal/app', sensitive: true }
		]);
		expect(result.fingerprintInputs[0].outputKeys).toEqual(['DB_HOST', 'DIRECT_URL']);
	});

	it('rejects custom service env mappings that reference missing source fields', async () => {
		mocks.serviceFindMany.mockResolvedValueOnce([
			{
				id: 'svc1',
				organizationId: 'org1',
				projectId: 'p1',
				profileId: 'profile1',
				kind: 'postgres',
				name: 'database',
				enabled: true,
				status: 'ready',
				config: {
					image: 'postgres:test',
					password: { encrypted: true, valueEncrypted: 'encrypted:secret' },
					port: 5432,
					envMappings: [
						{ key: 'POSTGRES_PASSWORD', template: '${password}', enabled: true, sensitive: 'auto' }
					]
				},
				outputs: [{ key: 'host', value: 'db.internal', sensitive: false }]
			}
		]);

		await expect(
			buildProjectEnvironmentServiceOutputsForOrg('org1', 'p1', 'profile1')
		).rejects.toThrow('references missing source field password');
	});

	it('rejects malformed stored service env mapping entries', async () => {
		mocks.serviceFindMany.mockResolvedValueOnce([
			{
				id: 'svc1',
				organizationId: 'org1',
				projectId: 'p1',
				profileId: 'profile1',
				kind: 'postgres',
				name: 'database',
				enabled: true,
				status: 'ready',
				config: {
					image: 'postgres:test',
					password: { encrypted: true, valueEncrypted: 'encrypted:secret' },
					port: 5432,
					envMappings: ['not-a-mapping']
				},
				outputs: [
					{
						key: 'url',
						valueEncrypted: 'encrypted:postgres://secret@db.internal/app',
						sensitive: true
					}
				]
			}
		]);

		await expect(
			buildProjectEnvironmentServiceOutputsForOrg('org1', 'p1', 'profile1')
		).rejects.toThrow('has an invalid env var name');
	});

	it('keeps legacy provisioned outputs working through the standard mapping fallback', async () => {
		mocks.serviceFindMany.mockResolvedValueOnce([
			{
				id: 'svc1',
				kind: 'postgres',
				name: 'database',
				enabled: true,
				status: 'ready',
				config: {
					image: 'postgres:test',
					password: { encrypted: true, valueEncrypted: 'encrypted:secret' }
				},
				outputs: [
					{
						key: 'DATABASE_URL',
						valueEncrypted: 'encrypted:postgres://secret@db.internal/app',
						sensitive: true
					},
					{ key: 'POSTGRES_HOST', value: 'db.internal', sensitive: false }
				]
			}
		]);

		const result = await buildProjectEnvironmentServiceOutputsForOrg('org1', 'p1', 'profile1');

		expect(result.env).toEqual([
			{ key: 'DATABASE_URL', value: 'postgres://secret@db.internal/app', sensitive: true },
			{ key: 'POSTGRES_HOST', value: 'db.internal', sensitive: false }
		]);
	});

	it('maps canonical provider outputs to legacy runtime env vars', () => {
		const postgresOutputs = postgresProvider.buildOutputs({
			projectId: 'p1',
			serviceId: 'svc1',
			name: 'database',
			containerName: 'postgres-container',
			networkAlias: 'db.internal',
			config: {
				image: 'postgres:test',
				database: 'app',
				user: 'dotweaver',
				password: 'secret',
				port: 5432
			}
		});
		const redisOutputs = redisProvider.buildOutputs({
			projectId: 'p1',
			serviceId: 'svc2',
			name: 'cache',
			containerName: 'redis-container',
			networkAlias: 'cache.internal',
			config: {
				image: 'redis:test',
				password: 'redis-secret',
				port: 6379,
				appendOnly: true
			}
		});

		const postgresResult = resolveServiceEnvMappings({
			kind: 'postgres',
			sources: serviceSourceFieldsFromOutputs('postgres', postgresOutputs)
		});
		const redisResult = resolveServiceEnvMappings({
			kind: 'redis',
			sources: serviceSourceFieldsFromOutputs('redis', redisOutputs)
		});

		expect(postgresResult.errors).toEqual([]);
		expect(
			postgresResult.env.map(({ key, value, sensitive }) => ({ key, value, sensitive }))
		).toEqual([
			{
				key: 'DATABASE_URL',
				value: 'postgresql://dotweaver:secret@db.internal:5432/app',
				sensitive: true
			},
			{ key: 'POSTGRES_HOST', value: 'db.internal', sensitive: false },
			{ key: 'POSTGRES_PORT', value: '5432', sensitive: false },
			{ key: 'POSTGRES_DB', value: 'app', sensitive: false },
			{ key: 'POSTGRES_USER', value: 'dotweaver', sensitive: false },
			{ key: 'POSTGRES_PASSWORD', value: 'secret', sensitive: true }
		]);
		expect(redisResult.errors).toEqual([]);
		expect(redisResult.env.map(({ key, value, sensitive }) => ({ key, value, sensitive }))).toEqual(
			[
				{
					key: 'REDIS_URL',
					value: 'redis://:redis-secret@cache.internal:6379',
					sensitive: true
				},
				{ key: 'REDIS_HOST', value: 'cache.internal', sensitive: false },
				{ key: 'REDIS_PORT', value: '6379', sensitive: false },
				{ key: 'REDIS_PASSWORD', value: 'redis-secret', sensitive: true }
			]
		);
	});

	it('warns about enabled services that are not ready and ignores disabled services', async () => {
		mocks.serviceFindMany.mockResolvedValueOnce([
			{
				id: 'svc1',
				kind: 'postgres',
				name: 'database',
				enabled: true,
				status: 'provisioning',
				config: {},
				outputs: []
			},
			{
				id: 'svc2',
				kind: 'redis',
				name: 'cache',
				enabled: false,
				status: 'disabled',
				config: {},
				outputs: [{ key: 'REDIS_URL', valueEncrypted: 'encrypted:redis://secret', sensitive: true }]
			}
		]);

		const result = await buildProjectEnvironmentServiceOutputsForOrg('org1', 'p1', 'profile1');

		expect(result.env).toEqual([]);
		expect(result.fingerprintInputs).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain('database');
		expect(result.warnings[0]).toContain('provisioning');
		expect(mocks.decryptProjectSecretValue).not.toHaveBeenCalledWith('encrypted:redis://secret');
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
		expect(mocks.ensureDockerNetwork).toHaveBeenCalledWith('dotweaver-runner');
		expect(mocks.ensureDockerNetwork.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.runDockerCommand.mock.invocationCallOrder[2]
		);
		expect(mocks.runDockerCommand.mock.calls[2][0]).toEqual(
			expect.arrayContaining([
				'run',
				'-d',
				'--name',
				containerName,
				'--network',
				'dotweaver-runner',
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
		expect(mocks.profileUpdateMany).toHaveBeenCalledWith({
			where: { id: 'profile1', organizationId: 'org1', projectId: 'p1' },
			data: { lastPreparedFingerprint: null }
		});
		expect(mocks.notifyProjectEnvironmentPrepare).toHaveBeenCalledWith({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'profile1',
			kind: 'profile'
		});
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
		expect(mocks.profileUpdateMany).not.toHaveBeenCalled();
		expect(mocks.notifyProjectEnvironmentPrepare).not.toHaveBeenCalled();
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
		expect(mocks.profileUpdateMany).toHaveBeenNthCalledWith(1, {
			where: { id: 'profile1', organizationId: 'org1', projectId: 'p1' },
			data: { lastPreparedFingerprint: null }
		});
		expect(mocks.profileUpdateMany).toHaveBeenNthCalledWith(2, {
			where: { id: 'profile1', organizationId: 'org1', projectId: 'p1' },
			data: { lastPreparedFingerprint: null }
		});
		expect(mocks.notifyProjectEnvironmentPrepare).toHaveBeenCalledTimes(2);
		expect(mocks.notifyProjectEnvironmentPrepare).toHaveBeenCalledWith({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'profile1',
			kind: 'profile'
		});
	});

	it('rejects enabling a service when its env keys collide with project env vars', async () => {
		mocks.serviceFindFirst.mockResolvedValueOnce({
			id: 'svc1',
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'profile1',
			kind: 'postgres',
			name: 'database',
			config: {},
			enabled: false,
			status: 'disabled'
		});
		mocks.envVarFindMany.mockResolvedValueOnce([{ key: 'DATABASE_URL' }]);

		await expect(
			setProjectEnvironmentServiceEnabledForOrg('org1', {
				projectId: 'p1',
				profileId: 'profile1',
				serviceId: 'svc1',
				enabled: true
			})
		).rejects.toThrow('DATABASE_URL is already configured as a project env var');
		expect(mocks.serviceUpdateMany).not.toHaveBeenCalled();
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

	it('updates service env mappings in config without changing provisioned outputs', async () => {
		mocks.serviceFindFirst.mockResolvedValueOnce({
			id: 'svc1',
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'profile1',
			kind: 'postgres',
			name: 'database',
			enabled: true,
			status: 'ready',
			updatedAt: serviceUpdatedAt,
			config: {
				image: 'postgres:test',
				password: { encrypted: true, valueEncrypted: 'encrypted:secret' },
				port: 5432
			}
		});
		mocks.serviceUpdateMany.mockResolvedValueOnce({ count: 1 });

		await updateProjectEnvironmentServiceEnvMappingsForOrg('org1', {
			projectId: 'p1',
			profileId: 'profile1',
			serviceId: 'svc1',
			envMappings: [
				{ key: 'DIRECT_URL', template: '${url}', enabled: true, sensitive: 'auto' },
				{ key: 'DB_HOST', template: '${host}', enabled: true, sensitive: 'auto' }
			]
		});

		expect(mocks.serviceUpdateMany).toHaveBeenCalledWith({
			where: {
				id: 'svc1',
				organizationId: 'org1',
				projectId: 'p1',
				profileId: 'profile1',
				updatedAt: serviceUpdatedAt
			},
			data: {
				config: expect.objectContaining({
					image: 'postgres:test',
					password: { encrypted: true, valueEncrypted: 'encrypted:secret' },
					port: 5432,
					envMappings: [
						{ key: 'DIRECT_URL', template: '${url}', enabled: true, sensitive: 'auto' },
						{ key: 'DB_HOST', template: '${host}', enabled: true, sensitive: 'auto' }
					]
				})
			}
		});
		expect(mocks.notifyProjectEnvironmentService).toHaveBeenCalledWith({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'profile1',
			serviceId: 'svc1',
			kind: 'service'
		});
		expect(mocks.profileUpdateMany).toHaveBeenCalledWith({
			where: { id: 'profile1', organizationId: 'org1', projectId: 'p1' },
			data: { lastPreparedFingerprint: null }
		});
		expect(mocks.notifyProjectEnvironmentPrepare).toHaveBeenCalledWith({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'profile1',
			kind: 'profile'
		});
	});

	it('rejects service env mappings that collide with project env vars', async () => {
		mocks.serviceFindFirst.mockResolvedValueOnce({
			id: 'svc1',
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'profile1',
			kind: 'postgres',
			name: 'database',
			enabled: true,
			status: 'ready',
			updatedAt: serviceUpdatedAt,
			config: {
				image: 'postgres:test',
				password: { encrypted: true, valueEncrypted: 'encrypted:secret' },
				port: 5432
			}
		});
		mocks.envVarFindMany.mockResolvedValueOnce([{ key: 'DATABASE_URL' }]);

		await expect(
			updateProjectEnvironmentServiceEnvMappingsForOrg('org1', {
				projectId: 'p1',
				profileId: 'profile1',
				serviceId: 'svc1',
				envMappings: [{ key: 'DATABASE_URL', template: '${url}', enabled: true, sensitive: 'auto' }]
			})
		).rejects.toThrow('DATABASE_URL is already configured as a project env var');
		expect(mocks.serviceUpdateMany).not.toHaveBeenCalled();
		expect(mocks.profileUpdateMany).not.toHaveBeenCalled();
	});

	it('rejects invalid service env mappings before saving', async () => {
		mocks.serviceFindFirst.mockResolvedValueOnce({
			id: 'svc1',
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'profile1',
			kind: 'postgres',
			name: 'database',
			status: 'ready',
			updatedAt: serviceUpdatedAt,
			config: { image: 'postgres:test' }
		});

		await expect(
			updateProjectEnvironmentServiceEnvMappingsForOrg('org1', {
				projectId: 'p1',
				profileId: 'profile1',
				serviceId: 'svc1',
				envMappings: [{ key: 'BAD', template: '${missing}', enabled: true, sensitive: 'auto' }]
			})
		).rejects.toThrow('references unknown source field missing');
		expect(mocks.serviceUpdateMany).not.toHaveBeenCalled();
		expect(mocks.profileUpdateMany).not.toHaveBeenCalled();
		expect(mocks.notifyProjectEnvironmentService).not.toHaveBeenCalled();
		expect(mocks.notifyProjectEnvironmentPrepare).not.toHaveBeenCalled();
	});

	it('rejects env mapping updates for missing services', async () => {
		mocks.serviceFindFirst.mockResolvedValueOnce(null);

		await expect(
			updateProjectEnvironmentServiceEnvMappingsForOrg('org1', {
				projectId: 'p1',
				profileId: 'profile1',
				serviceId: 'missing',
				envMappings: [{ key: 'DIRECT_URL', template: '${url}', enabled: true, sensitive: 'auto' }]
			})
		).rejects.toThrow('Project environment service not found');

		expect(mocks.serviceUpdateMany).not.toHaveBeenCalled();
		expect(mocks.profileUpdateMany).not.toHaveBeenCalled();
		expect(mocks.notifyProjectEnvironmentService).not.toHaveBeenCalled();
		expect(mocks.notifyProjectEnvironmentPrepare).not.toHaveBeenCalled();
	});

	it('rejects stale service env mapping updates without notifying clients', async () => {
		mocks.serviceFindFirst.mockResolvedValueOnce({
			id: 'svc1',
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'profile1',
			kind: 'postgres',
			name: 'database',
			enabled: true,
			status: 'ready',
			updatedAt: serviceUpdatedAt,
			config: {
				image: 'postgres:test',
				password: { encrypted: true, valueEncrypted: 'encrypted:secret' },
				port: 5432
			}
		});
		mocks.serviceUpdateMany.mockResolvedValueOnce({ count: 0 });

		await expect(
			updateProjectEnvironmentServiceEnvMappingsForOrg('org1', {
				projectId: 'p1',
				profileId: 'profile1',
				serviceId: 'svc1',
				envMappings: [{ key: 'DIRECT_URL', template: '${url}', enabled: true, sensitive: 'auto' }]
			})
		).rejects.toThrow('Project environment service not found');

		expect(mocks.serviceUpdateMany).toHaveBeenCalledWith({
			where: {
				id: 'svc1',
				organizationId: 'org1',
				projectId: 'p1',
				profileId: 'profile1',
				updatedAt: serviceUpdatedAt
			},
			data: {
				config: expect.objectContaining({
					image: 'postgres:test',
					password: { encrypted: true, valueEncrypted: 'encrypted:secret' },
					port: 5432,
					envMappings: [{ key: 'DIRECT_URL', template: '${url}', enabled: true, sensitive: 'auto' }]
				})
			}
		});
		expect(mocks.profileUpdateMany).not.toHaveBeenCalled();
		expect(mocks.notifyProjectEnvironmentService).not.toHaveBeenCalled();
		expect(mocks.notifyProjectEnvironmentPrepare).not.toHaveBeenCalled();
	});
});
