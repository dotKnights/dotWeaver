import type { PullRequest } from '@prisma/client';
import { git } from '$lib/server/git';
import { authedCloneUrl, makeGitAuth } from './git-auth';

/** Pousse `branch` du checkout vers GitHub (token via askpass éphémère, jamais en config). */
export async function pushBranch(
	checkoutPath: string,
	cloneUrl: string,
	branch: string,
	token: string
): Promise<void> {
	const auth = await makeGitAuth(token);
	try {
		const res = await git(
			[
				'push',
				'--no-verify',
				authedCloneUrl(cloneUrl),
				`refs/heads/${branch}:refs/heads/${branch}`
			],
			{ cwd: checkoutPath, env: auth.env }
		);
		if (res.code !== 0) throw new Error(`Push rejected: ${res.stderr.trim()}`);
	} finally {
		await auth.cleanup();
	}
}

export type PrResult = Pick<PullRequest, 'number' | 'url' | 'state'>;

function ghHeaders(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		//FIXME : Pourquoi l'avoir en hardcodée ?
		'Content-Type': 'application/json'
	};
}

/** Ouvre une PR ; si une PR ouverte existe déjà pour ce head, la renvoie. */
export async function openPullRequest(
	token: string,
	owner: string,
	name: string,
	head: string,
	base: string,
	title: string,
	body: string
): Promise<PrResult> {
	const res = await fetch(`https://api.github.com/repos/${owner}/${name}/pulls`, {
		method: 'POST',
		headers: ghHeaders(token),
		body: JSON.stringify({ title, head, base, body })
	});
	if (res.ok) {
		const j = (await res.json()) as { number: number; html_url: string; state: string };
		return { number: j.number, url: j.html_url, state: j.state };
	}
	if (res.status === 422) {
		const existing = await fetch(
			`https://api.github.com/repos/${owner}/${name}/pulls?head=${owner}:${head}&state=open`,
			{ headers: ghHeaders(token) }
		);
		const arr = (await existing.json()) as Array<{
			number: number;
			html_url: string;
			state: string;
		}>;
		if (Array.isArray(arr) && arr[0]) {
			return { number: arr[0].number, url: arr[0].html_url, state: arr[0].state };
		}
	}
	throw new Error(`Open PR failed: ${res.status} ${await res.text()}`);
}
