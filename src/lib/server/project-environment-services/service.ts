import type {
	Prisma,
	ProjectEnvironmentService,
	ProjectEnvironmentServiceEventType,
	ProjectEnvironmentServiceKind
} from '@prisma/client';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { env as privateEnv } from '$env/dynamic/private';
import { ensureDockerNetwork, resolveRunnerNetwork } from '$lib/server/runtime/docker-network';
import type { ProjectEnvironmentServiceFingerprintInput } from '$lib/server/project-environments/fingerprint';
import {
	buildServiceContainerName,
	buildServiceNetworkAlias,
	buildServiceRunArgs,
	buildServiceVolumeName,
	runDockerCommand
} from '$lib/server/project-environment-services/docker';
import {
	asConfigRecord,
	collectConfigSecretValues,
	decryptStoredConfig,
	defaultServiceEnvMappingsForSources,
	encryptedOutputs,
	encryptSensitiveConfig,
	errorMessage,
	isRecord,
	redactSecrets,
	sanitizeServiceForPublic,
	sanitizeServiceForPublicWithMappings,
	serviceEnvMappingsFromConfig,
	storedOutputs
} from '$lib/server/project-environment-services/config';
import { ProjectEnvironmentServiceError } from '$lib/server/project-environment-services/errors';
import { notifyProjectEnvironmentService } from '$lib/server/project-environment-services/notifications';
import { notifyProjectEnvironmentPrepare } from '$lib/server/project-environments/notifications';
import { getEnvironmentServiceProvider } from '$lib/server/project-environment-services/providers';
import {
	defaultServiceEnvMappings,
	resolveServiceEnvMappings,
	serviceSourceFieldsFromOutputs,
	validateServiceEnvMappings
} from '$lib/server/project-environment-services/env-mapping';
import type {
	EnvironmentServiceProvider,
	PlainServiceOutput,
	ProviderRuntimeInput,
	ServiceEnvMapping
} from '$lib/server/project-environment-services/types';
import { prisma } from '$lib/server/prisma';
import {
	projectEnvironmentServiceCreateSchema,
	projectEnvironmentServiceEnabledSchema,
	projectEnvironmentServiceEnvMappingsSchema
} from '$lib/schemas/project-environment-services';

type ProjectEnvironmentServiceCreateRawInput = z.input<
	typeof projectEnvironmentServiceCreateSchema
>;
type ProjectEnvironmentServiceEnabledRawInput = z.input<
	typeof projectEnvironmentServiceEnabledSchema
>;
type ProjectEnvironmentServiceEnvMappingsRawInput = z.input<
	typeof projectEnvironmentServiceEnvMappingsSchema
>;

export { ProjectEnvironmentServiceError } from '$lib/server/project-environment-services/errors';

const RUNNER_NETWORK = resolveRunnerNetwork(privateEnv.RUNNER_NETWORK);
const HEALTHCHECK_ATTEMPTS = positiveInteger(
	privateEnv.PROJECT_ENVIRONMENT_SERVICE_HEALTHCHECK_ATTEMPTS,
	30
);
const HEALTHCHECK_INTERVAL_MS = nonNegativeInteger(
	privateEnv.PROJECT_ENVIRONMENT_SERVICE_HEALTHCHECK_INTERVAL_MS,
	1000
);
const MAX_EVENT_CREATE_ATTEMPTS = 5;

type ServiceEventTarget = Pick<
	ProjectEnvironmentService,
	'id' | 'organizationId' | 'projectId' | 'profileId'
>;

type ServiceRuntimeTarget = ServiceEventTarget &
	Pick<ProjectEnvironmentService, 'kind' | 'name' | 'config' | 'enabled' | 'status'>;

function asJson(value: unknown): Prisma.InputJsonValue {
	return value as Prisma.InputJsonValue;
}

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

async function assertServiceEnvMappingsDoNotOverrideProjectEnv(input: {
	organizationId: string;
	projectId: string;
	serviceName: string;
	mappings: ServiceEnvMapping[];
}): Promise<void> {
	const keys = [
		...new Set(
			input.mappings
				.filter((mapping) => mapping.enabled)
				.map((mapping) => mapping.key)
				.filter(Boolean)
		)
	];
	if (keys.length === 0) return;
	const envVars = await prisma.projectEnvVar.findMany({
		where: {
			organizationId: input.organizationId,
			projectId: input.projectId,
			enabled: true,
			key: { in: keys }
		},
		select: { key: true },
		orderBy: { key: 'asc' }
	});
	if (envVars.length === 0) return;
	const key = envVars[0].key;
	throw new ProjectEnvironmentServiceError(
		`${key} is already configured as a project env var. Remove or rename it before using ${input.serviceName} service mappings with the same key.`
	);
}

