import { describe, expect, it } from 'vitest';
import { detectProjectEnvironment } from '$lib/server/project-environments/adapters';

describe('project environment adapters', () => {
	it('detects Bun Node projects from package.json and bun.lock', () => {
		const result = detectProjectEnvironment({
			files: {
				'package.json': JSON.stringify({
					scripts: { test: 'vitest', build: 'vite build', dev: 'vite dev' }
				}),
				'bun.lock': ''
			}
		});

		expect(result.runtime).toBe('node');
		expect(result.packageManager).toBe('bun');
		expect(result.installCommand).toBe('bun install');
		expect(result.testCommand).toBe('bun run test');
		expect(result.buildCommand).toBe('bun run build');
		expect(result.devCommand).toBe('bun run dev');
		expect(result.confidence).toBeGreaterThan(80);
	});

	it('detects pnpm before npm when pnpm lock exists', () => {
		const result = detectProjectEnvironment({
			files: {
				'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
				'pnpm-lock.yaml': 'lockfileVersion: 9'
			}
		});

		expect(result.runtime).toBe('node');
		expect(result.packageManager).toBe('pnpm');
		expect(result.installCommand).toBe('pnpm install');
		expect(result.testCommand).toBe('pnpm run test');
	});

	it('detects Python uv projects from pyproject.toml and uv.lock', () => {
		const result = detectProjectEnvironment({
			files: {
				'pyproject.toml': '[project]\nname = "demo"\n',
				'uv.lock': 'version = 1\n'
			}
		});

		expect(result.runtime).toBe('python');
		expect(result.packageManager).toBe('uv');
		expect(result.installCommand).toBe('uv sync');
	});

	it('falls back to custom for unknown projects', () => {
		const result = detectProjectEnvironment({ files: { 'README.md': '# demo\n' } });

		expect(result.runtime).toBe('custom');
		expect(result.packageManager).toBe('custom');
		expect(result.installCommand).toBe('');
		expect(result.warnings).toContain('No supported runtime files detected');
	});
});
