import type { ProjectEnvVar, ProjectEnvironmentService } from '@prisma/client';
import type { ProjectEnvironmentServiceKind } from '$lib/domain/project-environment-service';

export type ServiceOutput =
	| { key: string; value: string; sensitive: false; description?: string }
	| { key: string; valueEncrypted: string; sensitive: true; description?: string };

export type PlainServiceOutput = {
	key: string;
	value: string;
	sensitive: boolean;
	description?: string;
};

export type ServiceEnvMapping = Pick<ProjectEnvVar, 'key' | 'enabled'> & {
	template: string;
	sensitive: 'auto' | ProjectEnvVar['sensitive'];
};

export type ServiceEnvSourceField = Pick<ProjectEnvVar, 'key' | 'sensitive'> & {
	value: string;
	description?: string;
};

export type ResolvedServiceEnvVar = Pick<ProjectEnvVar, 'key' | 'sensitive'> & {
	value: string;
	template: string;
	sourceKeys: string[];
};

type ProviderDefaultsInput = Pick<ProjectEnvironmentService, 'projectId' | 'name'>;

export type ProviderRuntimeInput = Pick<ProjectEnvironmentService, 'projectId' | 'name'> & {
	serviceId: ProjectEnvironmentService['id'];
	containerName: string;
	networkAlias: string;
	config: Record<string, unknown>;
};

type ProviderValidation = {
	warnings: string[];
	errors: string[];
};

export type EnvironmentServiceProvider = {
	kind: ProjectEnvironmentServiceKind;
	version: string;
	defaultName: string;
	defaultConfig(input: ProviderDefaultsInput): Record<string, unknown>;
	validateConfig(config: unknown): ProviderValidation;
	container(input: ProviderRuntimeInput): {
		image: string;
		env: Record<string, string>;
		volumeTarget: string;
		command: string[];
	};
	healthcheck(input: ProviderRuntimeInput): string[];
	buildOutputs(input: ProviderRuntimeInput): PlainServiceOutput[];
	fingerprint(input: ProviderRuntimeInput): Record<string, unknown>;
};
