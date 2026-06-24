import { cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
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

function assertSafeArtifactPath(path: string): void {
	const normalized = normalize(path);
	if (
		path.length === 0 ||
		isAbsolute(path) ||
		normalized === '..' ||
		normalized.startsWith(`..${sep}`) ||
		normalized.includes(`${sep}..${sep}`)
	) {
		throw new ProjectEnvironmentHydrationError(`Unsafe prepared artifact path: ${path}`);
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
		assertSafeArtifactPath(artifact.path);
		const source = join(input.templatePath, artifact.path);
		const target = join(input.checkoutPath, artifact.path);
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
		await cp(source, target, { recursive: true, force: true });
		copied.push(artifact.path);
	}

	return { copied, skipped };
}
