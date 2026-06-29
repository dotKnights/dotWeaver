import type { ProjectEnvironmentServiceKind } from '@prisma/client';
import {
	decryptProjectSecretValue,
	encryptProjectSecretValue
} from '$lib/server/project-agent-config/encryption';
import {
	defaultServiceEnvMappings,
	extractTemplateFieldNames,
	resolveServiceEnvMappings,
	serviceSourceFieldsFromOutputs
} from '$lib/server/project-environment-services/env-mapping';
import { ProjectEnvironmentServiceError } from '$lib/server/project-environment-services/errors';
import type {
	PlainServiceOutput,
	ServiceEnvMapping,
	ServiceEnvSourceField,
	ServiceOutput
} from '$lib/server/project-environment-services/types';

type EncryptedConfigValue = {
	encrypted: true;
	valueEncrypted: string;
};

const SENSITIVE_CONFIG_KEY_PATTERN = /password|secret|token|credential/i;
const TEMPLATE_PLACEHOLDER_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g;
const TEMPLATE_PROTOCOL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const SAFE_TEMPLATE_LITERAL_RE = /[\s:/@._?&=#%+-]/g;

export function errorMessage(error: unknown): string {
	return String((error as Error)?.message ?? error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asConfigRecord(value: unknown): Record<string, unknown> {
	if (isRecord(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

export function serviceEnvMappingsFromConfig(
	config: Record<string, unknown>
): ServiceEnvMapping[] | null {
	const raw = config.envMappings;
	if (!Array.isArray(raw)) return null;
	return raw.map((mapping) => {
		if (!isRecord(mapping)) {
			return { key: '', template: '', enabled: true, sensitive: 'auto' };
		}
		return {
			key: String(mapping.key ?? ''),
			template: String(mapping.template ?? ''),
			enabled: mapping.enabled !== false,
			sensitive:
				mapping.sensitive === true || mapping.sensitive === false ? mapping.sensitive : 'auto'
		};
	});
}

export function defaultServiceEnvMappingsForSources(
	kind: ProjectEnvironmentServiceKind,
	sources: ServiceEnvSourceField[]
): ServiceEnvMapping[] {
	const sourceKeys = new Set(sources.map((source) => source.key));
	return defaultServiceEnvMappings(kind).filter((mapping) =>
		extractTemplateFieldNames(mapping.template).every((sourceKey) => sourceKeys.has(sourceKey))
	);
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

export function encryptSensitiveConfig(config: Record<string, unknown>): Record<string, unknown> {
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

export function decryptStoredConfig(config: Record<string, unknown>): Record<string, unknown> {
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

export function sanitizeServiceForPublic<Service extends { config: unknown; outputs: unknown }>(
	service: Service
): Service {
	return {
		...service,
		config: sanitizeConfig(service.config),
		outputs: sanitizeOutputs(service.outputs)
	};
}

function sourceFieldSummary(source: PlainServiceOutput) {
	if (source.sensitive) {
		return { key: source.key, sensitive: true, hasValue: source.value.length > 0 };
	}
	return { key: source.key, value: source.value, sensitive: false };
}

function templateHasUnsafeLiteral(template: string): boolean {
	const literal = template
		.replace(TEMPLATE_PLACEHOLDER_RE, '')
		.replace(TEMPLATE_PROTOCOL_RE, '')
		.replace(SAFE_TEMPLATE_LITERAL_RE, '');
	return /[A-Za-z0-9]/.test(literal);
}

function resolvedOutputSummary(
	output: { key: string; value: string; sensitive: boolean },
	mapping?: ServiceEnvMapping
) {
	if (output.sensitive || (mapping && templateHasUnsafeLiteral(mapping.template))) {
		return { key: output.key, sensitive: true, hasValue: output.value.length > 0 };
	}
	return { key: output.key, value: output.value, sensitive: false };
}

function publicMappingSummary(mapping: ServiceEnvMapping) {
	return {
		key: mapping.key,
		template: templateHasUnsafeLiteral(mapping.template) ? '${masked}' : mapping.template,
		enabled: mapping.enabled,
		sensitive: mapping.sensitive
	};
}

function sanitizePublicServiceConfig(config: Record<string, unknown>): unknown {
	const publicConfig = Object.fromEntries(
		Object.entries(config).filter(([key]) => key !== 'envMappings')
	);
	return sanitizeConfig(publicConfig);
}

type PublicServiceFields = {
	config: unknown;
	envMappings: ReturnType<typeof publicMappingSummary>[];
	sourceFields: ReturnType<typeof sourceFieldSummary>[];
	outputs: ReturnType<typeof resolvedOutputSummary>[];
	mappingWarnings: string[];
	mappingErrors: string[];
};

type PublicProjectEnvironmentService<
	Service extends {
		config: unknown;
		outputs: unknown;
	}
> = Omit<Service, 'config' | 'outputs'> & PublicServiceFields;

export function sanitizeServiceForPublicWithMappings<
	Service extends {
		kind: ProjectEnvironmentServiceKind;
		config: unknown;
		outputs: unknown;
	}
>(service: Service): PublicProjectEnvironmentService<Service> {
	const kind = service.kind;
	const config = asConfigRecord(service.config);
	let stored: PlainServiceOutput[] = [];
	const parseErrors: string[] = [];
	try {
		stored = storedOutputs(service.outputs);
	} catch (error) {
		parseErrors.push(`Service outputs could not be read: ${errorMessage(error)}`);
	}
	const sources = parseErrors.length > 0 ? [] : serviceSourceFieldsFromOutputs(kind, stored);
	const mappings =
		serviceEnvMappingsFromConfig(config) ?? defaultServiceEnvMappingsForSources(kind, sources);
	const resolved =
		mappings.length === 0
			? { env: [], errors: [], warnings: [] }
			: resolveServiceEnvMappings({ kind, sources, mappings });
	const enabledMappingsByKey = new Map(
		mappings.filter((mapping) => mapping.enabled).map((mapping) => [mapping.key, mapping])
	);
	return {
		...service,
		config: sanitizePublicServiceConfig(config),
		envMappings: mappings.map(publicMappingSummary),
		sourceFields: sources.map(sourceFieldSummary),
		outputs: resolved.env.map((output) =>
			resolvedOutputSummary(output, enabledMappingsByKey.get(output.key))
		),
		mappingWarnings: resolved.warnings,
		mappingErrors: [...parseErrors, ...resolved.errors]
	};
}

export function collectConfigSecretValues(value: unknown, parentKey = ''): string[] {
	if (typeof value === 'string') return isSensitiveConfigKey(parentKey) ? [value] : [];
	if (Array.isArray(value))
		return value.flatMap((item) => collectConfigSecretValues(item, parentKey));
	if (!isRecord(value)) return [];
	return Object.entries(value).flatMap(([key, nested]) => collectConfigSecretValues(nested, key));
}

export function redactSecrets(text: string, secrets: string[]): string {
	return secrets
		.filter((secret) => secret.length > 0)
		.sort((a, b) => b.length - a.length)
		.reduce((scrubbed, secret) => scrubbed.split(secret).join('[redacted]'), text);
}

export function encryptedOutputs(outputs: PlainServiceOutput[]): ServiceOutput[] {
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

function storedOutputValue(output: Record<string, unknown>): PlainServiceOutput {
	if (typeof output.key !== 'string' || output.key.length === 0) {
		throw new ProjectEnvironmentServiceError('Service output key is invalid');
	}
	if (output.sensitive === true) {
		if (typeof output.valueEncrypted === 'string') {
			return {
				key: output.key,
				value: decryptProjectSecretValue(output.valueEncrypted),
				sensitive: true
			};
		}
		if (typeof output.value === 'string') {
			return { key: output.key, value: output.value, sensitive: true };
		}
		throw new ProjectEnvironmentServiceError(`Sensitive service output ${output.key} is invalid`);
	}
	if (output.sensitive === false && typeof output.value === 'string') {
		return { key: output.key, value: output.value, sensitive: false };
	}
	throw new ProjectEnvironmentServiceError(`Service output ${output.key} is invalid`);
}

export function storedOutputs(outputs: unknown): PlainServiceOutput[] {
	if (!Array.isArray(outputs)) return [];
	return outputs
		.map((output) => {
			if (!isRecord(output)) {
				throw new ProjectEnvironmentServiceError('Service output is invalid');
			}
			return storedOutputValue(output);
		})
		.sort((a, b) => a.key.localeCompare(b.key));
}
