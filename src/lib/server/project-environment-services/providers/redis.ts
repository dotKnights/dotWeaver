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

const REDIS_PROVIDER_VERSION = '1';
const REDIS_DEFAULT_IMAGE = 'redis:7-alpine';

function image(config: Record<string, unknown>): string {
	return imageFromConfig(config, REDIS_DEFAULT_IMAGE);
}

function redisConfig(config: Record<string, unknown>, options?: { generatePassword?: boolean }) {
	return {
		image: image(config),
		password:
			typeof config.password === 'string'
				? config.password
				: options?.generatePassword
					? generatedPassword()
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
		errors.push(...imageValidationErrors(record, 'Redis'));
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
			input.containerName,
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
			{ key: 'url', value: url, sensitive: true, description: 'Connection URL' },
			{ key: 'protocol', value: 'redis', sensitive: false },
			{ key: 'host', value: host, sensitive: false },
			{ key: 'port', value: String(config.port), sensitive: false },
			{ key: 'password', value: config.password, sensitive: true }
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
