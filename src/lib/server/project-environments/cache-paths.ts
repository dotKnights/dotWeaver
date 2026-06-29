import { join } from 'node:path';
import type {
	ProjectEnvironmentPackageManager,
	ProjectEnvironmentRuntime
} from '$lib/domain/project-environment';
import type { CacheMountSpec } from '$lib/server/project-environments/types';

function projectEnvironmentCacheRoot(input: {
	root: string;
	projectId: string;
	profileName: string;
	runtime: ProjectEnvironmentRuntime;
	packageManager: ProjectEnvironmentPackageManager;
}): string {
	return join(
		input.root,
		input.projectId,
		'cache',
		input.profileName,
		input.runtime,
		input.packageManager
	);
}

export function projectEnvironmentCacheMounts(input: {
	root: string;
	projectId: string;
	profileName: string;
	runtime: ProjectEnvironmentRuntime;
	packageManager: ProjectEnvironmentPackageManager;
}): CacheMountSpec[] {
	const base = projectEnvironmentCacheRoot(input);
	switch (input.packageManager) {
		case 'bun':
			return [{ source: join(base, 'install'), target: '/root/.bun/install/cache' }];
		case 'npm':
			return [{ source: join(base, 'npm'), target: '/root/.npm' }];
		case 'pnpm':
			return [{ source: join(base, 'store'), target: '/root/.local/share/pnpm/store' }];
		case 'yarn':
			return [{ source: join(base, 'yarn'), target: '/root/.cache/yarn' }];
		case 'uv':
			return [{ source: join(base, 'uv'), target: '/root/.cache/uv' }];
		case 'pip':
			return [{ source: join(base, 'pip'), target: '/root/.cache/pip' }];
		case 'poetry':
			return [{ source: join(base, 'poetry'), target: '/root/.cache/pypoetry' }];
		case 'custom':
			return [];
	}
}