function sleep(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requireProjectEnvironmentProfileForOrg(
	organizationId: string,
	projectId: string,
	profileId: string
) {
	const profile = await prisma.projectEnvironmentProfile.findFirst({
		where: { id: profileId, projectId, organizationId },
		select: { id: true, projectId: true, organizationId: true }
	});
	if (!profile) throw new ProjectEnvironmentServiceError('Project environment profile not found');
	return profile;
}

function requireProvider(kind: ProjectEnvironmentServiceKind): EnvironmentServiceProvider {
	const provider = getEnvironmentServiceProvider(kind);
	if (!provider)
		throw new ProjectEnvironmentServiceError(`Environment service provider ${kind} not found`);
	return provider;
}

function assertValidProviderConfig(
	provider: EnvironmentServiceProvider,
	config: unknown,
	context: string
): void {
	const validation = provider.validateConfig(config);
	if (validation.errors.length > 0) {
		throw new ProjectEnvironmentServiceError(`${context}: ${validation.errors.join('; ')}`);
	}
}

async function notifyServiceChange(
	service: ServiceEventTarget,
	change: { kind: 'event'; seq: number } | { kind: 'service' }
): Promise<void> {
	try {
		await notifyProjectEnvironmentService({
			organizationId: service.organizationId,
			projectId: service.projectId,
			profileId: service.profileId,
			serviceId: service.id,
			...change
		});
	} catch {
		// Live notifications are best-effort; persisted DB state remains authoritative.
	}
}

async function markProfileNeedsPrepare(profile: {
	organizationId: string;
	projectId: string;
	profileId: string;
}): Promise<void> {
	const result = await prisma.projectEnvironmentProfile.updateMany({
		where: {
			id: profile.profileId,
			organizationId: profile.organizationId,
			projectId: profile.projectId
		},
		data: { lastPreparedFingerprint: null }
	});
	if (result.count === 0) return;
	try {
		await notifyProjectEnvironmentPrepare({
			organizationId: profile.organizationId,
			projectId: profile.projectId,
			profileId: profile.profileId,
			kind: 'profile'
		});
	} catch {
		// Live notifications are best-effort; persisted DB state remains authoritative.
	}
}

async function appendServiceEvent(
	service: ServiceEventTarget,
	type: ProjectEnvironmentServiceEventType,
	payload: unknown
): Promise<number> {
	for (let attempt = 0; attempt < MAX_EVENT_CREATE_ATTEMPTS; attempt += 1) {
		const aggregate = await prisma.projectEnvironmentServiceEvent.aggregate({
			where: { serviceId: service.id },
			_max: { seq: true }
		});
		const seq = (aggregate._max.seq ?? -1) + 1;
		try {
			await prisma.projectEnvironmentServiceEvent.create({
				data: {
					serviceId: service.id,
					projectId: service.projectId,
					organizationId: service.organizationId,
					seq,
					type,
					payload: asJson(payload)
				}
			});
			await notifyServiceChange(service, { kind: 'event', seq });
			return seq;
		} catch (error) {
			if (isRecord(error) && error.code === 'P2002' && attempt < MAX_EVENT_CREATE_ATTEMPTS - 1) {
				continue;
			}
			throw error;
		}
	}
	throw new ProjectEnvironmentServiceError('Could not append project environment service event');
}

function outputSummary(outputs: PlainServiceOutput[]) {
	return outputs.map((output) => ({
		key: output.key,
		sensitive: output.sensitive
	}));
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function buildRuntime(input: {
	provider: EnvironmentServiceProvider;
	providerInput: ProviderRuntimeInput;
	containerSpec: ReturnType<EnvironmentServiceProvider['container']>;
	volumeName: string;
}) {
	return {
		containerName: input.providerInput.containerName,
		volumeName: input.volumeName,
		networkAlias: input.providerInput.networkAlias,
		image: input.containerSpec.image,
		provider: {
			kind: input.provider.kind,
			version: input.provider.version
		},
		fingerprint: input.provider.fingerprint(input.providerInput)
	};
}

async function runHealthcheckWithRetry(args: string[]): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < HEALTHCHECK_ATTEMPTS; attempt += 1) {
		try {
			await runDockerCommand(args);
			return;
		} catch (error) {
			lastError = error;
			if (attempt < HEALTHCHECK_ATTEMPTS - 1) {
				await sleep(HEALTHCHECK_INTERVAL_MS);
			}
		}
	}
	throw lastError;
}

