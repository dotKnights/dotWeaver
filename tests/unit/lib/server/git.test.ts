import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitOk } from '$lib/server/git';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'dw-git-'));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('git wrapper', () => {
	it('gitOk returns trimmed stdout on success', async () => {
		await gitOk(['init', '-b', 'main'], { cwd: dir });
		const branch = await gitOk(['symbolic-ref', '--short', 'HEAD'], { cwd: dir });
		expect(branch).toBe('main');
	});

	it('git returns a non-zero code instead of throwing', async () => {
		const res = await git(['rev-parse', 'HEAD'], { cwd: dir }); // no commits yet
		expect(res.code).not.toBe(0);
	});

	it('gitOk throws with stderr on failure', async () => {
		await expect(gitOk(['rev-parse', 'HEAD'], { cwd: dir })).rejects.toThrow(
			/git rev-parse HEAD failed/
		);
	});
});
