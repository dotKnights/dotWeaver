import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitOk } from '$lib/server/git';
import {
	ensureMirror,
	createEnvironmentPrepareCheckout,
	createRunCheckout,
	getHeadSha,
	listMirrorBranches,
	readMirrorFiles,
	removeRunCheckout
} from '$lib/server/workspace';
import { env as privateEnv } from '$env/dynamic/private';

let tmp: string;
let sourceRepo: string;
let env: Record<string, string | undefined>;

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), 'dw-ws-'));
	sourceRepo = join(tmp, 'source');
	await mkdir(sourceRepo, { recursive: true });
	await gitOk(['init', '-b', 'main'], { cwd: sourceRepo });
	await gitOk(['config', 'user.email', 't@t.t'], { cwd: sourceRepo });
	await gitOk(['config', 'user.name', 't'], { cwd: sourceRepo });
	await writeFile(join(sourceRepo, 'README.md'), '# hi\n');
	await gitOk(['add', '-A'], { cwd: sourceRepo });
	await gitOk(['commit', '-m', 'init'], { cwd: sourceRepo });
	env = { ...privateEnv, WORKSPACE_ROOT: join(tmp, 'workspaces') };
});
afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

describe('workspace lifecycle', () => {
	it('mirrors, creates a self-contained checkout on claude/<id>, captures head, cleans up', async () => {
		await ensureMirror('proj1', sourceRepo, env);
		const { checkoutPath, baseSha, branch } = await createRunCheckout('proj1', 'run1', 'main', env);
		expect(branch).toBe('claude/run1');
		expect(existsSync(checkoutPath)).toBe(true);
		// `.git` must be a real directory (self-contained), not a worktree pointer file.
		expect(existsSync(join(checkoutPath, '.git', 'HEAD'))).toBe(true);

		await writeFile(join(checkoutPath, 'NEW.md'), 'new\n');
		await gitOk(['config', 'user.email', 'a@a.a'], { cwd: checkoutPath });
		await gitOk(['config', 'user.name', 'a'], { cwd: checkoutPath });
		await gitOk(['add', '-A'], { cwd: checkoutPath });
		await gitOk(['commit', '-m', 'change'], { cwd: checkoutPath });

		const head = await getHeadSha(checkoutPath, env);
		expect(head).not.toBe(baseSha);

		await removeRunCheckout('proj1', 'run1', env);
		expect(existsSync(checkoutPath)).toBe(false);
	});

	it('re-running ensureMirror fetches instead of failing', async () => {
		await ensureMirror('proj1', sourceRepo, env);
		await expect(ensureMirror('proj1', sourceRepo, env)).resolves.toBeTypeOf('string');
	});

	it('lists branches from the project mirror, including slash names', async () => {
		await gitOk(['checkout', '-b', 'feature/login'], { cwd: sourceRepo });
		await writeFile(join(sourceRepo, 'FEATURE.md'), 'feature\n');
		await gitOk(['add', '-A'], { cwd: sourceRepo });
		await gitOk(['commit', '-m', 'feature'], { cwd: sourceRepo });

		await ensureMirror('proj1', sourceRepo, env);

		await expect(listMirrorBranches('proj1', env)).resolves.toEqual(
			expect.arrayContaining(['main', 'feature/login'])
		);
	});

	it('reads selected files from the project mirror', async () => {
		await ensureMirror('proj1', sourceRepo, env);
		await expect(
			readMirrorFiles('proj1', 'main', ['README.md', 'missing.txt'], env)
		).resolves.toEqual({
			'README.md': '# hi\n',
			'missing.txt': null
		});
	});

	it('creates a detached prepare checkout for an environment profile', async () => {
		await ensureMirror('proj1', sourceRepo, env);
		const checkout = await createEnvironmentPrepareCheckout('proj1', 'default', 'main', env);
		expect(checkout.checkoutPath.endsWith('/proj1/environment/default/checkout')).toBe(true);
		expect(existsSync(join(checkout.checkoutPath, '.git', 'HEAD'))).toBe(true);
	});
});
