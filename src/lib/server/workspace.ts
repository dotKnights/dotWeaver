import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { git, gitOk } from './git';
import {
	workspaceRoot,
	mirrorPath,
	runWorktreePath,
	agentBranch,
	projectEnvironmentPrepareCheckoutPath
} from './workspace-paths';
import { env as privateEnv } from '$env/dynamic/private';

/**
 * Garantit un clone miroir (bare) du projet : clone si absent, sinon fetch.
 * `cloneUrl` peut être une URL distante (credentials gérés en amont) ou un chemin
 * local (tests). Renvoie le chemin du miroir.
 */
export async function ensureMirror(
	projectId: string,
	cloneUrl: string,
	env: Record<string, string | undefined> = privateEnv
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

/** Liste les branches disponibles dans le miroir bare d'un projet. */
export async function listMirrorBranches(
	projectId: string,
	env: Record<string, string | undefined> = privateEnv
): Promise<string[]> {
	const mirror = mirrorPath(workspaceRoot(env), projectId);
	const output = await gitOk(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
		cwd: mirror,
		env
	});
	return output
		.split('\n')
		.map((branch) => branch.trim())
		.filter(Boolean);
}

export async function readMirrorFiles(
	projectId: string,
	baseRef: string,
	paths: string[],
	env: Record<string, string | undefined> = privateEnv
): Promise<Record<string, string | null>> {
	const mirror = mirrorPath(workspaceRoot(env), projectId);
	const baseSha = await gitOk(['rev-parse', '--verify', `${baseRef}^{commit}`], {
		cwd: mirror,
		env
	});
	const result: Record<string, string | null> = {};
	for (const path of paths) {
		const show = await git(['show', `${baseSha}:${path}`], { cwd: mirror, env });
		result[path] = show.code === 0 ? show.stdout : null;
	}
	return result;
}

/**
 * Crée un checkout autonome pour un run : `git clone` depuis le miroir local
 * (hardlinks → rapide), puis branche `claude/<runId>` sur `baseRef`.
 */
export async function createRunCheckout(
	projectId: string,
	runId: string,
	baseRef: string,
	env: Record<string, string | undefined> = privateEnv
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

export async function createEnvironmentPrepareCheckout(
	projectId: string,
	profileName: string,
	baseRef: string,
	env: Record<string, string | undefined> = privateEnv
): Promise<{ checkoutPath: string; baseSha: string }> {
	if (!/^[A-Za-z0-9_-]+$/.test(profileName)) {
		throw new Error('Invalid environment profile name');
	}
	const mirror = mirrorPath(workspaceRoot(env), projectId);
	const checkoutPath = projectEnvironmentPrepareCheckoutPath(
		workspaceRoot(env),
		projectId,
		profileName
	);
	await rm(checkoutPath, { recursive: true, force: true });
	const baseSha = await gitOk(['rev-parse', baseRef], { cwd: mirror, env });
	await mkdir(dirname(checkoutPath), { recursive: true });
	await gitOk(['clone', '--no-checkout', mirror, checkoutPath], { env });
	await gitOk(['checkout', baseSha], { cwd: checkoutPath, env });
	return { checkoutPath, baseSha };
}

/** SHA du HEAD courant d'un checkout (après commits de l'agent). */
export async function getHeadSha(
	checkoutPath: string,
	env: Record<string, string | undefined> = privateEnv
): Promise<string> {
	return gitOk(['rev-parse', 'HEAD'], { cwd: checkoutPath, env });
}

/** Supprime le checkout du run (idempotent). */
export async function removeRunCheckout(
	projectId: string,
	runId: string,
	env: Record<string, string | undefined> = privateEnv
): Promise<void> {
	const checkoutPath = runWorktreePath(workspaceRoot(env), projectId, runId);
	await rm(checkoutPath, { recursive: true, force: true });
}
