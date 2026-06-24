import { describe, expect, it } from 'vitest';
import { postgresProvider } from '$lib/server/project-environment-services/providers/postgres';
import { redisProvider } from '$lib/server/project-environment-services/providers/redis';
import { getEnvironmentServiceProvider } from '$lib/server/project-environment-services/providers';

const baseInput = {
	projectId: 'p1',
	serviceId: 'svc1',
	name: 'postgres',
	networkAlias: 'dotweaver-p-p1-svc-postgres'
};

describe('environment service providers', () => {
	it('registers postgres and redis providers', () => {
		expect(getEnvironmentServiceProvider('postgres')).toBe(postgresProvider);
		expect(getEnvironmentServiceProvider('redis')).toBe(redisProvider);
	});

	it('builds postgres defaults and outputs', () => {
		const config = postgresProvider.defaultConfig({ projectId: 'p1', name: 'postgres' });
		expect(config).toEqual({
			image: 'postgres:17-alpine',
			database: 'app',
			user: 'dotweaver',
			password: expect.any(String),
			port: 5432
		});
		const outputs = postgresProvider.buildOutputs({ ...baseInput, config });
		expect(outputs.map((output) => output.key)).toEqual([
			'DATABASE_URL',
			'POSTGRES_HOST',
			'POSTGRES_PORT',
			'POSTGRES_DB',
			'POSTGRES_USER',
			'POSTGRES_PASSWORD'
		]);
		expect(outputs.find((output) => output.key === 'DATABASE_URL')).toMatchObject({
			sensitive: true
		});
	});

	it('builds redis defaults and outputs', () => {
		const config = redisProvider.defaultConfig({ projectId: 'p1', name: 'redis' });
		expect(config).toEqual({
			image: 'redis:7-alpine',
			password: expect.any(String),
			port: 6379,
			appendOnly: true
		});
		const outputs = redisProvider.buildOutputs({
			projectId: 'p1',
			serviceId: 'svc2',
			name: 'redis',
			networkAlias: 'dotweaver-p-p1-svc-redis',
			config
		});
		expect(outputs.map((output) => output.key)).toEqual([
			'REDIS_URL',
			'REDIS_HOST',
			'REDIS_PORT',
			'REDIS_PASSWORD'
		]);
		expect(outputs.find((output) => output.key === 'REDIS_URL')).toMatchObject({
			sensitive: true
		});
	});
});
