import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gitOk } from './git';
import { workspaceRoot, mirrorPath, runWorktreePath, agentBranch } from './workspace-paths';

/**
 * Garantit un clone miroir (bare) du projet : clone si absent, sinon fetch.
 * `cloneUrl` peut être une URL distante (credentials gérés en amont) ou un chemin
 * local (tests). Renvoie le chemin du miroir.
 */
export async function ensureMirror(
	projectId: string,
	cloneUrl: string,
	env: Record<string, string | undefined> = process.env
): Promise<string> {
	const mirror = mirrorPath(workspaceRoot(env), projectId);
	if (existsSync(mirror)) {
		await gitOk(['fetch', '--prune'], { cwd: mirror, env });
	} else {
		await mkdir(dirname(mirror), { recursive: true });
		await gitOk(['clone', '--mirror', cloneUrl, mirror], { env });
	}
	return mirror;
}

/**
 * Crée un checkout autonome pour un run : `git clone` depuis le miroir local
 * (hardlinks → rapide), puis branche `claude/<runId>` sur `baseRef`.
 */
export async function createRunCheckout(
	projectId: string,
	runId: string,
	baseRef: string,
	env: Record<string, string | undefined> = process.env
): Promise<{ checkoutPath: string; baseSha: string; branch: string }> {
	const mirror = mirrorPath(workspaceRoot(env), projectId);
	const checkoutPath = runWorktreePath(workspaceRoot(env), projectId, runId);
	const branch = agentBranch(runId);
	const baseSha = await gitOk(['rev-parse', baseRef], { cwd: mirror, env });
	await mkdir(dirname(checkoutPath), { recursive: true });
	await gitOk(['clone', '--no-checkout', mirror, checkoutPath], { env });
	await gitOk(['checkout', '-b', branch, baseSha], { cwd: checkoutPath, env });
	return { checkoutPath, baseSha, branch };
}

/** SHA du HEAD courant d'un checkout (après commits de l'agent). */
export async function getHeadSha(
	checkoutPath: string,
	env: Record<string, string | undefined> = process.env
): Promise<string> {
	return gitOk(['rev-parse', 'HEAD'], { cwd: checkoutPath, env });
}

/** Supprime le checkout du run (idempotent). */
export async function removeRunCheckout(
	projectId: string,
	runId: string,
	env: Record<string, string | undefined> = process.env
): Promise<void> {
	const checkoutPath = runWorktreePath(workspaceRoot(env), projectId, runId);
	await rm(checkoutPath, { recursive: true, force: true });
}
