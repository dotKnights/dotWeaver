import { describe, expect, it } from 'vitest';
import {
	projectEnvironmentDetectSchema,
	projectEnvironmentPrepareSchema,
	projectEnvironmentProfileInputSchema
} from '$lib/schemas/project-environments';

describe('project environment schemas', () => {
	it('accepts a Node Bun default profile', () => {
		const parsed = projectEnvironmentProfileInputSchema.parse({
			projectId: 'p1',
			runtime: 'node',
			adapterId: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			testCommand: 'bun run test',
			buildCommand: 'bun run build',
			devCommand: 'bun run dev'
		});

		expect(parsed).toMatchObject({
			projectId: 'p1',
			name: 'default',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install'
		});
	});

	it('rejects mismatched runtime package managers', () => {
		expect(() =>
			projectEnvironmentProfileInputSchema.parse({
				projectId: 'p1',
				runtime: 'python',
				adapterId: 'python',
				packageManager: 'bun',
				installCommand: 'bun install'
			})
		).toThrow(/not valid for python/);
	});

	it('allows a custom profile with custom package manager', () => {
		const parsed = projectEnvironmentProfileInputSchema.parse({
			projectId: 'p1',
			runtime: 'custom',
			adapterId: 'custom',
			packageManager: 'custom',
			installCommand: 'make setup'
		});

		expect(parsed.packageManager).toBe('custom');
	});

	it('validates detect and prepare commands', () => {
		expect(projectEnvironmentDetectSchema.parse({ projectId: 'p1' })).toEqual({ projectId: 'p1' });
		expect(
			projectEnvironmentPrepareSchema.parse({ projectId: 'p1', profileId: 'env1', force: true })
		).toEqual({ projectId: 'p1', profileId: 'env1', force: true });
	});
});
