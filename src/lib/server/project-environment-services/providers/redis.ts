import { randomBytes } from 'node:crypto';
import type {
	EnvironmentServiceProvider,
	ProviderRuntimeInput
} from '$lib/server/project-environment-services/types';

function password() {
	return randomBytes(24).toString('base64url');
}

function redisConfig(config: Record<string, unknown>) {
	return {
		image: typeof config.image === 'string' ? config.image : 'redis:7-alpine',
		password: typeof config.password === 'string' ? config.password : password(),
		port: typeof config.port === 'number' ? config.port : 6379,
		appendOnly: typeof config.appendOnly === 'boolean' ? config.appendOnly : true
	};
}

export const redisProvider: EnvironmentServiceProvider = {
	kind: 'redis',
	version: '1',
	defaultName: 'redis',
	defaultConfig() {
		return redisConfig({});
	},
	validateConfig(config) {
		const parsed = redisConfig(typeof config === 'object' && config ? config : {});
		return {
			warnings: [],
			errors: parsed.password.length === 0 ? ['Redis password is required'] : []
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
				config.password
			]
		};
	},
	healthcheck(input) {
		const config = redisConfig(input.config);
		return ['exec', input.networkAlias, 'redis-cli', '-a', config.password, 'ping'];
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
			version: this.version,
			image: config.image,
			port: config.port,
			appendOnly: config.appendOnly
		};
	}
};
