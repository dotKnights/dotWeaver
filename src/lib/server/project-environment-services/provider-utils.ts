import type { ProjectEnvironmentServiceKind } from '@prisma/client';
import { ProjectEnvironmentServiceError } from '$lib/server/project-environment-services/errors';
import { getEnvironmentServiceProvider } from '$lib/server/project-environment-services/providers';
import type { EnvironmentServiceProvider } from '$lib/server/project-environment-services/types';

export function requireProvider(kind: ProjectEnvironmentServiceKind): EnvironmentServiceProvider {
	const provider = getEnvironmentServiceProvider(kind);
	if (!provider)
		throw new ProjectEnvironmentServiceError(`Environment service provider ${kind} not found`);
	return provider;
}

export function assertValidProviderConfig(
	provider: EnvironmentServiceProvider,
	config: unknown,
	context: string
): void {
	const validation = provider.validateConfig(config);
	if (validation.errors.length > 0) {
		throw new ProjectEnvironmentServiceError(`${context}: ${validation.errors.join('; ')}`);
	}
}
