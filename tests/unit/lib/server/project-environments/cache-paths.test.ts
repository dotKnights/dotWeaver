import { describe, expect, it } from 'vitest';
import { projectEnvironmentCacheMounts } from '$lib/server/project-environments/cache-paths';

describe('project environment cache paths', () => {
	it('maps Bun caches to deterministic host and container paths', () => {
		const mounts = projectEnvironmentCacheMounts({
			root: '/workspaces',
			projectId: 'p1',
			profileName: 'default',
			runtime: 'node',
			packageManager: 'bun'
		});

		expect(mounts).toEqual([
			{
				source: '/workspaces/p1/cache/default/node/bun/install',
				target: '/root/.bun/install/cache'
			}
		]);
	});

	it('returns no automatic mounts for custom package managers', () => {
		expect(
			projectEnvironmentCacheMounts({
				root: '/workspaces',
				projectId: 'p1',
				profileName: 'default',
				runtime: 'custom',
				packageManager: 'custom'
			})
		).toEqual([]);
	});
});
