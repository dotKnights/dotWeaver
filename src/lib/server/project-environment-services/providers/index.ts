import type { ProjectEnvironmentServiceKind } from '$lib/domain/project-environment-service';
import type { EnvironmentServiceProvider } from '$lib/server/project-environment-services/types';
import { postgresProvider } from './postgres';
import { redisProvider } from './redis';

const providers = new Map<ProjectEnvironmentServiceKind, EnvironmentServiceProvider>([
	['postgres', postgresProvider],
	['redis', redisProvider]
]);

export function getEnvironmentServiceProvider(kind: ProjectEnvironmentServiceKind) {
	return providers.get(kind) ?? null;
}

export function listEnvironmentServiceProviders() {
	return [...providers.values()];
}
