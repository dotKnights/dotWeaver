import { spawn } from 'node:child_process';
import { env as privateEnv } from '$env/dynamic/private';

export interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface GitOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
}

/** Exécute `git <args>` ; ne rejette jamais sur un code non-zéro (le code est dans le retour). */
export function git(args: string[], opts: GitOptions = {}): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', args, { cwd: opts.cwd, env: opts.env ?? privateEnv });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => (stdout += d.toString()));
		child.stderr.on('data', (d) => (stderr += d.toString()));
		child.on('error', reject);
		child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
	});
}

/** Comme `git`, mais lève une erreur si le code est non-zéro ; renvoie stdout (trim). */
export async function gitOk(args: string[], opts: GitOptions = {}): Promise<string> {
	const res = await git(args, opts);
	if (res.code !== 0) {
		throw new Error(`git ${args.join(' ')} failed (${res.code}): ${res.stderr.trim()}`);
	}
	return res.stdout.trim();
}
