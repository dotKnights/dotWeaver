import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { ProjectEnvironmentServiceFingerprintInput } from '$lib/server/project-environments/fingerprint';
import {
	buildServiceContainerName,
	buildServiceNetworkAlias
} from '$lib/server/project-environment-services/docker';
import {
	asConfigRecord,
	decryptStoredConfig,
	defaultServiceEnvMappingsForSources,
	encryptSensitiveConfig,
	sanitizeServiceForPublic,
	sanitizeServiceForPublicWithMappings,
	serviceEnvMappingsFromConfig,
	storedOutputs
} from '$lib/server/project-environment-services/config';
import { ProjectEnvironmentServiceError } from '$lib/server/project-environment-services/errors';
import {
	defaultServiceEnvMappings,
	resolveServiceEnvMappings,
	serviceSourceFieldsFromOutputs,
	validateServiceEnvMappings
} from '$lib/server/project-environment-services/env-mapping';
import {
	appendServiceEvent,
	markProfileNeedsPrepare,
	notifyServiceChange,
	requireProjectEnvironmentProfileForOrg
} from '$lib/server/project-environment-services/lifecycle';
import {
	assertValidProviderConfig,
	requireProvider
} from '$lib/server/project-environment-services/provider-utils';
import { asJson } from '$lib/server/project-environment-services/prisma-json';
import type {
	ProviderRuntimeInput,
	ServiceEnvMapping
} from '$lib/server/project-environment-services/types';
import { prisma } from '$lib/server/prisma';
import {
	projectEnvironmentServiceCreateSchema,
	projectEnvironmentServiceEnabledSchema,
	projectEnvironmentServiceEnvMappingsSchema
} from '$lib/schemas/project-environment-services';

export { executeProjectEnvironmentServiceProvision } from '$lib/server/project-environment-services/provisioning';

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

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
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