export async function listProjectEnvironmentServicesForOrg(
	organizationId: string,
	projectId: string,
	profileId: string
) {
	await requireProjectEnvironmentProfileForOrg(organizationId, projectId, profileId);
	const services = await prisma.projectEnvironmentService.findMany({
		where: { organizationId, projectId, profileId },
		orderBy: { name: 'asc' }
	});
	return services.map(sanitizeServiceForPublicWithMappings);
}

export async function requireProjectEnvironmentServiceForOrg(
	organizationId: string,
	projectId: string,
	serviceId: string
): Promise<{ id: string; profileId: string }> {
	const service = await prisma.projectEnvironmentService.findFirst({
		where: { id: serviceId, organizationId, projectId },
		select: { id: true, profileId: true }
	});
	if (!service) throw new ProjectEnvironmentServiceError('Project environment service not found');
	return service;
}

export async function buildProjectEnvironmentServiceOutputsForOrg(
	organizationId: string,
	projectId: string,
	profileId: string
): Promise<{
	env: Array<{ key: string; value: string; sensitive: boolean }>;
	warnings: string[];
	fingerprintInputs: ProjectEnvironmentServiceFingerprintInput[];
}> {
	await requireProjectEnvironmentProfileForOrg(organizationId, projectId, profileId);
	const services = await prisma.projectEnvironmentService.findMany({
		where: { organizationId, projectId, profileId },
		orderBy: [{ kind: 'asc' }, { name: 'asc' }],
		select: {
			id: true,
			kind: true,
			name: true,
			enabled: true,
			status: true,
			config: true,
			outputs: true
		}
	});
	const env: Array<{ key: string; value: string; sensitive: boolean }> = [];
	const warnings: string[] = [];
	const fingerprintInputs: ProjectEnvironmentServiceFingerprintInput[] = [];

	for (const service of services) {
		if (!service.enabled || service.status === 'disabled') continue;
		if (service.status !== 'ready') {
			warnings.push(
				`Project environment service ${service.name} is ${service.status}; prepare will not include its env vars`
			);
			continue;
		}

		const kind = service.kind;
		const provider = requireProvider(kind);
		const config = decryptStoredConfig(asConfigRecord(service.config));
		assertValidProviderConfig(provider, config, `${kind} service config is invalid`);
		const providerInput: ProviderRuntimeInput = {
			projectId,
			serviceId: service.id,
			name: service.name,
			containerName: buildServiceContainerName(projectId, profileId, service.name),
			networkAlias: buildServiceNetworkAlias(projectId, profileId, service.name),
			config
		};
		const outputs = storedOutputs(service.outputs);
		const sources = serviceSourceFieldsFromOutputs(kind, outputs);
		const mappings =
			serviceEnvMappingsFromConfig(config) ?? defaultServiceEnvMappingsForSources(kind, sources);
		const resolved =
			mappings.length === 0
				? { env: [], errors: [], warnings: [] }
				: resolveServiceEnvMappings({
						kind,
						sources,
						mappings
					});
		if (resolved.errors.length > 0) {
			throw new ProjectEnvironmentServiceError(resolved.errors.join('; '));
		}
		const resolvedEnv = [...resolved.env].sort((a, b) => a.key.localeCompare(b.key));
		env.push(
			...resolvedEnv.map((output) => ({
				key: output.key,
				value: output.value,
				sensitive: output.sensitive
			}))
		);
		warnings.push(...resolved.warnings);
		fingerprintInputs.push({
			kind,
			name: service.name,
			enabled: service.enabled,
			status: service.status,
			providerVersion: provider.version,
			config: provider.fingerprint(providerInput),
			outputKeys: resolvedEnv.map((output) => output.key),
			outputValueHashes: resolvedEnv.map((output) => sha256(output.value))
		});
	}

	return {
		env: env.sort((a, b) => a.key.localeCompare(b.key)),
		warnings,
		fingerprintInputs
	};
}

