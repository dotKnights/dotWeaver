import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

import {
	buildServiceContainerName,
	buildServiceNetworkAlias,
	buildServiceRunArgs,
	buildServiceVolumeName,
	runDockerCommand
} from '$lib/server/project-environment-services/docker';

function fakeChild(code: number) {
	const child = new EventEmitter();
	child.on('newListener', (event) => {
		if (event === 'close') queueMicrotask(() => child.emit('close', code));
	});
	return child;
}

function fakeChildWithStderr(code: number, stderr: string) {
	const child = new EventEmitter() as EventEmitter & { stderr: PassThrough };
	child.stderr = new PassThrough();
	child.on('newListener', (event) => {
		if (event === 'close') {
			queueMicrotask(() => {
				child.stderr.write(stderr);
				child.stderr.end();
				child.emit('close', code);
			});
		}
	});
	return child;
}

describe('environment service docker helpers', () => {
	beforeEach(() => spawn.mockReset());

	it('sanitizes docker names deterministically', () => {
		expect(
			buildServiceContainerName('Project_1234567890', 'Default.Profile', 'postgres/main')
		).toBe('dotweaver-p-Project_1234567890-profile-Default.Profile-svc-postgres-main');
		expect(buildServiceVolumeName('p1', 'default', 'postgres')).toBe(
			'dotweaver-p-p1-profile-default-vol-postgres'
		);
		expect(buildServiceNetworkAlias('p1', 'default', 'redis')).toBe(
			'dotweaver-p-p1-pf-default-svc-redis'
		);
	});

	it('scopes service docker names by profile', () => {
		expect(buildServiceContainerName('p1', 'default', 'postgres')).not.toBe(
			buildServiceContainerName('p1', 'preview', 'postgres')
		);
		expect(buildServiceVolumeName('p1', 'default', 'postgres')).not.toBe(
			buildServiceVolumeName('p1', 'preview', 'postgres')
		);
		expect(buildServiceNetworkAlias('p1', 'default', 'postgres')).not.toBe(
			buildServiceNetworkAlias('p1', 'preview', 'postgres')
		);
	});

	it('builds dns-safe service network aliases', () => {
		const alias = buildServiceNetworkAlias(
			'Project_ABCDEFGHIJKLMNOPQRSTUVWXYZ_1234567890.long/path',
			'Default.Profile/Main_Service_Name_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
			'Redis.Cache/Main_Service_Name_ABCDEFGHIJKLMNOPQRSTUVWXYZ'
		);
		expect(alias).toMatch(/^[a-z0-9-]+$/);
		expect(alias).not.toMatch(/^-|-$/);
		expect(alias.length).toBeLessThanOrEqual(63);
	});

	it('uses fallback parts for empty service network aliases', () => {
		expect(buildServiceNetworkAlias('///', '___', '...')).toBe(
			'dotweaver-p-project-pf-profile-svc-service'
		);
	});

	it('builds service run args without host ports', () => {
		const args = buildServiceRunArgs({
			image: 'postgres:17-alpine',
			containerName: 'dotweaver-p-p1-svc-postgres',
			network: 'coolify',
			networkAlias: 'dotweaver-p-p1-svc-postgres',
			volumeName: 'dotweaver-p-p1-vol-postgres',
			volumeTarget: '/var/lib/postgresql/data',
			env: {
				POSTGRES_DB: 'app',
				POSTGRES_USER: 'dotweaver',
				POSTGRES_PASSWORD: 'secret'
			},
			command: []
		});
		expect(args).toEqual(expect.arrayContaining(['run', '-d', '--restart', 'unless-stopped']));
		expect(args).toEqual(expect.arrayContaining(['--network', 'coolify']));
		expect(args).toEqual(
			expect.arrayContaining(['--network-alias', 'dotweaver-p-p1-svc-postgres'])
		);
		expect(args).toEqual(
			expect.arrayContaining(['-v', 'dotweaver-p-p1-vol-postgres:/var/lib/postgresql/data'])
		);
		expect(args).not.toContain('-p');
		expect(args[args.length - 1]).toBe('postgres:17-alpine');
	});

	it('runs docker commands and rejects non-zero exits', async () => {
		spawn.mockReturnValueOnce(fakeChild(0));
		await expect(runDockerCommand(['volume', 'create', 'v1'])).resolves.toBeUndefined();
		spawn.mockReturnValueOnce(fakeChild(1));
		await expect(runDockerCommand(['inspect', 'missing'])).rejects.toThrow(
			'docker inspect failed with exit code 1'
		);
	});

	it('includes docker stderr in non-zero exit errors', async () => {
		spawn.mockReturnValueOnce(
			fakeChildWithStderr(
				125,
				'network-scoped aliases are only supported for user-defined networks'
			)
		);

		await expect(runDockerCommand(['run', 'postgres:17-alpine'])).rejects.toThrow(
			'docker run failed with exit code 125: network-scoped aliases are only supported for user-defined networks'
		);
	});

	it('redacts sensitive docker args from thrown errors', async () => {
		spawn.mockReturnValueOnce(fakeChild(1));
		try {
			await runDockerCommand([
				'run',
				'-e',
				'POSTGRES_PASSWORD=secret',
				'redis:7-alpine',
				'redis-server',
				'--requirepass',
				'secret'
			]);
			throw new Error('expected runDockerCommand to reject');
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			const message = (error as Error).message;
			expect(message).toBe('docker run failed with exit code 1');
			expect(message).not.toContain('POSTGRES_PASSWORD=secret');
			expect(message).not.toContain('--requirepass');
			expect(message).not.toContain('secret');
		}
	});
});
