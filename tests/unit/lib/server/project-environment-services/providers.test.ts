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

	it('builds encoded postgres URLs from explicit runtime config', () => {
		const outputs = postgresProvider.buildOutputs({
			...baseInput,
			config: {
				image: 'postgres:17-alpine',
				database: 'app/db name',
				user: 'dot/weaver',
				password: 'p@ ss/word?',
				port: 6543
			}
		});
		expect(outputs.find((output) => output.key === 'DATABASE_URL')).toMatchObject({
			value:
				'postgresql://dot%2Fweaver:p%40%20ss%2Fword%3F@dotweaver-p-p1-svc-postgres:6543/app%2Fdb%20name',
			sensitive: true
		});
	});

	it('validates postgres password and port requirements', () => {
		expect(postgresProvider.validateConfig({}).errors).toContain(
			'Postgres database, user and password are required'
		);
		for (const port of [0, -1, 5432.5, 65536]) {
			expect(postgresProvider.validateConfig({ password: 'secret', port }).errors).toContain(
				'Postgres port must be an integer from 1 to 65535'
			);
		}
	});

	it('falls back to the default postgres port for runtime output URLs', () => {
		const outputs = postgresProvider.buildOutputs({
			...baseInput,
			config: {
				password: 'secret',
				port: -1
			}
		});
		expect(outputs.find((output) => output.key === 'DATABASE_URL')?.value).toContain(':5432/');
		expect(outputs.find((output) => output.key === 'POSTGRES_PORT')?.value).toBe('5432');
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

	it('builds encoded redis URLs from explicit runtime config', () => {
		const outputs = redisProvider.buildOutputs({
			projectId: 'p1',
			serviceId: 'svc2',
			name: 'redis',
			networkAlias: 'dotweaver-p-p1-svc-redis',
			config: {
				image: 'redis:7-alpine',
				password: 'p@ ss/word?',
				port: 6380,
				appendOnly: true
			}
		});
		expect(outputs.find((output) => output.key === 'REDIS_URL')).toMatchObject({
			value: 'redis://:p%40%20ss%2Fword%3F@dotweaver-p-p1-svc-redis:6380',
			sensitive: true
		});
	});

	it('validates redis password and port requirements', () => {
		expect(redisProvider.validateConfig({}).errors).toContain('Redis password is required');
		for (const port of [0, -1, 6379.5, 65536]) {
			expect(redisProvider.validateConfig({ password: 'secret', port }).errors).toContain(
				'Redis port must be an integer from 1 to 65535'
			);
		}
	});

	it('falls back to the default redis port for runtime output URLs', () => {
		const outputs = redisProvider.buildOutputs({
			projectId: 'p1',
			serviceId: 'svc2',
			name: 'redis',
			networkAlias: 'dotweaver-p-p1-svc-redis',
			config: {
				password: 'secret',
				port: 6379.5
			}
		});
		expect(outputs.find((output) => output.key === 'REDIS_URL')?.value).toContain(':6379');
		expect(outputs.find((output) => output.key === 'REDIS_PORT')?.value).toBe('6379');
	});
});
