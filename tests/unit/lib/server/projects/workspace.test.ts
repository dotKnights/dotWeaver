import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gitOk } from '$lib/server/runtime/git';
import {
	ensureMirror,
	createEnvironmentPrepareCheckout,
	createEnvironmentTemplateCheckout,
	createRunCheckout,
	getHeadSha,
	listMirrorBranches,
	readMirrorFiles,
	removeRunCheckout
} from '$lib/server/projects/workspace';
import { env as privateEnv } from '$env/dynamic/private';

vi.mock('node:fs/promises', async () => {
	const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
	return {
		...actual,
		rename: vi.fn(actual.rename)
	};
});

let tmp: string;
let sourceRepo: string;
let env: Record<string, string | undefined>;

beforeEach(async () => {
	const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
	vi.mocked(fsPromises.rename).mockReset();
	vi.mocked(fsPromises.rename).mockImplementation(actual.rename);
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
	vi.restoreAllMocks();
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

	it('rejects an invalid mirror ref before reading files', async () => {
		await ensureMirror('proj1', sourceRepo, env);
		await expect(readMirrorFiles('proj1', 'missing-ref', ['README.md'], env)).rejects.toThrow(
			/rev-parse|missing-ref|failed/
		);
	});

	it('creates a detached prepare checkout for an environment profile', async () => {
		await ensureMirror('proj1', sourceRepo, env);
		const checkout = await createEnvironmentPrepareCheckout('proj1', 'default', 'main', env);
		expect(checkout.checkoutPath.endsWith('/proj1/environment/default/checkout')).toBe(true);
		expect(existsSync(join(checkout.checkoutPath, '.git', 'HEAD'))).toBe(true);
	});

	it('creates a durable template checkout for an environment profile', async () => {
		await ensureMirror('proj1', sourceRepo, env);
		const expectedBaseSha = await gitOk(['rev-parse', 'main'], { cwd: sourceRepo });
		const checkout = await createEnvironmentTemplateCheckout('proj1', 'default', 'main', env);

		expect(checkout.checkoutPath.endsWith('/proj1/environment/default/template')).toBe(true);
		expect(checkout.baseSha).toBe(expectedBaseSha);
		await expect(getHeadSha(checkout.checkoutPath, env)).resolves.toBe(checkout.baseSha);
		expect(existsSync(join(checkout.checkoutPath, '.git', 'HEAD'))).toBe(true);
	});

	it('preserves an existing template checkout when replacement ref is invalid', async () => {
		await ensureMirror('proj1', sourceRepo, env);
		const checkout = await createEnvironmentTemplateCheckout('proj1', 'default', 'main', env);
		const markerPath = join(checkout.checkoutPath, 'template-marker.txt');
		await writeFile(markerPath, 'keep me\n');

		await expect(
			createEnvironmentTemplateCheckout('proj1', 'default', 'missing-ref', env)
		).rejects.toThrow(/missing-ref|rev-parse|failed/);

		expect(existsSync(checkout.checkoutPath)).toBe(true);
		expect(existsSync(join(checkout.checkoutPath, '.git', 'HEAD'))).toBe(true);
		expect(existsSync(markerPath)).toBe(true);
	});

	it('restores an existing template checkout when installing the replacement fails', async () => {
		await ensureMirror('proj1', sourceRepo, env);
		const checkout = await createEnvironmentTemplateCheckout('proj1', 'default', 'main', env);
		const markerPath = join(checkout.checkoutPath, 'template-marker.txt');
		await writeFile(markerPath, 'keep me\n');
		const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
		vi.mocked(fsPromises.rename).mockImplementation(async (oldPath, newPath) => {
			const oldPathBaseName = basename(String(oldPath));
			if (
				String(newPath) === checkout.checkoutPath &&
				oldPathBaseName.startsWith('.template-') &&
				!oldPathBaseName.startsWith('.template-backup-')
			) {
				throw new Error('forced template install failure');
			}
			await actual.rename(oldPath, newPath);
		});

		await expect(
			createEnvironmentTemplateCheckout('proj1', 'default', 'main', env)
		).rejects.toThrow(/forced template install failure/);

		expect(existsSync(checkout.checkoutPath)).toBe(true);
		expect(existsSync(join(checkout.checkoutPath, '.git', 'HEAD'))).toBe(true);
		expect(existsSync(markerPath)).toBe(true);
	});

	it('rejects unsafe environment profile names for prepare checkout', async () => {
		await ensureMirror('proj1', sourceRepo, env);
		await expect(
			createEnvironmentPrepareCheckout('proj1', '../escape', 'main', env)
		).rejects.toThrow(/Invalid environment profile name/);
	});

	it('rejects unsafe environment profile names for template checkout', async () => {
		await ensureMirror('proj1', sourceRepo, env);

		await expect(
			createEnvironmentTemplateCheckout('proj1', '../escape', 'main', env)
		).rejects.toThrow(/Invalid environment profile name/);
	});
});
