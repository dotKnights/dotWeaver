import { ProjectEnvironmentServiceError } from '$lib/server/project-environment-services/errors';
import type { ServiceEnvMapping } from '$lib/server/project-environment-services/types';
import { prisma } from '$lib/server/prisma';

export async function assertServiceEnvMappingsDoNotOverrideProjectEnv(input: {
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
