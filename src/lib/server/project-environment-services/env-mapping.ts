import type { ProjectEnvironmentServiceKind } from '$lib/domain/project-environment-service';
import type {
	PlainServiceOutput,
	ResolvedServiceEnvVar,
	ServiceEnvMapping,
	ServiceEnvSourceField
} from '$lib/server/project-environment-services/types';

const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TEMPLATE_FIELD_REGEX = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const SOURCE_FIELD_KEYS = {
	postgres: ['url', 'protocol', 'host', 'port', 'database', 'user', 'password'],
	redis: ['url', 'protocol', 'host', 'port', 'password']
} satisfies Record<ProjectEnvironmentServiceKind, string[]>;

const SENSITIVE_SOURCE_KEYS = {
	postgres: new Set(['url', 'password']),
	redis: new Set(['url', 'password'])
} satisfies Record<ProjectEnvironmentServiceKind, Set<string>>;

const LEGACY_OUTPUT_ALIASES = {
	postgres: {
		DATABASE_URL: 'url',
		POSTGRES_HOST: 'host',
		POSTGRES_PORT: 'port',
		POSTGRES_DB: 'database',
		POSTGRES_USER: 'user',
		POSTGRES_PASSWORD: 'password'
	},
	redis: {
		REDIS_URL: 'url',
		REDIS_HOST: 'host',
		REDIS_PORT: 'port',
		REDIS_PASSWORD: 'password'
	}
} satisfies Record<ProjectEnvironmentServiceKind, Record<string, string>>;

const DEFAULT_SERVICE_ENV_MAPPINGS = {
	postgres: [
		{ key: 'DATABASE_URL', template: '${url}', enabled: true, sensitive: 'auto' },
		{ key: 'POSTGRES_HOST', template: '${host}', enabled: true, sensitive: 'auto' },
		{ key: 'POSTGRES_PORT', template: '${port}', enabled: true, sensitive: 'auto' },
		{ key: 'POSTGRES_DB', template: '${database}', enabled: true, sensitive: 'auto' },
		{ key: 'POSTGRES_USER', template: '${user}', enabled: true, sensitive: 'auto' },
		{ key: 'POSTGRES_PASSWORD', template: '${password}', enabled: true, sensitive: 'auto' }
	],
	redis: [
		{ key: 'REDIS_URL', template: '${url}', enabled: true, sensitive: 'auto' },
		{ key: 'REDIS_HOST', template: '${host}', enabled: true, sensitive: 'auto' },
		{ key: 'REDIS_PORT', template: '${port}', enabled: true, sensitive: 'auto' },
		{ key: 'REDIS_PASSWORD', template: '${password}', enabled: true, sensitive: 'auto' }
	]
} satisfies Record<ProjectEnvironmentServiceKind, ServiceEnvMapping[]>;

export type ServiceEnvMappingValidation = {
	errors: string[];
	warnings: string[];
};

export type ResolveServiceEnvMappingsInput = {
	kind: ProjectEnvironmentServiceKind;
	sources: ServiceEnvSourceField[];
	mappings?: ServiceEnvMapping[] | null;
	manualEnvKeys?: string[];
};

export type ResolveServiceEnvMappingsResult = {
	env: ResolvedServiceEnvVar[];
	errors: string[];
	warnings: string[];
};

export function defaultServiceEnvMappings(
	kind: ProjectEnvironmentServiceKind
): ServiceEnvMapping[] {
	return DEFAULT_SERVICE_ENV_MAPPINGS[kind].map((mapping) => ({ ...mapping }));
}

export function sourceFieldKeys(kind: ProjectEnvironmentServiceKind): string[] {
	return [...SOURCE_FIELD_KEYS[kind]];
}

export function extractTemplateFieldNames(template: string): string[] {
	const fields: string[] = [];
	const seen = new Set<string>();
	for (const match of template.matchAll(TEMPLATE_FIELD_REGEX)) {
		const field = match[1];
		if (!seen.has(field)) {
			seen.add(field);
			fields.push(field);
		}
	}
	return fields;
}

