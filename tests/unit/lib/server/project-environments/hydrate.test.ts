import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
});
