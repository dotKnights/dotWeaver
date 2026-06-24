import { cp, lstat, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
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

function leavesRoot(relativePath: string): boolean {
	return relativePath.split(/[\\/]+/)[0] === '..' || isAbsolute(relativePath);
}

function isStrictSubpath(path: string, root: string): boolean {
	const relativePath = relative(root, path);
	return relativePath.length > 0 && !leavesRoot(relativePath);
}

function isSubpathOrSame(path: string, root: string): boolean {
	const relativePath = relative(root, path);
	return relativePath.length === 0 || !leavesRoot(relativePath);
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

async function nearestExistingAncestor(path: string, root: string): Promise<string> {
	let current = dirname(path);
	while (isSubpathOrSame(current, root)) {
		try {
			await lstat(current);
			return current;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	throw new ProjectEnvironmentHydrationError(`Unsafe prepared artifact path: ${path}`);
}

async function assertRealParentInsideRoot(
	path: string,
	root: string,
	artifactPath: string
): Promise<void> {
	const resolvedRoot = resolve(root);
	const existingParent = await nearestExistingAncestor(path, resolvedRoot);
	const [realRoot, realParent] = await Promise.all([
		realpath(resolvedRoot),
		realpath(existingParent)
	]);
	if (!isSubpathOrSame(realParent, realRoot)) {
		throw new ProjectEnvironmentHydrationError(`Unsafe prepared artifact path: ${artifactPath}`);
	}
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
		await assertRealParentInsideRoot(source, input.templatePath, artifact.path);
		await assertRealParentInsideRoot(target, input.checkoutPath, artifact.path);
		await rm(target, { recursive: true, force: true });
		await cp(source, target, { recursive: true, force: true, verbatimSymlinks: true });
		copied.push(artifact.path);
	}

	return { copied, skipped };
}
