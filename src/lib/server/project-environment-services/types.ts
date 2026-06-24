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

export type ProviderDefaultsInput = {
	projectId: string;
	name: string;
};

export type ProviderRuntimeInput = {
	projectId: string;
	serviceId: string;
	name: string;
	networkAlias: string;
	config: Record<string, unknown>;
};

export type ProviderValidation = {
	warnings: string[];
	errors: string[];
};

export type ProvisionServiceResult = {
	runtime: Record<string, unknown>;
	outputs: PlainServiceOutput[];
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
