import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '$lib/server/prisma';

/**
 * Injecte le username `x-access-token` dans une URL https → git demandera le mot de
 * passe via GIT_ASKPASS (le token n'apparaît jamais dans l'URL ni la config).
 */
export function authedCloneUrl(cloneUrl: string): string {
	if (!cloneUrl.startsWith('https://')) return cloneUrl;
	return cloneUrl.replace('https://', 'https://x-access-token@');
}

/** Lit le token GitHub de l'utilisateur (géré par better-auth dans la table Account). */
export async function getGithubTokenForUser(userId: string): Promise<string | null> {
	const account = await prisma.account.findFirst({
		where: { userId, providerId: 'github' },
		select: { accessToken: true }
	});
	return account?.accessToken ?? null;
}

export interface GitAuth {
	env: Record<string, string | undefined>;
	cleanup: () => Promise<void>;
}

/** Crée un GIT_ASKPASS éphémère (script temp 0700) fournissant le token. */
export async function makeGitAuth(token: string): Promise<GitAuth> {
	const dir = await mkdtemp(join(tmpdir(), 'dw-gitauth-'));
	const askpass = join(dir, 'askpass.sh');
	await writeFile(askpass, `#!/bin/sh\nprintf '%s' "${token}"\n`, { mode: 0o700 });
	return {
		env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0' },
		cleanup: () => rm(dir, { recursive: true, force: true })
	};
}
