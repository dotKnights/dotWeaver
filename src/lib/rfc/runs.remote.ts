import { query, command, getRequestEvent } from '$app/server';
import { z } from 'zod';
import { error } from '@sveltejs/kit';
import { requireHeaders } from '$lib/server/utils';
import { requireActiveOrg } from '$lib/server/org';
import { prisma } from '$lib/server/prisma';
import { startRunSchema } from '$lib/schemas/runs';
import { answerRunInteractionSchema } from '$lib/schemas/run-interactions';
import {
	agentBranch,
	runWorktreePath,
	workspaceRoot,
	containerName
} from '$lib/server/workspace-paths';
import { enqueueRun } from '$lib/server/queue';
import { getGithubToken } from '$lib/server/github';
import { pushBranch, openPullRequest } from '$lib/server/github-push';
import { approveRunSchema } from '$lib/schemas/runs';
import { removeRunCheckout } from '$lib/server/workspace';
import { killContainer } from '$lib/server/docker';
import { env as privateEnv } from '$env/dynamic/private';
import {
	listRunsForOrg,
	getRunForOrg,
	getRunDiffForOrg,
	RunWorkspaceUnavailableError
} from '$lib/server/runs-service';
import {
	buildRunAgentConfig,
	ProjectAgentConfigError
} from '$lib/server/project-agent-config-service';
import { assertProjectBranchExists } from '$lib/server/project-branches-service';
import {
	answerPendingRunInteractionForOrg,
	cancelPendingRunInteractions,
	RunInteractionAnswerError
} from '$lib/server/run-interactions-service';
import { RUN_STATUS, RUN_STATUS_GROUPS } from '$lib/domain/run-status';
import { transitionRun } from '$lib/server/run-transitions';

const TIMEOUT_MS = Number(privateEnv.RUN_TIMEOUT_MS ?? 30 * 60 * 1000);

/** Crée un run (queued) sur un projet de l'org active et l'enqueue. */
export const startRun = command(
	startRunSchema,
	async ({ projectId, prompt, baseBranch, model, useProjectAgentConfig }) => {
		const headers = requireHeaders();
		const organizationId = await requireActiveOrg(headers);
		const { locals } = getRequestEvent();
		const project = await prisma.project.findFirst({ where: { id: projectId, organizationId } });
		if (!project) error(404, 'Project not found');

		const effectiveBaseBranch = baseBranch ?? project.defaultBranch;
		const token = await getGithubToken(headers);
		try {
			await assertProjectBranchExists(project, effectiveBaseBranch, token);
		} catch (e) {
			error(400, e instanceof Error ? e.message : 'Invalid base branch');
		}

		if (useProjectAgentConfig) {
			try {
				await buildRunAgentConfig(organizationId, projectId, { useProjectAgentConfig: true });
			} catch (e) {
				if (e instanceof ProjectAgentConfigError) error(400, e.message);
				throw e;
			}
		}

		const id = crypto.randomUUID();
		let created = false;
		try {
			await prisma.run.create({
				data: {
					id,
					projectId,
					organizationId,
					createdById: locals.user!.id,
					prompt,
					model: model ?? null,
					useProjectAgentConfig,
					agentBranch: agentBranch(id),
					baseBranch: effectiveBaseBranch,
					status: RUN_STATUS.QUEUED,
					timeoutAt: new Date(Date.now() + TIMEOUT_MS)
				}
			});
			created = true;
			await enqueueRun(id);
		} catch (err) {
			if (created) {
				await transitionRun(id, RUN_STATUS.QUEUED, RUN_STATUS.FAILED, {
					error: String((err as Error)?.message ?? err),
					finishedAt: new Date()
				}).catch(() => {});
			}
			throw err;
		}
		await listRuns(projectId).refresh();
		return { runId: id };
	}
);

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

	const canceled = await transitionRun(runId, RUN_STATUS_GROUPS.CANCELABLE, RUN_STATUS.CANCELED, {
		finishedAt: new Date()
	});
	if (canceled) {
		await cancelPendingRunInteractions(runId);
		await killContainer(containerName(runId));
	}
	await getRun(runId).refresh();
	await listRuns(run.projectId).refresh();
	return { canceled };
});

export const answerRunInteraction = command(answerRunInteractionSchema, async (input) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);

	try {
		const result = await answerPendingRunInteractionForOrg(organizationId, input);
		if (!result) error(404, 'Interaction not found');
		await getRun(result.runId).refresh();
		await listRuns(result.projectId).refresh();
		return { answered: true };
	} catch (e) {
		if (e instanceof RunInteractionAnswerError) error(400, e.message);
		throw e;
	}
});

/** Runs d'un projet (org active), du plus récent au plus ancien. */
export const listRuns = query(z.string(), async (projectId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	return await listRunsForOrg(organizationId, projectId);
});

/** Détail d'un run (org active) avec ses events ordonnés. */
export const getRun = query(z.string(), async (runId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const run = await getRunForOrg(organizationId, runId);
	if (!run) error(404, 'Run not found');
	return run;
});

/** Diff base..head du run (org active), depuis son checkout conservé sur l'hôte. */
export const getRunDiff = query(z.string(), async (runId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	try {
		const diff = await getRunDiffForOrg(organizationId, runId);
		if (!diff) error(404, 'Run not found');
		return diff;
	} catch (e) {
		if (e instanceof RunWorkspaceUnavailableError) error(409, e.message);
		throw e;
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
	if (run.status !== RUN_STATUS.AWAITING_REVIEW) {
		error(400, `Run is not awaiting review (status: ${run.status})`);
	}
	const project = run.project;

	if (action === 'abandon') {
		const canceled = await transitionRun(runId, RUN_STATUS.AWAITING_REVIEW, RUN_STATUS.CANCELED, {
			finishedAt: new Date()
		});
		if (!canceled) error(409, 'Run is no longer awaiting review');
		await removeRunCheckout(run.projectId, runId);
		await getRun(runId).refresh();
		await listRuns(run.projectId).refresh();
		return { status: RUN_STATUS.CANCELED, pullRequestUrl: null };
	}

	// Vérifie le token AVANT de passer en `pushing` : un error(400) ici ne doit pas
	// être avalé par le catch ci-dessous (qui marquerait le run `failed`).
	const token = await getGithubToken(headers);
	if (!token) error(400, 'Connect your GitHub account to push.');

	const claimed = await transitionRun(runId, RUN_STATUS.AWAITING_REVIEW, RUN_STATUS.PUSHING);
	if (!claimed) error(409, 'Run is no longer awaiting review');
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
				run.baseBranch,
				title,
				body
			);
			await prisma.pullRequest.create({
				data: { runId, number: pr.number, url: pr.url, state: pr.state }
			});
			pullRequestUrl = pr.url;
		}

		await transitionRun(runId, RUN_STATUS.PUSHING, RUN_STATUS.COMPLETED, {
			finishedAt: new Date()
		});
		await getRun(runId).refresh();
		await listRuns(run.projectId).refresh();
		return { status: RUN_STATUS.COMPLETED, pullRequestUrl };
	} catch (err) {
		await transitionRun(runId, RUN_STATUS.PUSHING, RUN_STATUS.FAILED, {
			error: String((err as Error)?.message ?? err)
		});
		await getRun(runId).refresh();
		error(500, err instanceof Error ? err.message : 'Push failed');
	}
});
