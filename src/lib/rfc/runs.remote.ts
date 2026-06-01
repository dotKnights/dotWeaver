import { query, command, getRequestEvent } from '$app/server';
import { z } from 'zod';
import { error } from '@sveltejs/kit';
import { requireHeaders } from '$lib/server/utils';
import { requireActiveOrg } from '$lib/server/org';
import { prisma } from '$lib/server/prisma';
import { startRunSchema } from '$lib/schemas/runs';
import { agentBranch } from '$lib/server/workspace-paths';
import { enqueueRun } from '$lib/server/queue';
import { getGithubToken } from '$lib/server/github';
import { computeDiff } from '$lib/server/diff';
import { pushBranch, openPullRequest } from '$lib/server/github-push';
import { approveRunSchema } from '$lib/schemas/runs';
import { runWorktreePath, workspaceRoot } from '$lib/server/workspace-paths';
import { removeRunCheckout } from '$lib/server/workspace';

/** Crée un run (queued) sur un projet de l'org active et l'enqueue. */
export const startRun = command(startRunSchema, async ({ projectId, prompt }) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const { locals } = getRequestEvent();
	const project = await prisma.project.findFirst({ where: { id: projectId, organizationId } });
	if (!project) error(404, 'Project not found');

	const id = crypto.randomUUID();
	await prisma.run.create({
		data: {
			id,
			projectId,
			organizationId,
			createdById: locals.user!.id,
			prompt,
			agentBranch: agentBranch(id),
			status: 'queued'
		}
	});
	await enqueueRun(id);
	await listRuns(projectId).refresh();
	return { runId: id };
});

/** Runs d'un projet (org active), du plus récent au plus ancien. */
export const listRuns = query(z.string(), async (projectId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
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
});

/** Détail d'un run (org active) avec ses events ordonnés. */
export const getRun = query(z.string(), async (runId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const run = await prisma.run.findFirst({
		where: { id: runId, organizationId },
		include: { events: { orderBy: { seq: 'asc' } } }
	});
	if (!run) error(404, 'Run not found');
	return run;
});

/** Diff base..head du run (org active), depuis son checkout conservé sur l'hôte. */
export const getRunDiff = query(z.string(), async (runId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const run = await prisma.run.findFirst({ where: { id: runId, organizationId } });
	if (!run) error(404, 'Run not found');
	if (!run.baseCommitSha || !run.headCommitSha) {
		return { files: [], patch: '', truncated: false };
	}
	const checkout = runWorktreePath(workspaceRoot(), run.projectId, runId);
	return computeDiff(checkout, run.baseCommitSha, run.headCommitSha);
});

/** Valide un run en `awaiting_review` : push (+ PR) ou abandon. Push synchrone. */
export const approveRun = command(approveRunSchema, async ({ runId, action }) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const run = await prisma.run.findFirst({
		where: { id: runId, organizationId },
		include: { project: true }
	});
	if (!run) error(404, 'Run not found');
	if (run.status !== 'awaiting_review') {
		error(400, `Run is not awaiting review (status: ${run.status})`);
	}
	const project = run.project;

	if (action === 'abandon') {
		await removeRunCheckout(run.projectId, runId);
		await prisma.run.update({
			where: { id: runId },
			data: { status: 'canceled', finishedAt: new Date() }
		});
		await getRun(runId).refresh();
		await listRuns(run.projectId).refresh();
		return { status: 'canceled' as const, pullRequestUrl: null };
	}

	// Vérifie le token AVANT de passer en `pushing` : un error(400) ici ne doit pas
	// être avalé par le catch ci-dessous (qui marquerait le run `failed`).
	const token = await getGithubToken(headers);
	if (!token) error(400, 'Connect your GitHub account to push.');

	await prisma.run.update({ where: { id: runId }, data: { status: 'pushing' } });
	try {
		const checkout = runWorktreePath(workspaceRoot(), run.projectId, runId);
		await pushBranch(checkout, project.cloneUrl, run.agentBranch, token);

		let pullRequestUrl: string | null = null;
		if (action === 'push_pr') {
			const title = run.prompt.split('\n')[0].slice(0, 72) || `dotWeaver run ${runId.slice(0, 8)}`;
			const body = `Automated changes from a dotWeaver agent run.\n\n**Prompt:**\n\n> ${run.prompt}`;
			const pr = await openPullRequest(
				token,
				project.owner,
				project.name,
				run.agentBranch,
				project.defaultBranch,
				title,
				body
			);
			await prisma.pullRequest.create({
				data: { runId, number: pr.number, url: pr.url, state: pr.state }
			});
			pullRequestUrl = pr.url;
		}

		await prisma.run.update({
			where: { id: runId },
			data: { status: 'completed', finishedAt: new Date() }
		});
		await getRun(runId).refresh();
		await listRuns(run.projectId).refresh();
		return { status: 'completed' as const, pullRequestUrl };
	} catch (err) {
		await prisma.run.update({
			where: { id: runId },
			data: { status: 'failed', error: String((err as Error)?.message ?? err) }
		});
		await getRun(runId).refresh();
		error(500, err instanceof Error ? err.message : 'Push failed');
	}
});
