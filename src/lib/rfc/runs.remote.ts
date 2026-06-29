import { query, command, getRequestEvent } from '$app/server';
import { z } from 'zod';
import { error } from '@sveltejs/kit';
import { requireHeaders } from '$lib/server/auth/request';
import { requireActiveOrg } from '$lib/server/auth/org';
import { startRunSchema, replyToRunSchema } from '$lib/schemas/runs';
import { answerRunInteractionSchema } from '$lib/schemas/run-interactions';
import { getGithubToken } from '$lib/server/integrations/github/service';
import { approveRunSchema } from '$lib/schemas/runs';
import { env as privateEnv } from '$env/dynamic/private';
import {
	listRunsForOrg,
	getRunForOrg,
	getRunDiffForOrg,
	RunWorkspaceUnavailableError,
	startRunForOrg,
	cancelRunForOrg,
	approveRunForOrg,
	RunMutationError
} from '$lib/server/runs/service';
import { ProjectAgentConfigError } from '$lib/server/project-agent-config/service';
import {
	answerPendingRunInteractionForOrg,
	RunInteractionAnswerError
} from '$lib/server/runs/interactions-service';
import { replyToRunForOrg, RunReplyError } from '$lib/server/runs/reply-service';

const TIMEOUT_MS = Number(privateEnv.RUN_TIMEOUT_MS ?? 30 * 60 * 1000);

function isBaseBranchError(e: unknown): e is Error {
	return (
		e instanceof Error &&
		(e.message === 'Invalid base branch name' || /^Base branch ".+" was not found$/.test(e.message))
	);
}

function isRunConflictError(e: unknown): e is RunMutationError {
	return e instanceof RunMutationError && e.message === 'Run is no longer awaiting review';
}

/** Crée un run (queued) sur un projet de l'org active et l'enqueue. */
export const startRun = command(
	startRunSchema,
	async ({ projectId, prompt, agent, baseBranch, model, useProjectAgentConfig }) => {
		const headers = requireHeaders();
		const organizationId = await requireActiveOrg(headers);
		const { locals } = getRequestEvent();
		const token = await getGithubToken(headers);
		try {
			const result = await startRunForOrg({
				organizationId,
				userId: locals.user!.id,
				githubToken: token,
				projectId,
				prompt,
				agent,
				baseBranch,
				model,
				useProjectAgentConfig,
				timeoutAt: new Date(Date.now() + TIMEOUT_MS)
			});
			if (!result) error(404, 'Project not found');
			await listRuns(projectId).refresh();
			return { runId: result.runId };
		} catch (e) {
			if (isBaseBranchError(e)) error(400, e.message);
			if (e instanceof ProjectAgentConfigError || e instanceof RunMutationError)
				error(400, e.message);
			throw e;
		}
	}
);

/** Annule un run actif : pose `canceled` (gardé) PUIS tue le conteneur, pour que
 *  l'orchestrateur (transition gardée `running → failed`) ne réécrive pas le statut. */
export const cancelRun = command(z.string(), async (runId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const result = await cancelRunForOrg(organizationId, runId);
	if (!result) error(404, 'Run not found');
	await getRun(runId).refresh();
	await listRuns(result.projectId).refresh();
	return { canceled: result.canceled };
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

/** Répond à un run en `awaiting_review` : enregistre le message et relance la session. */
export const replyToRun = command(replyToRunSchema, async ({ runId, message }) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	try {
		const res = await replyToRunForOrg(organizationId, {
			runId,
			message,
			timeoutAt: new Date(Date.now() + TIMEOUT_MS)
		});
		if (!res) error(404, 'Run not found');
		await getRun(res.runId).refresh();
		await listRuns(res.projectId).refresh();
		return { ok: true };
	} catch (e) {
		if (e instanceof RunReplyError) error(400, e.message);
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
	const token = await getGithubToken(headers);
	let result: Awaited<ReturnType<typeof approveRunForOrg>>;
	try {
		result = await approveRunForOrg({
			organizationId,
			githubToken: token,
			runId,
			action
		});
	} catch (e) {
		if (isRunConflictError(e)) error(409, e.message);
		if (e instanceof RunMutationError) error(400, e.message);
		await getRun(runId).refresh();
		error(500, e instanceof Error ? e.message : 'Push failed');
		throw e;
	}
	if (!result) error(404, 'Run not found');
	await getRun(runId).refresh();
	await listRuns(result.projectId).refresh();
	return { status: result.status, pullRequestUrl: result.pullRequestUrl };
});
