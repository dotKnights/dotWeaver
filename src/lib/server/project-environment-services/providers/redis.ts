import { randomBytes } from 'node:crypto';
import type {
	EnvironmentServiceProvider,
	ProviderRuntimeInput
} from '$lib/server/project-environment-services/types';

const REDIS_PROVIDER_VERSION = '1';

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

function redisConfig(config: Record<string, unknown>, options?: { generatePassword?: boolean }) {
	return {
		image: typeof config.image === 'string' ? config.image : 'redis:7-alpine',
		password:
			typeof config.password === 'string'
				? config.password
				: options?.generatePassword
					? password()
					: '',
		port: validPort(config.port) ? config.port : 6379,
		appendOnly: typeof config.appendOnly === 'boolean' ? config.appendOnly : true
	};
}

export const redisProvider: EnvironmentServiceProvider = {
	kind: 'redis',
	version: REDIS_PROVIDER_VERSION,
	defaultName: 'redis',
	defaultConfig() {
		return redisConfig({}, { generatePassword: true });
	},
	validateConfig(config) {
		const record = asConfigRecord(config);
		const parsed = redisConfig(record);
		const errors: string[] = [];
		if (parsed.password.length === 0) {
			errors.push('Redis password is required');
		}
		if (record.port !== undefined && !validPort(record.port)) {
			errors.push('Redis port must be an integer from 1 to 65535');
		}
		return {
			warnings: [],
			errors
		};
	},
	container(input: ProviderRuntimeInput) {
		const config = redisConfig(input.config);
		return {
			image: config.image,
			env: {},
			volumeTarget: '/data',
			command: [
				'redis-server',
				'--appendonly',
				config.appendOnly ? 'yes' : 'no',
				'--requirepass',
				config.password,
				'--port',
				String(config.port)
			]
		};
	},
	healthcheck(input) {
		const config = redisConfig(input.config);
		return [
			'exec',
			input.networkAlias,
			'redis-cli',
			'-a',
			config.password,
			'-p',
			String(config.port),
			'ping'
		];
	},
	buildOutputs(input: ProviderRuntimeInput) {
		const config = redisConfig(input.config);
		const host = input.networkAlias;
		const url = `redis://:${encodeURIComponent(config.password)}@${host}:${config.port}`;
		return [
			{ key: 'REDIS_URL', value: url, sensitive: true },
			{ key: 'REDIS_HOST', value: host, sensitive: false },
			{ key: 'REDIS_PORT', value: String(config.port), sensitive: false },
			{ key: 'REDIS_PASSWORD', value: config.password, sensitive: true }
		];
	},
	fingerprint(input) {
		const config = redisConfig(input.config);
		return {
			kind: 'redis',
			version: REDIS_PROVIDER_VERSION,
			image: config.image,
			port: config.port,
			appendOnly: config.appendOnly
		};
	}
};
