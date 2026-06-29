import { createHash } from 'node:crypto';
import type { ProjectEnvironmentServiceFingerprintInput } from '$lib/server/project-environments/fingerprint';
import {
	buildServiceContainerName,
	buildServiceNetworkAlias
} from '$lib/server/project-environment-services/docker';
import {
	asConfigRecord,
	decryptStoredConfig,
	defaultServiceEnvMappingsForSources,
	serviceEnvMappingsFromConfig,
	storedOutputs
} from '$lib/server/project-environment-services/config';
import { ProjectEnvironmentServiceError } from '$lib/server/project-environment-services/errors';
import {
	resolveServiceEnvMappings,
	serviceSourceFieldsFromOutputs
} from '$lib/server/project-environment-services/env-mapping';
import { requireProjectEnvironmentProfileForOrg } from '$lib/server/project-environment-services/lifecycle';
import {
	assertValidProviderConfig,
	requireProvider
} from '$lib/server/project-environment-services/provider-utils';
import type { ProviderRuntimeInput } from '$lib/server/project-environment-services/types';
import { prisma } from '$lib/server/prisma';

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
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
