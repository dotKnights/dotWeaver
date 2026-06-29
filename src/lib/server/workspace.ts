import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git, gitOk } from '$lib/server/runtime/git';
import {
	workspaceRoot,
	mirrorPath,
	runWorktreePath,
	agentBranch,
	projectEnvironmentPrepareCheckoutPath,
	projectEnvironmentTemplatePath
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

function assertSafeEnvironmentProfileName(profileName: string): void {
	if (!/^[A-Za-z0-9_-]+$/.test(profileName)) {
		throw new Error('Invalid environment profile name');
	}
}

export async function createEnvironmentPrepareCheckout(
	projectId: string,
	profileName: string,
	baseRef: string,
	env: Record<string, string | undefined> = privateEnv
): Promise<{ checkoutPath: string; baseSha: string }> {
	assertSafeEnvironmentProfileName(profileName);
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

export async function createEnvironmentTemplateCheckout(
	projectId: string,
	profileName: string,
	baseRef: string,
	env: Record<string, string | undefined> = privateEnv
): Promise<{ checkoutPath: string; baseSha: string }> {
	assertSafeEnvironmentProfileName(profileName);
	const mirror = mirrorPath(workspaceRoot(env), projectId);
	const checkoutPath = projectEnvironmentTemplatePath(workspaceRoot(env), projectId, profileName);
	const baseSha = await gitOk(['rev-parse', baseRef], { cwd: mirror, env });
	const checkoutParentPath = dirname(checkoutPath);
	await mkdir(checkoutParentPath, { recursive: true });
	let tempCheckoutPath: string | undefined;
	let backupCheckoutPath: string | undefined;
	let shouldDeleteBackup = false;
	try {
		tempCheckoutPath = await mkdtemp(join(checkoutParentPath, '.template-'));
		await gitOk(['clone', '--no-checkout', mirror, tempCheckoutPath], { env });
		await gitOk(['checkout', baseSha], { cwd: tempCheckoutPath, env });
		if (existsSync(checkoutPath)) {
			backupCheckoutPath = join(
				checkoutParentPath,
				`.template-backup-${Date.now()}-${Math.random().toString(36).slice(2)}`
			);
			await rename(checkoutPath, backupCheckoutPath);
		}
		try {
			await rename(tempCheckoutPath, checkoutPath);
			tempCheckoutPath = undefined;
			shouldDeleteBackup = true;
		} catch (error) {
			if (backupCheckoutPath) {
				await rename(backupCheckoutPath, checkoutPath);
				backupCheckoutPath = undefined;
			}
			throw error;
		}
	} finally {
		if (tempCheckoutPath) {
			await rm(tempCheckoutPath, { recursive: true, force: true });
		}
		if (backupCheckoutPath && shouldDeleteBackup) {
			await rm(backupCheckoutPath, { recursive: true, force: true });
		}
	}
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
