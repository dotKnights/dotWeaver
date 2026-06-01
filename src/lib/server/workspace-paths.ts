import { join } from 'node:path';

/** Racine de stockage des workspaces sur l'hôte. */
export function workspaceRoot(env: Record<string, string | undefined> = process.env): string {
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
export function agentBranch(runId: string): string {
	return `claude/${runId}`;
}

/** Nom de conteneur Docker déterministe pour un run (kill par nom à l'annulation/timeout). */
export function containerName(runId: string): string {
	return `dwrun-${runId}`;
}
