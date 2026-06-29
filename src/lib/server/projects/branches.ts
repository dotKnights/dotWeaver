import { env as privateEnv } from '$env/dynamic/private';
import type { Project } from '@prisma/client';
import { git } from '$lib/server/runtime/git';
import { authedCloneUrl, makeGitAuth } from '$lib/server/integrations/github/git-auth';
import { ensureMirror, listMirrorBranches } from '$lib/server/projects/workspace';

export type BranchProject = Pick<Project, 'id' | 'cloneUrl' | 'defaultBranch'>;

export function orderProjectBranches(branches: string[], defaultBranch: string): string[] {
	const unique = [...new Set(branches.filter(Boolean))].sort((a, b) => a.localeCompare(b));
	return [defaultBranch, ...unique.filter((branch) => branch !== defaultBranch)];
}

export async function assertValidBranchName(
	branch: string,
	env: Record<string, string | undefined> = privateEnv
): Promise<void> {
	if (branch.trim() !== branch) throw new Error('Invalid base branch name');
	const result = await git(['check-ref-format', '--branch', branch], { env });
	if (result.code !== 0) throw new Error('Invalid base branch name');
}

export async function listBranchesForProject(
	project: BranchProject,
	token: string | null,
	env: Record<string, string | undefined> = privateEnv
): Promise<string[]> {
	const auth = token ? await makeGitAuth(token) : null;
	try {
		const gitEnv = auth?.env ?? env;
		const cloneUrl = token ? authedCloneUrl(project.cloneUrl) : project.cloneUrl;
		await ensureMirror(project.id, cloneUrl, gitEnv);
		const branches = await listMirrorBranches(project.id, gitEnv);
		return orderProjectBranches(branches, project.defaultBranch);
	} finally {
		await auth?.cleanup();
	}
}

export async function assertProjectBranchExists(
	project: BranchProject,
	branch: string,
	token: string | null,
	env: Record<string, string | undefined> = privateEnv
): Promise<void> {
	await assertValidBranchName(branch, env);
	const branches = await listBranchesForProject(project, token, env);
	if (!branches.includes(branch)) {
		throw new Error(`Base branch "${branch}" was not found`);
	}
}
