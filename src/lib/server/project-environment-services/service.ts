import type { z } from 'zod';
import {
	asConfigRecord,
	encryptSensitiveConfig,
	sanitizeServiceForPublic,
	sanitizeServiceForPublicWithMappings,
	serviceEnvMappingsFromConfig
} from '$lib/server/project-environment-services/config';
import { ProjectEnvironmentServiceError } from '$lib/server/project-environment-services/errors';
import {
	defaultServiceEnvMappings,
	validateServiceEnvMappings
} from '$lib/server/project-environment-services/env-mapping';
import { assertServiceEnvMappingsDoNotOverrideProjectEnv } from '$lib/server/project-environment-services/env-mapping-guards';
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
import { prisma } from '$lib/server/prisma';
import {
	projectEnvironmentServiceCreateSchema,
	projectEnvironmentServiceEnabledSchema,
	projectEnvironmentServiceEnvMappingsSchema
} from '$lib/schemas/project-environment-services';

export { executeProjectEnvironmentServiceProvision } from '$lib/server/project-environment-services/provisioning';
export { buildProjectEnvironmentServiceOutputsForOrg } from '$lib/server/project-environment-services/outputs';

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
