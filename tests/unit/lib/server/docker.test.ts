import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Mock spawn so ensureImage's docker calls can be exercised without a real daemon.
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

import { buildRunArgs, ensureImage, runContainer } from '$lib/server/docker';

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

function fakeRunChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		stdin: EventEmitter & { write: ReturnType<typeof vi.fn> };
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.stdin = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn> };
	child.stdin.write = vi.fn((_chunk: unknown, callback?: (error?: Error | null) => void) => {
		callback?.();
		return true;
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

	it('attaches the container to the provided network (prod uses `coolify` for DNS + egress)', () => {
		const args = buildRunArgs({ image: 'img', name: 'n', workspacePath: '/w', env: {}, network: 'coolify' });
		expect(args).toEqual(expect.arrayContaining(['--network', 'coolify']));
		expect(args).not.toEqual(expect.arrayContaining(['--network', 'bridge']));
	});

	it('keeps stdin open for host-to-container control messages', () => {
		const args = buildRunArgs({ image: 'img', name: 'n', workspacePath: '/w', env: {} });
		expect(args.slice(0, 2)).toEqual(['run', '-i']);
	});

	it('mounts extra runtime files read-only when requested', () => {
		const args = buildRunArgs({
			image: 'img',
			name: 'n',
			workspacePath: '/w',
			mounts: [
				{
					source: '/home/me/.codex/auth.json',
					target: '/runner/codex-auth/auth.json',
					readOnly: true
				}
			],
			env: {}
		});

		expect(args).toEqual(
			expect.arrayContaining(['-v', '/home/me/.codex/auth.json:/runner/codex-auth/auth.json:ro'])
		);
	});

	it('can override entrypoint and command for prepare containers', () => {
		const args = buildRunArgs({
			image: 'dotweaver-runner',
			name: 'prepare-p1',
			workspacePath: '/workspace/p1/environment/default/checkout',
			entrypoint: '/bin/sh',
			command: ['-lc', 'bun install'],
			env: {},
			mounts: [
				{ source: '/workspace/p1/cache/default/node/bun/install', target: '/root/.bun/install/cache' }
			]
		});

		expect(args).toEqual(expect.arrayContaining(['--entrypoint', '/bin/sh']));
		expect(args).toEqual(
			expect.arrayContaining([
				'-v',
				'/workspace/p1/cache/default/node/bun/install:/root/.bun/install/cache'
			])
		);
		expect(args.slice(-3)).toEqual(['dotweaver-runner', '-lc', 'bun install']);
	});
});

describe('runContainer', () => {
	beforeEach(() => spawn.mockReset());

	it('writes JSON control messages to docker stdin', async () => {
		const child = fakeRunChild();
		spawn.mockReturnValueOnce(child);

		const done = runContainer(['run', 'img'], (_line, control) => {
			void control.sendControlMessage({ type: 'interaction_response', toolUseId: 't1' });
		});
		child.stdout.write('{"type":"prompt"}\n');
		await Promise.resolve();
		child.emit('close', 0);

		await done;
		expect(child.stdin.write).toHaveBeenCalledWith(
			JSON.stringify({ type: 'interaction_response', toolUseId: 't1' }) + '\n',
			expect.any(Function)
		);
	});

	it('rejects when writing a control message to docker stdin fails', async () => {
		const child = fakeRunChild();
		const failure = new Error('stdin write failed');
		child.stdin.write.mockImplementationOnce(
			(_chunk: unknown, callback?: (error?: Error | null) => void) => {
				callback?.(failure);
				return false;
			}
		);
		spawn.mockReturnValueOnce(child);

		const done = runContainer(['run', 'img'], (_line, control) => {
			void control.sendControlMessage({ type: 'interaction_response', toolUseId: 't1' });
		});
		child.stdout.write('{"type":"prompt"}\n');
		await Promise.resolve();
		child.emit('close', 0);

		await expect(done).rejects.toThrow('stdin write failed');
	});

	it('rejects when docker stdin emits an error', async () => {
		const child = fakeRunChild();
		spawn.mockReturnValueOnce(child);
		const failure = new Error('stdin stream failed');

		const done = runContainer(['run', 'img'], () => {});
		child.stdin.emit('error', failure);

		await expect(done).rejects.toThrow('stdin stream failed');
	});

	it('waits for async line handlers before resolving', async () => {
		const child = fakeRunChild();
		spawn.mockReturnValueOnce(child);
		let resolveLine!: () => void;
		const lineHandled = new Promise<void>((resolve) => {
			resolveLine = resolve;
		});
		let settled = false;

		const done = runContainer(['run', 'img'], async () => {
			await lineHandled;
		}).finally(() => {
			settled = true;
		});
		child.stdout.write('{"type":"prompt"}\n');
		await Promise.resolve();
		child.emit('close', 0);
		await Promise.resolve();

		expect(settled).toBe(false);
		resolveLine();
		await done;
		expect(settled).toBe(true);
	});

	it('rejects when an async line handler rejects', async () => {
		const child = fakeRunChild();
		spawn.mockReturnValueOnce(child);
		const failure = new Error('handler failed');

		const done = runContainer(['run', 'img'], async () => {
			throw failure;
		});
		child.stdout.write('{"type":"prompt"}\n');
		await Promise.resolve();
		child.emit('close', 0);

		await expect(done).rejects.toThrow('handler failed');
	});

	it('resolves timed out runs even when a line handler never settles', async () => {
		vi.useFakeTimers();
		try {
			const child = fakeRunChild();
			spawn.mockReturnValueOnce(child);
			spawn.mockReturnValueOnce(fakeChild(0)); // docker kill

			const done = runContainer(
				['run', 'img'],
				async () => {
					await new Promise(() => {});
				},
				{ timeoutMs: 100, name: 'run-abc' }
			);
			child.stdout.write('{"type":"prompt"}\n');
			await Promise.resolve();
			vi.advanceTimersByTime(100);
			await Promise.resolve();
			child.emit('close', 137);

			await expect(done).resolves.toEqual({ exitCode: 137, timedOut: true });
		} finally {
			vi.useRealTimers();
		}
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