export function validateServiceEnvMappings(
	kind: ProjectEnvironmentServiceKind,
	mappings: ServiceEnvMapping[]
): ServiceEnvMappingValidation {
	const errors: string[] = [];
	const sourceKeys = new Set(SOURCE_FIELD_KEYS[kind]);
	const sensitiveKeys = SENSITIVE_SOURCE_KEYS[kind];
	const seenKeys = new Set<string>();

	for (const mapping of mappings) {
		if (!mapping.enabled) continue;

		if (!ENV_KEY_REGEX.test(mapping.key)) {
			errors.push(`Mapping ${mapping.key} has an invalid env var name`);
		}
		if (mapping.template.trim().length === 0) {
			errors.push(`Mapping ${mapping.key} has an empty template`);
		}
		if (seenKeys.has(mapping.key)) {
			errors.push(`Mapping ${mapping.key} is duplicated`);
		}
		seenKeys.add(mapping.key);

		for (const field of extractTemplateFieldNames(mapping.template)) {
			if (!sourceKeys.has(field)) {
				errors.push(`Mapping ${mapping.key} references unknown source field ${field}`);
			} else if (mapping.sensitive === false && sensitiveKeys.has(field)) {
				errors.push(
					`Mapping ${mapping.key} uses sensitive source ${field} and cannot be marked non-sensitive`
				);
			}
		}
	}

	return { errors, warnings: [] };
}

export function serviceSourceFieldsFromOutputs(
	kind: ProjectEnvironmentServiceKind,
	outputs: PlainServiceOutput[]
): ServiceEnvSourceField[] {
	const aliases = LEGACY_OUTPUT_ALIASES[kind];
	const sourceKeys = new Set(SOURCE_FIELD_KEYS[kind]);
	const sensitiveKeys = SENSITIVE_SOURCE_KEYS[kind];
	const sources: ServiceEnvSourceField[] = [];
	const seen = new Set<string>();

	for (const output of outputs) {
		const key = aliases[output.key] ?? output.key;
		if (!sourceKeys.has(key) || seen.has(key)) continue;
		seen.add(key);
		sources.push({
			key,
			value: output.value,
			sensitive: output.sensitive || sensitiveKeys.has(key),
			description: output.description
		});
	}

	return sources;
}

export function resolveServiceEnvMappings(
	input: ResolveServiceEnvMappingsInput
): ResolveServiceEnvMappingsResult {
	const mappings =
		input.mappings && input.mappings.length > 0
			? input.mappings
			: defaultServiceEnvMappings(input.kind);
	const validation = validateServiceEnvMappings(input.kind, mappings);
	if (validation.errors.length > 0) {
		return { env: [], errors: validation.errors, warnings: validation.warnings };
	}

	const enabledMappings = mappings.filter((mapping) => mapping.enabled);
	const sourcesByKey = new Map(input.sources.map((source) => [source.key, source]));
	const manualEnvKeys = new Set(input.manualEnvKeys ?? []);
	const errors: string[] = [];
	const warnings: string[] = [];
	const env: ResolvedServiceEnvVar[] = [];

	for (const mapping of enabledMappings) {
		const sourceKeys = extractTemplateFieldNames(mapping.template);
		for (const sourceKey of sourceKeys) {
			if (!sourcesByKey.has(sourceKey)) {
				errors.push(`Mapping ${mapping.key} references missing source field ${sourceKey}`);
			}
		}
		if (errors.length > 0) continue;

		const value = mapping.template.replace(TEMPLATE_FIELD_REGEX, (_match, field: string) => {
			return sourcesByKey.get(field)?.value ?? '';
		});
		const sensitive =
			mapping.sensitive === 'auto'
				? sourceKeys.some((sourceKey) => sourcesByKey.get(sourceKey)?.sensitive)
				: mapping.sensitive;
		env.push({
			key: mapping.key,
			value,
			sensitive,
			template: mapping.template,
			sourceKeys
		});

		if (manualEnvKeys.has(mapping.key)) {
			warnings.push(`Generated env ${mapping.key} is overridden by a manual project env var`);
		}
	}

	if (errors.length > 0) {
		return { env: [], errors, warnings: validation.warnings };
	}

	return { env, errors, warnings };
}
