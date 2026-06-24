import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hydrateRunFromPreparedEnvironment } from '$lib/server/project-environments/hydrate';

async function tempRoot() {
	return mkdtemp(join(tmpdir(), 'dw-hydrate-'));
}

describe('hydrateRunFromPreparedEnvironment', () => {
	it('copies declared Node artifacts from the prepared template into the run checkout', async () => {
		const root = await tempRoot();
		try {
			const templatePath = join(root, 'template');
			const checkoutPath = join(root, 'run');
			await mkdir(join(templatePath, 'node_modules', 'left-pad'), { recursive: true });
			await mkdir(checkoutPath, { recursive: true });
			await writeFile(
				join(templatePath, 'node_modules', 'left-pad', 'index.js'),
				'module.exports = 1;'
			);

			const result = await hydrateRunFromPreparedEnvironment({
				templatePath,
				checkoutPath,
				runtime: 'node',
				packageManager: 'bun'
			});

			expect(result).toEqual({ copied: ['node_modules'], skipped: [] });
			await expect(
				readFile(join(checkoutPath, 'node_modules', 'left-pad', 'index.js'), 'utf8')
			).resolves.toBe('module.exports = 1;');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('skips missing optional artifacts', async () => {
		const root = await tempRoot();
		try {
			const templatePath = join(root, 'template');
			const checkoutPath = join(root, 'run');
			await mkdir(templatePath, { recursive: true });
			await mkdir(checkoutPath, { recursive: true });

			const result = await hydrateRunFromPreparedEnvironment({
				templatePath,
				checkoutPath,
				runtime: 'node',
				packageManager: 'bun'
			});

			expect(result).toEqual({ copied: [], skipped: ['node_modules'] });
			expect(existsSync(join(checkoutPath, 'node_modules'))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('rejects unsafe artifact paths', async () => {
		const root = await tempRoot();
		try {
			await expect(
				hydrateRunFromPreparedEnvironment({
					templatePath: join(root, 'template'),
					checkoutPath: join(root, 'run'),
					runtime: 'custom',
					packageManager: 'custom',
					artifacts: [{ path: '../escape' }]
				})
			).rejects.toThrow(/Unsafe prepared artifact path/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('rejects absolute artifact paths', async () => {
		const root = await tempRoot();
		try {
			await expect(
				hydrateRunFromPreparedEnvironment({
					templatePath: join(root, 'template'),
					checkoutPath: join(root, 'run'),
					runtime: 'custom',
					packageManager: 'custom',
					artifacts: [{ path: join(root, 'outside') }]
				})
			).rejects.toThrow(/Unsafe prepared artifact path/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each(['.', './', 'node_modules/..'])(
		'rejects root-equivalent artifact path %s',
		async (artifactPath) => {
			const root = await tempRoot();
			try {
				await expect(
					hydrateRunFromPreparedEnvironment({
						templatePath: join(root, 'template'),
						checkoutPath: join(root, 'run'),
						runtime: 'custom',
						packageManager: 'custom',
						artifacts: [{ path: artifactPath }]
					})
				).rejects.toThrow(/Unsafe prepared artifact path/);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	);

	it('throws when a required artifact is missing from the prepared template', async () => {
		const root = await tempRoot();
		try {
			await mkdir(join(root, 'template'), { recursive: true });
			await mkdir(join(root, 'run'), { recursive: true });

			await expect(
				hydrateRunFromPreparedEnvironment({
					templatePath: join(root, 'template'),
					checkoutPath: join(root, 'run'),
					runtime: 'custom',
					packageManager: 'custom',
					artifacts: [{ path: '.venv', required: true }]
				})
			).rejects.toThrow(/Prepared artifact .venv is missing from template/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('removes stale target artifacts before hydrating', async () => {
		const root = await tempRoot();
		try {
			const templatePath = join(root, 'template');
			const checkoutPath = join(root, 'run');
			await mkdir(join(templatePath, 'node_modules', 'fresh'), { recursive: true });
			await mkdir(join(checkoutPath, 'node_modules', 'stale'), { recursive: true });
			await writeFile(join(templatePath, 'node_modules', 'fresh', 'index.js'), 'fresh');
			await writeFile(join(checkoutPath, 'node_modules', 'stale', 'index.js'), 'stale');

			await hydrateRunFromPreparedEnvironment({
				templatePath,
				checkoutPath,
				runtime: 'node',
				packageManager: 'bun'
			});

			expect(existsSync(join(checkoutPath, 'node_modules', 'stale'))).toBe(false);
			await expect(
				readFile(join(checkoutPath, 'node_modules', 'fresh', 'index.js'), 'utf8')
			).resolves.toBe('fresh');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('rejects nested target artifacts when their parent resolves outside the checkout', async () => {
		const root = await tempRoot();
		try {
			const templatePath = join(root, 'template');
			const checkoutPath = join(root, 'run');
			const outsidePath = join(root, 'outside');
			await mkdir(join(templatePath, 'node_modules', 'pkg'), { recursive: true });
			await mkdir(join(outsidePath, 'pkg'), { recursive: true });
			await mkdir(checkoutPath, { recursive: true });
			await writeFile(join(templatePath, 'node_modules', 'pkg', 'index.js'), 'fresh');
			await writeFile(join(outsidePath, 'pkg', 'index.js'), 'outside');
			await symlink(outsidePath, join(checkoutPath, 'node_modules'));

			await expect(
				hydrateRunFromPreparedEnvironment({
					templatePath,
					checkoutPath,
					runtime: 'custom',
					packageManager: 'custom',
					artifacts: [{ path: 'node_modules/pkg' }]
				})
			).rejects.toThrow(/Unsafe prepared artifact path/);

			await expect(readFile(join(outsidePath, 'pkg', 'index.js'), 'utf8')).resolves.toBe('outside');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('rejects nested source artifacts when their parent resolves outside the template', async () => {
		const root = await tempRoot();
		try {
			const templatePath = join(root, 'template');
			const checkoutPath = join(root, 'run');
			const outsidePath = join(root, 'outside');
			await mkdir(templatePath, { recursive: true });
			await mkdir(checkoutPath, { recursive: true });
			await mkdir(join(outsidePath, 'pkg'), { recursive: true });
			await writeFile(join(outsidePath, 'pkg', 'index.js'), 'outside');
			await symlink(outsidePath, join(templatePath, 'node_modules'));

			await expect(
				hydrateRunFromPreparedEnvironment({
					templatePath,
					checkoutPath,
					runtime: 'custom',
					packageManager: 'custom',
					artifacts: [{ path: 'node_modules/pkg' }]
				})
			).rejects.toThrow(/Unsafe prepared artifact path/);

			expect(existsSync(join(checkoutPath, 'node_modules'))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('preserves relative symlinks inside hydrated artifacts', async () => {
		const root = await tempRoot();
		try {
			const templatePath = join(root, 'template');
			const checkoutPath = join(root, 'run');
			await mkdir(join(templatePath, 'node_modules', '.bin'), { recursive: true });
			await mkdir(join(templatePath, 'node_modules', 'left-pad'), { recursive: true });
			await mkdir(checkoutPath, { recursive: true });
			await writeFile(join(templatePath, 'node_modules', 'left-pad', 'index.js'), 'bin');
			await symlink('../left-pad/index.js', join(templatePath, 'node_modules', '.bin', 'left-pad'));

			await hydrateRunFromPreparedEnvironment({
				templatePath,
				checkoutPath,
				runtime: 'node',
				packageManager: 'bun'
			});

			await expect(readlink(join(checkoutPath, 'node_modules', '.bin', 'left-pad'))).resolves.toBe(
				'../left-pad/index.js'
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
