import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock spawn so ensureImage's docker calls can be exercised without a real daemon.
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

import { buildRunArgs, ensureImage } from './docker';

/**
 * Fake child process that emits `close` with the given code once a `close` listener is
 * attached (lazy — so queued children don't fire before their consumer subscribes).
 */
function fakeChild(code: number) {
	const child = new EventEmitter();
	let scheduled = false;
	child.on('newListener', (event) => {
		if (event === 'close' && !scheduled) {
			scheduled = true;
			queueMicrotask(() => child.emit('close', code));
		}
	});
	return child;
}

describe('buildRunArgs', () => {
	it('includes hardening flags, the workspace mount, env pairs, image last', () => {
		const args = buildRunArgs({
			image: 'dotweaver-runner',
			name: 'run-abc',
			workspacePath: '/ws/proj/runs/abc',
			env: { RUN_PROMPT: 'do it', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }
		});
		expect(args[0]).toBe('run');
		expect(args).toContain('--rm');
		expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL']));
		expect(args).toEqual(expect.arrayContaining(['--security-opt', 'no-new-privileges']));
		expect(args).toEqual(expect.arrayContaining(['--name', 'run-abc']));
		expect(args).toEqual(expect.arrayContaining(['-v', '/ws/proj/runs/abc:/workspace']));
		expect(args).toEqual(expect.arrayContaining(['-e', 'RUN_PROMPT=do it']));
		expect(args).toEqual(expect.arrayContaining(['-e', 'CLAUDE_CODE_OAUTH_TOKEN=tok']));
		expect(args[args.length - 1]).toBe('dotweaver-runner');
	});

	it('defaults network to bridge (MVP open egress) and applies resource limits', () => {
		const args = buildRunArgs({ image: 'img', name: 'n', workspacePath: '/w', env: {} });
		expect(args).toEqual(expect.arrayContaining(['--network', 'bridge']));
		expect(args).toEqual(expect.arrayContaining(['--memory', '4g']));
		expect(args).toEqual(expect.arrayContaining(['--cpus', '2']));
		expect(args).toEqual(expect.arrayContaining(['--pids-limit', '512']));
	});
});

describe('ensureImage', () => {
	beforeEach(() => spawn.mockReset());

	it('skips the build when the image already exists', async () => {
		spawn.mockReturnValueOnce(fakeChild(0)); // image inspect → present
		await ensureImage('dotweaver-runner');
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn.mock.calls[0][1]).toEqual(['image', 'inspect', 'dotweaver-runner']);
	});

	it('builds from the context path when the image is missing', async () => {
		spawn.mockReturnValueOnce(fakeChild(1)); // image inspect → absent
		spawn.mockReturnValueOnce(fakeChild(0)); // build → ok
		await ensureImage('dotweaver-runner', 'docker/runner');
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(spawn.mock.calls[1][1]).toEqual([
			'build',
			'--network=host',
			'-t',
			'dotweaver-runner',
			'docker/runner'
		]);
	});

	it('rejects when the build fails', async () => {
		spawn.mockReturnValueOnce(fakeChild(1)); // absent
		spawn.mockReturnValueOnce(fakeChild(2)); // build fails
		await expect(ensureImage('dotweaver-runner')).rejects.toThrow(/docker build failed/);
	});
});
