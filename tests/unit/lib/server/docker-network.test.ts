import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

import {
	DEFAULT_RUNNER_NETWORK,
	ensureDockerNetwork,
	resolveRunnerNetwork
} from '$lib/server/runtime/docker-network';

function fakeChild(code: number) {
	const child = new EventEmitter();
	child.on('newListener', (event) => {
		if (event === 'close') queueMicrotask(() => child.emit('close', code));
	});
	return child;
}

describe('docker network helpers', () => {
	beforeEach(() => spawn.mockReset());

	it('defaults runner containers to a user-defined network', () => {
		expect(resolveRunnerNetwork(undefined)).toBe(DEFAULT_RUNNER_NETWORK);
		expect(resolveRunnerNetwork('')).toBe(DEFAULT_RUNNER_NETWORK);
		expect(resolveRunnerNetwork('  ')).toBe(DEFAULT_RUNNER_NETWORK);
		expect(resolveRunnerNetwork('coolify')).toBe('coolify');
	});

	it('creates the runner network when it is missing', async () => {
		spawn.mockReturnValueOnce(fakeChild(1));
		spawn.mockReturnValueOnce(fakeChild(0));

		await expect(ensureDockerNetwork('dotweaver-runner')).resolves.toBeUndefined();

		expect(spawn).toHaveBeenNthCalledWith(1, 'docker', ['network', 'inspect', 'dotweaver-runner']);
		expect(spawn).toHaveBeenNthCalledWith(2, 'docker', ['network', 'create', 'dotweaver-runner']);
	});

	it('does not try to create Docker built-in networks', async () => {
		await expect(ensureDockerNetwork('bridge')).resolves.toBeUndefined();
		await expect(ensureDockerNetwork('host')).resolves.toBeUndefined();
		await expect(ensureDockerNetwork('none')).resolves.toBeUndefined();

		expect(spawn).not.toHaveBeenCalled();
	});
});
