import type {
	EnvironmentServiceProvider,
	ProviderRuntimeInput
} from '$lib/server/project-environment-services/types';
import {
	asConfigRecord,
	generatedPassword,
	imageFromConfig,
	imageValidationErrors,
	validPort
} from './common';

const POSTGRES_PROVIDER_VERSION = '1';
const POSTGRES_DEFAULT_IMAGE = 'postgres:17-alpine';

function image(config: Record<string, unknown>): string {
	return imageFromConfig(config, POSTGRES_DEFAULT_IMAGE);
}

function postgresConfig(config: Record<string, unknown>, options?: { generatePassword?: boolean }) {
	return {
		image: image(config),
		database: typeof config.database === 'string' ? config.database : 'app',
		user: typeof config.user === 'string' ? config.user : 'dotweaver',
		password:
			typeof config.password === 'string'
				? config.password
				: options?.generatePassword
					? generatedPassword()
					: '',
		port: validPort(config.port) ? config.port : 5432
	};
}

export const postgresProvider: EnvironmentServiceProvider = {
	kind: 'postgres',
	version: POSTGRES_PROVIDER_VERSION,
	defaultName: 'postgres',
	defaultConfig() {
		return postgresConfig({}, { generatePassword: true });
	},
	validateConfig(config) {
		const record = asConfigRecord(config);
		const parsed = postgresConfig(record);
		const errors: string[] = [];
		if (parsed.database.length === 0 || parsed.user.length === 0 || parsed.password.length === 0) {
			errors.push('Postgres database, user and password are required');
		}
		if (record.port !== undefined && !validPort(record.port)) {
			errors.push('Postgres port must be an integer from 1 to 65535');
		}
		errors.push(...imageValidationErrors(record, 'Postgres'));
		return {
			warnings: [],
			errors
		};
	},
	container(input: ProviderRuntimeInput) {
		const config = postgresConfig(input.config);
		return {
			image: config.image,
			env: {
				POSTGRES_DB: config.database,
				POSTGRES_USER: config.user,
				POSTGRES_PASSWORD: config.password
			},
			volumeTarget: '/var/lib/postgresql/data',
			command: ['postgres', '-p', String(config.port)]
		};
	},
	healthcheck(input) {
		const config = postgresConfig(input.config);
		return [
			'exec',
			input.containerName,
			'pg_isready',
			'-U',
			config.user,
			'-d',
			config.database,
			'-p',
			String(config.port)
		];
	},
	buildOutputs(input) {
		const config = postgresConfig(input.config);
		const host = input.networkAlias;
		const url = `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(
			config.password
		)}@${host}:${config.port}/${encodeURIComponent(config.database)}`;
		return [
			{ key: 'url', value: url, sensitive: true, description: 'Connection URL' },
			{ key: 'protocol', value: 'postgresql', sensitive: false },
			{ key: 'host', value: host, sensitive: false },
			{ key: 'port', value: String(config.port), sensitive: false },
			{ key: 'database', value: config.database, sensitive: false },
			{ key: 'user', value: config.user, sensitive: false },
			{ key: 'password', value: config.password, sensitive: true }
		];
	},
	fingerprint(input) {
		const config = postgresConfig(input.config);
		return {
			kind: 'postgres',
			version: POSTGRES_PROVIDER_VERSION,
			image: config.image,
			database: config.database,
			user: config.user,
			port: config.port
		};
	}
};