export async function createProjectEnvironmentServiceForOrg(
	organizationId: string,
	createdById: string,
	rawInput: ProjectEnvironmentServiceCreateRawInput
) {
	const input = projectEnvironmentServiceCreateSchema.parse(rawInput);
	await requireProjectEnvironmentProfileForOrg(organizationId, input.projectId, input.profileId);
	const provider = requireProvider(input.kind);
	const config = provider.defaultConfig({ projectId: input.projectId, name: input.name });
	assertValidProviderConfig(provider, config, `Default ${input.kind} service config is invalid`);
	await assertServiceEnvMappingsDoNotOverrideProjectEnv({
		organizationId,
		projectId: input.projectId,
		serviceName: input.name,
		mappings: defaultServiceEnvMappings(input.kind)
	});
	const persistedConfig = encryptSensitiveConfig(config);

	const service = await prisma.projectEnvironmentService.create({
		data: {
			organizationId,
			projectId: input.projectId,
			profileId: input.profileId,
			kind: input.kind,
			name: input.name,
			enabled: true,
			status: 'configured',
			config: asJson(persistedConfig),
			outputs: asJson([]),
			runtime: asJson({}),
			createdById
		}
	});
	await markProfileNeedsPrepare(service);
	await notifyServiceChange(service, { kind: 'service' });
	await appendServiceEvent(service, 'system', {
		text: `Configured ${input.kind} service ${input.name}`
	});
	return sanitizeServiceForPublic(service);
}

export async function executeProjectEnvironmentServiceProvision(input: {
	serviceId: string;
}): Promise<void> {
	const service = await prisma.projectEnvironmentService.findFirst({
		where: { id: input.serviceId },
		select: {
			id: true,
			organizationId: true,
			projectId: true,
			profileId: true,
			kind: true,
			name: true,
			config: true,
			enabled: true,
			status: true
		}
	});
	if (!service) throw new ProjectEnvironmentServiceError('Project environment service not found');

	const target: ServiceRuntimeTarget = {
		...service
	};
	if (!target.enabled || target.status === 'disabled') {
		throw new ProjectEnvironmentServiceError('Project environment service is disabled');
	}

	const provider = requireProvider(target.kind);
	const config = decryptStoredConfig(asConfigRecord(target.config));
	assertValidProviderConfig(provider, config, `${target.kind} service config is invalid`);
	const containerName = buildServiceContainerName(target.projectId, target.profileId, target.name);
	const volumeName = buildServiceVolumeName(target.projectId, target.profileId, target.name);
	const networkAlias = buildServiceNetworkAlias(target.projectId, target.profileId, target.name);
	const providerInput: ProviderRuntimeInput = {
		projectId: target.projectId,
		serviceId: target.id,
		name: target.name,
		containerName,
		networkAlias,
		config
	};
	const containerSpec = provider.container(providerInput);
	const claim = await prisma.projectEnvironmentService.updateMany({
		where: { id: target.id, enabled: true, status: { not: 'provisioning' } },
		data: { status: 'provisioning', lastError: null }
	});
	if (claim.count === 0) {
		throw new ProjectEnvironmentServiceError('Project environment service is already provisioning');
	}
	const scrub = (message: string) => redactSecrets(message, collectConfigSecretValues(config));

	try {
		await notifyServiceChange(target, { kind: 'service' });
		await appendServiceEvent(target, 'system', {
			text: `Provisioning ${target.kind} service ${target.name}`
		});

		await runDockerCommand(['volume', 'create', volumeName]);
		try {
			await runDockerCommand(['rm', '-f', containerName]);
		} catch {
			// Removing a non-existing container should not fail provisioning.
		}
		await ensureDockerNetwork(RUNNER_NETWORK);
		await runDockerCommand(
			buildServiceRunArgs({
				image: containerSpec.image,
				containerName,
				network: RUNNER_NETWORK,
				networkAlias,
				volumeName,
				volumeTarget: containerSpec.volumeTarget,
				env: containerSpec.env,
				command: containerSpec.command
			})
		);
		await runHealthcheckWithRetry(provider.healthcheck(providerInput));

		const outputs = provider.buildOutputs(providerInput);
		const runtime = buildRuntime({ provider, providerInput, containerSpec, volumeName });
		const readyUpdate = await prisma.projectEnvironmentService.updateMany({
			where: { id: target.id, enabled: true, status: 'provisioning' },
			data: {
				status: 'ready',
				lastError: null,
				runtime: asJson(runtime),
				outputs: asJson(encryptedOutputs(outputs)),
				lastReadyAt: new Date()
			}
		});
		if (readyUpdate.count > 0) {
			await markProfileNeedsPrepare(target);
			await notifyServiceChange(target, { kind: 'service' });
			await appendServiceEvent(target, 'result', {
				status: 'succeeded',
				image: containerSpec.image,
				outputs: outputSummary(outputs)
			});
		}
	} catch (error) {
		const message = scrub(errorMessage(error));
		const serviceError =
			error instanceof ProjectEnvironmentServiceError
				? error
				: new ProjectEnvironmentServiceError(message);
		const failedUpdate = await prisma.projectEnvironmentService.updateMany({
			where: { id: target.id, enabled: true, status: 'provisioning' },
			data: { status: 'failed', lastError: scrub(serviceError.message) }
		});
		if (failedUpdate.count > 0) {
			try {
				await appendServiceEvent(target, 'error', { message: scrub(serviceError.message) });
			} catch {
				// Preserve the provisioning error as the reported failure.
			}
			await notifyServiceChange(target, { kind: 'service' });
		}
		throw serviceError;
	}
}

