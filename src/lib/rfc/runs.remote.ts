import { existsSync } from 'node:fs';
import { query, command, getRequestEvent } from '$app/server';
import { z } from 'zod';
import { error } from '@sveltejs/kit';
import { requireHeaders } from '$lib/server/utils';
import { requireActiveOrg } from '$lib/server/org';
import { prisma } from '$lib/server/prisma';
import { startRunSchema } from '$lib/schemas/runs';
import {
	agentBranch,
	runWorktreePath,
	workspaceRoot,
	containerName
} from '$lib/server/workspace-paths';
import { enqueueRun } from '$lib/server/queue';
import { getGithubToken } from '$lib/server/github';
import { computeDiff } from '$lib/server/diff';
import { pushBranch, openPullRequest } from '$lib/server/github-push';
import { approveRunSchema } from '$lib/schemas/runs';
import { removeRunCheckout } from '$lib/server/workspace';
import { killContainer } from '$lib/server/docker';

const TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 30 * 60 * 1000);

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
			status: 'queued',
			timeoutAt: new Date(Date.now() + TIMEOUT_MS)
		}
	});
	await enqueueRun(id);
	await listRuns(projectId).refresh();
	return { runId: id };
});

/** Annule un run actif : pose `canceled` (gardé) PUIS tue le conteneur, pour que
 *  l'orchestrateur (transition gardée `running → failed`) ne réécrive pas le statut. */
export const cancelRun = command(z.string(), async (runId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const run = await prisma.run.findFirst({
		where: { id: runId, organizationId },
		select: { id: true, status: true, projectId: true }
	});
	if (!run) error(404, 'Run not found');

	const res = await prisma.run.updateMany({
		where: { id: runId, status: { in: ['queued', 'preparing', 'running'] } },
		data: { status: 'canceled', finishedAt: new Date() }
	});
	if (res.count > 0) {
		await killContainer(containerName(runId));
	}
	await getRun(runId).refresh();
	await listRuns(run.projectId).refresh();
	return { canceled: res.count > 0 };
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
	if (!existsSync(checkout)) {
		error(
			409,
			'Run workspace is no longer available (cleaned up, or this server uses a different WORKSPACE_ROOT than the worker).'
		);
	}
	try {
		return await computeDiff(checkout, run.baseCommitSha, run.headCommitSha);
	} catch (e) {
		error(500, `Failed to compute diff: ${(e as Error)?.message ?? String(e)}`);
	}
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
