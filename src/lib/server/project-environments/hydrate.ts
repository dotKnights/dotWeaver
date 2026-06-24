import { cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { getRuntimeAdapter } from '$lib/server/project-environments/adapters';
import type {
	ProjectEnvironmentPackageManager,
	ProjectEnvironmentRuntime
} from '$lib/domain/project-environment';
import type { PreparedArtifactSpec } from '$lib/server/project-environments/types';

export class ProjectEnvironmentHydrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectEnvironmentHydrationError';
	}
}

export interface HydrateRunFromPreparedEnvironmentInput {
	templatePath: string;
	checkoutPath: string;
	runtime: ProjectEnvironmentRuntime;
	packageManager: ProjectEnvironmentPackageManager;
	artifacts?: PreparedArtifactSpec[];
}

export interface HydrateRunFromPreparedEnvironmentResult {
	copied: string[];
	skipped: string[];
}

function hasParentSegment(path: string): boolean {
	return path.split(/[\\/]+/).includes('..');
}

function isStrictSubpath(path: string, root: string): boolean {
	const relativePath = relative(root, path);
	return relativePath.length > 0 && !relativePath.startsWith(`..${sep}`) && relativePath !== '..';
}

function resolveArtifactPath(root: string, path: string): string {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(resolvedRoot, path);
	if (
		path.length === 0 ||
		isAbsolute(path) ||
		hasParentSegment(path) ||
		!isStrictSubpath(resolvedPath, resolvedRoot)
	) {
		throw new ProjectEnvironmentHydrationError(`Unsafe prepared artifact path: ${path}`);
	}
	return resolvedPath;
}

export async function hydrateRunFromPreparedEnvironment(
	input: HydrateRunFromPreparedEnvironmentInput
): Promise<HydrateRunFromPreparedEnvironmentResult> {
	const adapter = getRuntimeAdapter(input.runtime);
	if (!adapter) {
		throw new ProjectEnvironmentHydrationError(`Runtime adapter ${input.runtime} not found`);
	}
	const artifacts =
		input.artifacts ?? adapter.preparedArtifacts({ packageManager: input.packageManager });
	const copied: string[] = [];
	const skipped: string[] = [];

	for (const artifact of artifacts) {
		const source = resolveArtifactPath(input.templatePath, artifact.path);
		const target = resolveArtifactPath(input.checkoutPath, artifact.path);
		if (!existsSync(source)) {
			if (artifact.required) {
				throw new ProjectEnvironmentHydrationError(
					`Prepared artifact ${artifact.path} is missing from template`
				);
			}
			skipped.push(artifact.path);
			continue;
		}
		await rm(target, { recursive: true, force: true });
		await cp(source, target, { recursive: true, force: true, verbatimSymlinks: true });
		copied.push(artifact.path);
	}

	return { copied, skipped };
}