export async function setProjectEnvironmentServiceEnabledForOrg(
	organizationId: string,
	rawInput: ProjectEnvironmentServiceEnabledRawInput
) {
	const input = projectEnvironmentServiceEnabledSchema.parse(rawInput);
	if (input.enabled) {
		const service = await prisma.projectEnvironmentService.findFirst({
			where: {
				id: input.serviceId,
				organizationId,
				projectId: input.projectId,
				profileId: input.profileId
			},
			select: { kind: true, name: true, config: true }
		});
		if (!service) throw new ProjectEnvironmentServiceError('Project environment service not found');
		const kind = service.kind;
		await assertServiceEnvMappingsDoNotOverrideProjectEnv({
			organizationId,
			projectId: input.projectId,
			serviceName: service.name,
			mappings:
				serviceEnvMappingsFromConfig(asConfigRecord(service.config)) ??
				defaultServiceEnvMappings(kind)
		});
	}
	const result = await prisma.projectEnvironmentService.updateMany({
		where: {
			id: input.serviceId,
			organizationId,
			projectId: input.projectId,
			profileId: input.profileId
		},
		data: {
			enabled: input.enabled,
			status: input.enabled ? 'configured' : 'disabled'
		}
	});
	if (result.count === 0) {
		throw new ProjectEnvironmentServiceError('Project environment service not found');
	}
	await markProfileNeedsPrepare({
		organizationId,
		projectId: input.projectId,
		profileId: input.profileId
	});
	await notifyServiceChange(
		{
			id: input.serviceId,
			organizationId,
			projectId: input.projectId,
			profileId: input.profileId
		},
		{ kind: 'service' }
	);
}

export async function updateProjectEnvironmentServiceEnvMappingsForOrg(
	organizationId: string,
	rawInput: ProjectEnvironmentServiceEnvMappingsRawInput
) {
	const input = projectEnvironmentServiceEnvMappingsSchema.parse(rawInput);
	const service = await prisma.projectEnvironmentService.findFirst({
		where: {
			id: input.serviceId,
			organizationId,
			projectId: input.projectId,
			profileId: input.profileId
		},
		select: {
			id: true,
			name: true,
			kind: true,
			config: true,
			projectId: true,
			organizationId: true,
			updatedAt: true
		}
	});
	if (!service) throw new ProjectEnvironmentServiceError('Project environment service not found');

	const kind = service.kind;
	const validation = validateServiceEnvMappings(kind, input.envMappings);
	if (validation.errors.length > 0) {
		throw new ProjectEnvironmentServiceError(validation.errors.join('; '));
	}
	await assertServiceEnvMappingsDoNotOverrideProjectEnv({
		organizationId,
		projectId: input.projectId,
		serviceName: service.name,
		mappings: input.envMappings
	});

	const config = asConfigRecord(service.config);
	const nextConfig = {
		...config,
		envMappings: input.envMappings
	};
	const result = await prisma.projectEnvironmentService.updateMany({
		where: {
			id: input.serviceId,
			organizationId,
			projectId: input.projectId,
			profileId: input.profileId,
			updatedAt: service.updatedAt
		},
		data: { config: asJson(nextConfig) }
	});
	if (result.count === 0) {
		throw new ProjectEnvironmentServiceError('Project environment service not found');
	}
	await markProfileNeedsPrepare({
		organizationId,
		projectId: input.projectId,
		profileId: input.profileId
	});
	await notifyServiceChange(
		{
			id: input.serviceId,
			organizationId,
			projectId: input.projectId,
			profileId: input.profileId
		},
		{ kind: 'service' }
	);
	return { updated: true };
}
