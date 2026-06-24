import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

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

describe('environment service docker helpers', () => {
	beforeEach(() => spawn.mockReset());

	it('sanitizes docker names deterministically', () => {
		expect(buildServiceContainerName('Project_1234567890', 'postgres/main')).toBe(
			'dotweaver-p-Project_1234567890-svc-postgres-main'
		);
		expect(buildServiceVolumeName('p1', 'postgres')).toBe('dotweaver-p-p1-vol-postgres');
		expect(buildServiceNetworkAlias('p1', 'redis')).toBe('dotweaver-p-p1-svc-redis');
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
		expect(args).toEqual(expect.arrayContaining(['--network-alias', 'dotweaver-p-p1-svc-postgres']));
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
			'docker inspect missing failed'
		);
	});
});
