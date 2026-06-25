import { describe, expect, it } from 'vitest';
import { postgresProvider } from '$lib/server/project-environment-services/providers/postgres';
import { redisProvider } from '$lib/server/project-environment-services/providers/redis';
import { getEnvironmentServiceProvider } from '$lib/server/project-environment-services/providers';

const baseInput = {
	projectId: 'p1',
	serviceId: 'svc1',
	name: 'postgres',
	containerName: 'dotweaver-p-p1-profile-default-svc-postgres',
	networkAlias: 'dotweaver-p-p1-pf-default-svc-postgres'
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
			'url',
			'protocol',
			'host',
			'port',
			'database',
			'user',
			'password'
		]);
		expect(outputs.find((output) => output.key === 'url')).toMatchObject({ sensitive: true });
		expect(outputs.find((output) => output.key === 'password')).toMatchObject({ sensitive: true });
		expect(outputs.find((output) => output.key === 'host')).toMatchObject({
			value: 'dotweaver-p-p1-pf-default-svc-postgres',
			sensitive: false
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
		expect(outputs.find((output) => output.key === 'url')).toMatchObject({
			value:
				'postgresql://dot%2Fweaver:p%40%20ss%2Fword%3F@dotweaver-p-p1-pf-default-svc-postgres:6543/app%2Fdb%20name',
			sensitive: true
		});
		expect(outputs.find((output) => output.key === 'port')?.value).toBe('6543');
	});

	it('uses custom postgres ports in container command and healthcheck', () => {
		const input = {
			...baseInput,
			config: {
				image: 'postgres:17-alpine',
				database: 'app',
				user: 'dotweaver',
				password: 'secret',
				port: 6543
			}
		};
		expect(postgresProvider.container(input).command).toEqual(['postgres', '-p', '6543']);
		expect(postgresProvider.healthcheck(input)).toEqual([
			'exec',
			'dotweaver-p-p1-profile-default-svc-postgres',
			'pg_isready',
			'-U',
			'dotweaver',
			'-d',
			'app',
			'-p',
			'6543'
		]);
	});

	it('validates postgres password and port requirements', () => {
		expect(postgresProvider.validateConfig({}).errors).toContain(
			'Postgres database, user and password are required'
		);
		expect(postgresProvider.validateConfig({ image: ' ', password: 'secret' }).errors).toContain(
			'Postgres image is required'
		);
		for (const image of [
			'--privileged',
			' postgres:17-alpine',
			'postgres:17-alpine\n',
			'postgres:17 alpine',
			'postgres:17\nalpine',
			'postgres:17\u0081alpine',
			'postgres:17\u0085alpine'
		]) {
			expect(postgresProvider.validateConfig({ image, password: 'secret' }).errors).toContain(
				'Postgres image is invalid'
			);
		}
		for (const port of [0, -1, 5432.5, 65536]) {
			expect(postgresProvider.validateConfig({ password: 'secret', port }).errors).toContain(
				'Postgres port must be an integer from 1 to 65535'
			);
		}
	});

	it('falls back to the default postgres image for invalid runtime config', () => {
		for (const image of [
			' ',
			'--privileged',
			' postgres:17-alpine',
			'postgres:17-alpine\n',
			'postgres:17 alpine',
			'postgres:17\nalpine',
			'postgres:17\u0081alpine',
			'postgres:17\u0085alpine'
		]) {
			expect(
				postgresProvider.container({
					...baseInput,
					config: {
						image,
						password: 'secret'
					}
				}).image
			).toBe('postgres:17-alpine');
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
		expect(outputs.find((output) => output.key === 'url')?.value).toContain(':5432/');
		expect(outputs.find((output) => output.key === 'port')?.value).toBe('5432');
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
			containerName: 'dotweaver-p-p1-profile-default-svc-redis',
			networkAlias: 'dotweaver-p-p1-pf-default-svc-redis',
			config
		});
		expect(outputs.map((output) => output.key)).toEqual([
			'url',
			'protocol',
			'host',
			'port',
			'password'
		]);
		expect(outputs.find((output) => output.key === 'url')).toMatchObject({ sensitive: true });
		expect(outputs.find((output) => output.key === 'password')).toMatchObject({ sensitive: true });
	});

	it('builds encoded redis URLs from explicit runtime config', () => {
		const outputs = redisProvider.buildOutputs({
			projectId: 'p1',
			serviceId: 'svc2',
			name: 'redis',
			containerName: 'dotweaver-p-p1-profile-default-svc-redis',
			networkAlias: 'dotweaver-p-p1-pf-default-svc-redis',
			config: {
				image: 'redis:7-alpine',
				password: 'p@ ss/word?',
				port: 6380,
				appendOnly: true
			}
		});
		expect(outputs.find((output) => output.key === 'url')).toMatchObject({
			value: 'redis://:p%40%20ss%2Fword%3F@dotweaver-p-p1-pf-default-svc-redis:6380',
			sensitive: true
		});
		expect(outputs.find((output) => output.key === 'port')?.value).toBe('6380');
	});

	it('uses custom redis ports in container command and healthcheck', () => {
		const input = {
			projectId: 'p1',
			serviceId: 'svc2',
			name: 'redis',
			containerName: 'dotweaver-p-p1-profile-default-svc-redis',
			networkAlias: 'dotweaver-p-p1-pf-default-svc-redis',
			config: {
				image: 'redis:7-alpine',
				password: 'secret',
				port: 6380,
				appendOnly: true
			}
		};
		expect(redisProvider.container(input).command).toEqual([
			'redis-server',
			'--appendonly',
			'yes',
			'--requirepass',
			'secret',
			'--port',
			'6380'
		]);
		expect(redisProvider.healthcheck(input)).toEqual([
			'exec',
			'dotweaver-p-p1-profile-default-svc-redis',
			'redis-cli',
			'-a',
			'secret',
			'-p',
			'6380',
			'ping'
		]);
	});

	it('validates redis password and port requirements', () => {
		expect(redisProvider.validateConfig({}).errors).toContain('Redis password is required');
		expect(redisProvider.validateConfig({ image: ' ', password: 'secret' }).errors).toContain(
			'Redis image is required'
		);
		for (const image of [
			'--network=host',
			' redis:7-alpine',
			'redis:7-alpine\n',
			'redis:7 alpine',
			'redis:7\nalpine',
			'redis:7\u0081alpine',
			'redis:7\u0085alpine'
		]) {
			expect(redisProvider.validateConfig({ image, password: 'secret' }).errors).toContain(
				'Redis image is invalid'
			);
		}
		for (const port of [0, -1, 6379.5, 65536]) {
			expect(redisProvider.validateConfig({ password: 'secret', port }).errors).toContain(
				'Redis port must be an integer from 1 to 65535'
			);
		}
	});

	it('falls back to the default redis image for invalid runtime config', () => {
		for (const image of [
			' ',
			'--network=host',
			' redis:7-alpine',
			'redis:7-alpine\n',
			'redis:7 alpine',
			'redis:7\nalpine',
			'redis:7\u0081alpine',
			'redis:7\u0085alpine'
		]) {
			expect(
				redisProvider.container({
					projectId: 'p1',
					serviceId: 'svc2',
					name: 'redis',
					containerName: 'dotweaver-p-p1-profile-default-svc-redis',
					networkAlias: 'dotweaver-p-p1-pf-default-svc-redis',
					config: {
						image,
						password: 'secret'
					}
				}).image
			).toBe('redis:7-alpine');
		}
	});

	it('falls back to the default redis port for runtime output URLs', () => {
		const outputs = redisProvider.buildOutputs({
			projectId: 'p1',
			serviceId: 'svc2',
			name: 'redis',
			containerName: 'dotweaver-p-p1-profile-default-svc-redis',
			networkAlias: 'dotweaver-p-p1-pf-default-svc-redis',
			config: {
				password: 'secret',
				port: 6379.5
			}
		});
		expect(outputs.find((output) => output.key === 'url')?.value).toContain(':6379');
		expect(outputs.find((output) => output.key === 'port')?.value).toBe('6379');
	});
});
