import { existsSync } from 'node:fs';
import { prisma } from '$lib/server/prisma';
import { computeDiff } from '$lib/server/diff';
import { runWorktreePath, workspaceRoot } from '$lib/server/workspace-paths';

/** Levee quand le checkout d'un run n'existe plus sur l'hote (mappee 409 cote web). */
export class RunWorkspaceUnavailableError extends Error {
	constructor() {
		super(
			'Run workspace is no longer available (cleaned up, or this server uses a different WORKSPACE_ROOT than the worker).'
		);
		this.name = 'RunWorkspaceUnavailableError';
	}
}

/** Runs d'un projet (scope org), du plus recent au plus ancien. */
export function listRunsForOrg(organizationId: string, projectId: string) {
	return prisma.run.findMany({
		where: { projectId, organizationId },
		orderBy: { queuedAt: 'desc' },
		select: {
			id: true,
			status: true,
			prompt: true,
			queuedAt: true,
			finishedAt: true,
			error: true
		}
	});
}

/** Detail d'un run (scope org) avec events ordonnes. `null` si absent/hors org. */
export function getRunForOrg(organizationId: string, runId: string) {
	return prisma.run.findFirst({
		where: { id: runId, organizationId },
		include: {
			events: { orderBy: { seq: 'asc' } },
			interactions: {
				where: { status: 'pending' },
				orderBy: { createdAt: 'desc' },
				take: 1
			}
		}
	});
}

/** Diff base..head du run (scope org). `null` si run absent/hors org. */
export async function getRunDiffForOrg(organizationId: string, runId: string) {
	const run = await prisma.run.findFirst({ where: { id: runId, organizationId } });
	if (!run) return null;
	if (!run.baseCommitSha || !run.headCommitSha) {
		return { files: [], patch: '', truncated: false };
	}
	const checkout = runWorktreePath(workspaceRoot(), run.projectId, runId);
	if (!existsSync(checkout)) throw new RunWorkspaceUnavailableError();
	return computeDiff(checkout, run.baseCommitSha, run.headCommitSha);
}
