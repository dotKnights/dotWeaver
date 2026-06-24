import { join } from 'node:path';
import { env as privateEnv } from '$env/dynamic/private';
import type { RunAgent } from '$lib/schemas/runs';

/** Racine de stockage des workspaces sur l'hôte. */
export function workspaceRoot(env: Record<string, string | undefined> = privateEnv): string {
	return env.WORKSPACE_ROOT ?? '/tmp/dotweaver-workspaces';
}

/** Clone miroir (bare) servant de cache par projet. */
export function mirrorPath(root: string, projectId: string): string {
	return join(root, projectId, 'repo.git');
}

/** Checkout isolé d'un run (un clone autonome). */
export function runWorktreePath(root: string, projectId: string, runId: string): string {
	return join(root, projectId, 'runs', runId);
}

/** Branche de travail isolée de l'agent. */
export function agentBranch(runId: string, agent: RunAgent = 'claude'): string {
	return `${agent}/${runId}`;
}

/** Nom de conteneur Docker déterministe pour un run (kill par nom à l'annulation/timeout). */
export function containerName(runId: string): string {
	return `dwrun-${runId}`;
}

export function projectEnvironmentPrepareCheckoutPath(
	root: string,
	projectId: string,
	profileName: string
): string {
	return join(root, projectId, 'environment', profileName, 'checkout');
}

export function projectEnvironmentTemplatePath(
	root: string,
	projectId: string,
	profileName: string
): string {
	return join(root, projectId, 'environment', profileName, 'template');
}

export function projectEnvironmentMetadataPath(
	root: string,
	projectId: string,
	profileName: string
): string {
	return join(root, projectId, 'environment', profileName, 'metadata.json');
}

export function projectEnvironmentCachePath(root: string, projectId: string): string {
	return join(root, projectId, 'cache');
}
