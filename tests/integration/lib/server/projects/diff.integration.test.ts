import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitOk } from '$lib/server/runtime/git';
import { computeDiff } from '$lib/server/projects/diff';

let dir: string;

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'dw-diff-'));
	await gitOk(['init', '-b', 'main'], { cwd: dir });
	await gitOk(['config', 'user.email', 't@t.t'], { cwd: dir });
	await gitOk(['config', 'user.name', 't'], { cwd: dir });
	await writeFile(join(dir, 'a.txt'), 'one\n');
	await gitOk(['add', '-A'], { cwd: dir });
	await gitOk(['commit', '-m', 'base'], { cwd: dir });
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('computeDiff', () => {
	it('reports added file, counts, and includes the patch', async () => {
		const base = await gitOk(['rev-parse', 'HEAD'], { cwd: dir });
		await writeFile(join(dir, 'b.txt'), 'hello\nworld\n');
		await gitOk(['add', '-A'], { cwd: dir });
		await gitOk(['commit', '-m', 'add b'], { cwd: dir });
		const head = await gitOk(['rev-parse', 'HEAD'], { cwd: dir });

		const diff = await computeDiff(dir, base, head);
		expect(diff.files).toEqual([{ path: 'b.txt', status: 'A', additions: 2, deletions: 0 }]);
		expect(diff.patch).toContain('+hello');
		expect(diff.truncated).toBe(false);
	});

	it('does not execute repository-local external diff helpers', async () => {
		const base = await gitOk(['rev-parse', 'HEAD'], { cwd: dir });
		const marker = join(dir, 'external-diff-ran');
		const helper = join(dir, 'external-diff.sh');
		await writeFile(helper, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 0\n`);
		await chmod(helper, 0o700);
		await gitOk(['config', 'diff.external', helper], { cwd: dir });
		await writeFile(join(dir, 'a.txt'), 'one\ntwo\n');
		await gitOk(['add', '-A'], { cwd: dir });
		await gitOk(['commit', '-m', 'edit a'], { cwd: dir });
		const head = await gitOk(['rev-parse', 'HEAD'], { cwd: dir });

		const diff = await computeDiff(dir, base, head);

		expect(await exists(marker)).toBe(false);
		expect(diff.patch).toContain('diff --git a/a.txt b/a.txt');
		expect(diff.patch).toContain('+two');
	});
});
