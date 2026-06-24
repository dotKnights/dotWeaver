import { randomBytes } from 'node:crypto';
import type {
	EnvironmentServiceProvider,
	ProviderRuntimeInput
} from '$lib/server/project-environment-services/types';

function password() {
	return randomBytes(24).toString('base64url');
}

function asConfigRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

function validPort(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
}

function postgresConfig(config: Record<string, unknown>, options?: { generatePassword?: boolean }) {
	return {
		image: typeof config.image === 'string' ? config.image : 'postgres:17-alpine',
		database: typeof config.database === 'string' ? config.database : 'app',
		user: typeof config.user === 'string' ? config.user : 'dotweaver',
		password:
			typeof config.password === 'string'
				? config.password
				: options?.generatePassword
					? password()
					: '',
		port: validPort(config.port) ? config.port : 5432
	};
}

export const postgresProvider: EnvironmentServiceProvider = {
	kind: 'postgres',
	version: '1',
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
			command: []
		};
	},
	healthcheck(input) {
		const config = postgresConfig(input.config);
		return ['exec', input.networkAlias, 'pg_isready', '-U', config.user, '-d', config.database];
	},
	buildOutputs(input) {
		const config = postgresConfig(input.config);
		const host = input.networkAlias;
		const url = `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(
			config.password
		)}@${host}:${config.port}/${encodeURIComponent(config.database)}`;
		return [
			{ key: 'DATABASE_URL', value: url, sensitive: true },
			{ key: 'POSTGRES_HOST', value: host, sensitive: false },
			{ key: 'POSTGRES_PORT', value: String(config.port), sensitive: false },
			{ key: 'POSTGRES_DB', value: config.database, sensitive: false },
			{ key: 'POSTGRES_USER', value: config.user, sensitive: false },
			{ key: 'POSTGRES_PASSWORD', value: config.password, sensitive: true }
		];
	},
	fingerprint(input) {
		const config = postgresConfig(input.config);
		return {
			kind: 'postgres',
			version: this.version,
			image: config.image,
			database: config.database,
			user: config.user,
			port: config.port
		};
	}
};
