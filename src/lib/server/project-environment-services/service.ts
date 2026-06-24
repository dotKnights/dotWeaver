import type { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { env as privateEnv } from '$env/dynamic/private';
import type {
	ProjectEnvironmentServiceEventType,
	ProjectEnvironmentServiceKind
} from '$lib/domain/project-environment-service';
import {
	decryptProjectSecretValue,
	encryptProjectSecretValue
} from '$lib/server/project-agent-config-encryption';
import {
	buildServiceContainerName,
	buildServiceNetworkAlias,
	buildServiceRunArgs,
	buildServiceVolumeName,
	runDockerCommand
} from '$lib/server/project-environment-services/docker';
import { notifyProjectEnvironmentService } from '$lib/server/project-environment-services/notifications';
import { getEnvironmentServiceProvider } from '$lib/server/project-environment-services/providers';
import type {
	EnvironmentServiceProvider,
	PlainServiceOutput,
	ProviderRuntimeInput,
	ServiceOutput
} from '$lib/server/project-environment-services/types';
import { prisma } from '$lib/server/prisma';
import {
	projectEnvironmentServiceCreateSchema,
	projectEnvironmentServiceEnabledSchema
} from '$lib/schemas/project-environment-services';

type ProjectEnvironmentServiceCreateRawInput = z.input<
	typeof projectEnvironmentServiceCreateSchema
>;
type ProjectEnvironmentServiceEnabledRawInput = z.input<
	typeof projectEnvironmentServiceEnabledSchema
>;

const RUNNER_NETWORK = privateEnv.RUNNER_NETWORK || 'bridge';
const HEALTHCHECK_ATTEMPTS = positiveInteger(
	privateEnv.PROJECT_ENVIRONMENT_SERVICE_HEALTHCHECK_ATTEMPTS,
	30
);
const HEALTHCHECK_INTERVAL_MS = nonNegativeInteger(
	privateEnv.PROJECT_ENVIRONMENT_SERVICE_HEALTHCHECK_INTERVAL_MS,
	1000
);
const SENSITIVE_CONFIG_KEY_PATTERN = /password|secret|token|credential/i;
const MAX_EVENT_CREATE_ATTEMPTS = 5;

export class ProjectEnvironmentServiceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectEnvironmentServiceError';
	}
}

type ServiceEventTarget = {
	id: string;
	organizationId: string;
	projectId: string;
	profileId: string;
};

type ServiceRuntimeTarget = ServiceEventTarget & {
	kind: ProjectEnvironmentServiceKind;
	name: string;
	config: unknown;
	enabled: boolean;
	status: string;
};

type EncryptedConfigValue = {
	encrypted: true;
	valueEncrypted: string;
};

function asJson(value: unknown): Prisma.InputJsonValue {
	return value as Prisma.InputJsonValue;
}

