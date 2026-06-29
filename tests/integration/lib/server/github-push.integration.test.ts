import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitOk } from '$lib/server/git';
import { pushBranch } from '$lib/server/github-push';

let dir: string;
let checkout: string;
let remote: string;

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'dw-push-'));
	checkout = join(dir, 'checkout');
	remote = join(dir, 'remote.git');
	await mkdir(checkout);
	await gitOk(['init', '--bare', remote]);
	await gitOk(['init', '-b', 'main'], { cwd: checkout });
	await gitOk(['config', 'user.email', 't@t.t'], { cwd: checkout });
	await gitOk(['config', 'user.name', 't'], { cwd: checkout });
	await writeFile(join(checkout, 'a.txt'), 'one\n');
	await gitOk(['add', '-A'], { cwd: checkout });
	await gitOk(['commit', '-m', 'base'], { cwd: checkout });
	await gitOk(['checkout', '-b', 'feature'], { cwd: checkout });
	await writeFile(join(checkout, 'a.txt'), 'one\ntwo\n');
	await gitOk(['add', '-A'], { cwd: checkout });
	await gitOk(['commit', '-m', 'feature'], { cwd: checkout });
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('pushBranch', () => {
	it('does not execute repository pre-push hooks', async () => {
		const marker = join(dir, 'pre-push-ran');
		const hook = join(checkout, '.git', 'hooks', 'pre-push');
		await writeFile(
			hook,
			`#!/bin/sh\nprintf "ran:%s" "$GIT_ASKPASS" > ${JSON.stringify(marker)}\nexit 0\n`
		);
		await chmod(hook, 0o700);

		await pushBranch(checkout, remote, 'feature', 'fake-token');

		expect(await exists(marker)).toBe(false);
		expect(await gitOk(['rev-parse', 'refs/heads/feature'], { cwd: remote })).toMatch(
			/^[0-9a-f]{40}$/
		);
	});
});