function errorMessage(error: unknown): string {
	return String((error as Error)?.message ?? error);
}

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asConfigRecord(value: unknown): Record<string, unknown> {
	if (isRecord(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

function isSensitiveConfigKey(key: string): boolean {
	return SENSITIVE_CONFIG_KEY_PATTERN.test(key);
}

function isEncryptedConfigValue(value: unknown): value is EncryptedConfigValue {
	return isRecord(value) && value.encrypted === true && typeof value.valueEncrypted === 'string';
}

function encryptSensitiveConfigValue(key: string, value: unknown): unknown {
	if (isEncryptedConfigValue(value)) return value;
	if (isSensitiveConfigKey(key) && typeof value === 'string' && value.length > 0) {
		return { encrypted: true, valueEncrypted: encryptProjectSecretValue(value) };
	}
	if (Array.isArray(value)) {
		return value.map((item) => encryptSensitiveConfigValue(key, item));
	}
	if (isRecord(value)) {
		return encryptSensitiveConfig(value);
	}
	return value;
}

function encryptSensitiveConfig(config: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(config).map(([key, value]) => [key, encryptSensitiveConfigValue(key, value)])
	);
}

function decryptStoredConfigValue(value: unknown): unknown {
	if (isRecord(value) && value.encrypted === true) {
		if (!isEncryptedConfigValue(value)) {
			throw new ProjectEnvironmentServiceError('Encrypted service config value is invalid');
		}
		return decryptProjectSecretValue(value.valueEncrypted);
	}
	if (Array.isArray(value)) return value.map(decryptStoredConfigValue);
	if (isRecord(value)) return decryptStoredConfig(value);
	return value;
}

function decryptStoredConfig(config: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(config).map(([key, value]) => [key, decryptStoredConfigValue(value)])
	);
}

function sensitivePublicValue(value: unknown) {
	if (isEncryptedConfigValue(value)) {
		return { sensitive: true, hasValue: value.valueEncrypted.length > 0 };
	}
	if (typeof value === 'string') {
		return { sensitive: true, hasValue: value.length > 0 };
	}
	return { sensitive: true, hasValue: value !== null && value !== undefined };
}

function sanitizeConfigValue(key: string, value: unknown): unknown {
	if (isSensitiveConfigKey(key)) return sensitivePublicValue(value);
	if (isEncryptedConfigValue(value)) return sensitivePublicValue(value);
	if (Array.isArray(value)) return value.map((item) => sanitizeConfigValue(key, item));
	if (isRecord(value)) return sanitizeConfig(value);
	return value;
}

function sanitizeConfig(config: unknown): unknown {
	if (!isRecord(config)) return config;
	return Object.fromEntries(
		Object.entries(config).map(([key, value]) => [key, sanitizeConfigValue(key, value)])
	);
}

function sanitizeOutput(output: unknown): unknown {
	if (!isRecord(output)) return output;
	const description = output.description === undefined ? {} : { description: output.description };
	if (output.sensitive === true) {
		return {
			key: output.key,
			sensitive: true,
			hasValue:
				typeof output.valueEncrypted === 'string'
					? output.valueEncrypted.length > 0
					: output.value !== null && output.value !== undefined,
			...description
		};
	}
	return {
		key: output.key,
		value: output.value,
		sensitive: false,
		...description
	};
}

function sanitizeOutputs(outputs: unknown): unknown {
	if (!Array.isArray(outputs)) return [];
	return outputs.map(sanitizeOutput);
}

function sanitizeServiceForPublic<Service extends { config: unknown; outputs: unknown }>(
	service: Service
): Service {
	return {
		...service,
		config: sanitizeConfig(service.config),
		outputs: sanitizeOutputs(service.outputs)
	};
}

function collectConfigSecretValues(value: unknown, parentKey = ''): string[] {
	if (typeof value === 'string') return isSensitiveConfigKey(parentKey) ? [value] : [];
	if (Array.isArray(value))
		return value.flatMap((item) => collectConfigSecretValues(item, parentKey));
	if (!isRecord(value)) return [];
	return Object.entries(value).flatMap(([key, nested]) => collectConfigSecretValues(nested, key));
}

function redactSecrets(text: string, secrets: string[]): string {
	return secrets
		.filter((secret) => secret.length > 0)
		.sort((a, b) => b.length - a.length)
		.reduce((scrubbed, secret) => scrubbed.split(secret).join('[redacted]'), text);
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

function encryptedOutputs(outputs: PlainServiceOutput[]): ServiceOutput[] {
	return outputs.map((output) => {
		const description = output.description === undefined ? {} : { description: output.description };
		if (output.sensitive) {
			return {
				key: output.key,
				valueEncrypted: encryptProjectSecretValue(output.value),
				sensitive: true,
				...description
			};
		}
		return {
			key: output.key,
			value: output.value,
			sensitive: false,
			...description
		};
	});
}

function outputSummary(outputs: PlainServiceOutput[]) {
	return outputs.map((output) => ({
		key: output.key,
		sensitive: output.sensitive
	}));
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
	return services.map(sanitizeServiceForPublic);
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
		...service,
		kind: service.kind as ProjectEnvironmentServiceKind
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
		await prisma.projectEnvironmentService.updateMany({
			where: { id: target.id },
			data: {
				status: 'ready',
				lastError: null,
				runtime: asJson(runtime),
				outputs: asJson(encryptedOutputs(outputs)),
				lastReadyAt: new Date()
			}
		});
		await notifyServiceChange(target, { kind: 'service' });
		await appendServiceEvent(target, 'result', {
			status: 'succeeded',
			image: containerSpec.image,
			outputs: outputSummary(outputs)
		});
	} catch (error) {
		const message = scrub(errorMessage(error));
		const serviceError =
			error instanceof ProjectEnvironmentServiceError
				? error
				: new ProjectEnvironmentServiceError(message);
		try {
			await appendServiceEvent(target, 'error', { message: scrub(serviceError.message) });
		} catch {
			// Preserve the provisioning error as the reported failure.
		}
		await prisma.projectEnvironmentService.updateMany({
			where: { id: target.id },
			data: { status: 'failed', lastError: scrub(serviceError.message) }
		});
		await notifyServiceChange(target, { kind: 'service' });
		throw serviceError;
	}
}

export async function setProjectEnvironmentServiceEnabledForOrg(
	organizationId: string,
	rawInput: ProjectEnvironmentServiceEnabledRawInput
) {
	const input = projectEnvironmentServiceEnabledSchema.parse(rawInput);
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
