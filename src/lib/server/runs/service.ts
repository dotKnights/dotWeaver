import { existsSync } from 'node:fs';
import type { RunStatus } from '@prisma/client';
import { prisma } from '$lib/server/prisma';
import { computeDiff } from '$lib/server/projects/diff';
import {
	agentBranch,
	containerName,
	runWorktreePath,
	workspaceRoot
} from '$lib/server/projects/workspace-paths';
import { RUN_INTERACTION_STATUS } from '$lib/domain/run-interaction-status';
import { RUN_STATUS, RUN_STATUS_GROUPS } from '$lib/domain/run-status';
import type { RunAgent, RunModel } from '$lib/schemas/runs';
import { assertProjectBranchExists } from '$lib/server/projects/branches';
import { buildRunAgentConfig } from '$lib/server/project-agent-config-service';
import { enqueueRun } from '$lib/server/runtime/queue';
import { transitionRun } from './transitions';
import { cancelPendingRunInteractions } from './interactions-service';
import { killContainer } from '$lib/server/runtime/docker';
import { pushBranch, openPullRequest } from '$lib/server/integrations/github/pull-requests';
import { removeRunCheckout } from '$lib/server/projects/workspace';

/** Levee quand le checkout d'un run n'existe plus sur l'hote (mappee 409 cote web). */
export class RunWorkspaceUnavailableError extends Error {
	constructor() {
		super(
			'Run workspace is no longer available (cleaned up, or this server uses a different WORKSPACE_ROOT than the worker).'
		);
		this.name = 'RunWorkspaceUnavailableError';
	}
}

export class RunMutationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RunMutationError';
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
			agent: true,
			queuedAt: true,
			finishedAt: true,
			error: true,
			agentBranch: true,
			baseBranch: true
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
				where: { status: RUN_INTERACTION_STATUS.PENDING },
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

export async function startRunForOrg(input: {
	organizationId: string;
	userId: string;
	githubToken: string | null;
	projectId: string;
	prompt: string;
	agent?: RunAgent;
	baseBranch?: string;
	model?: RunModel;
	useProjectAgentConfig: boolean;
	timeoutAt: Date;
}): Promise<{ runId: string; projectId: string } | null> {
	const project = await prisma.project.findFirst({
		where: { id: input.projectId, organizationId: input.organizationId }
	});
	if (!project) return null;

	const effectiveBaseBranch = input.baseBranch ?? project.defaultBranch;
	await assertProjectBranchExists(project, effectiveBaseBranch, input.githubToken);

	if (input.useProjectAgentConfig) {
		await buildRunAgentConfig(input.organizationId, input.projectId, {
			useProjectAgentConfig: true
		});
	}

	const id = crypto.randomUUID();
	let created = false;
	try {
		await prisma.run.create({
			data: {
				id,
				projectId: input.projectId,
				organizationId: input.organizationId,
				createdById: input.userId,
				prompt: input.prompt,
				agent: input.agent ?? 'claude',
				model: input.model ?? null,
				useProjectAgentConfig: input.useProjectAgentConfig,
				agentBranch: agentBranch(id),
				baseBranch: effectiveBaseBranch,
				status: RUN_STATUS.QUEUED,
				timeoutAt: input.timeoutAt
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

	return { runId: id, projectId: input.projectId };
}

export async function cancelRunForOrg(
	organizationId: string,
	runId: string
): Promise<{ canceled: boolean; projectId: string } | null> {
	const run = await prisma.run.findFirst({
		where: { id: runId, organizationId },
		select: { id: true, status: true, projectId: true }
	});
	if (!run) return null;

	const canceled = await transitionRun(runId, RUN_STATUS_GROUPS.CANCELABLE, RUN_STATUS.CANCELED, {
		finishedAt: new Date()
	});
	if (canceled) {
		await cancelPendingRunInteractions(runId);
		await killContainer(containerName(runId));
	}

	return { canceled, projectId: run.projectId };
}

export async function approveRunForOrg(input: {
	organizationId: string;
	githubToken: string | null;
	runId: string;
	action: 'push_pr' | 'push' | 'abandon';
}): Promise<{ status: RunStatus; pullRequestUrl: string | null; projectId: string } | null> {
	const run = await prisma.run.findFirst({
		where: { id: input.runId, organizationId: input.organizationId },
		include: { project: true }
	});
	if (!run) return null;
	if (run.status !== RUN_STATUS.AWAITING_REVIEW) {
		throw new RunMutationError(`Run is not awaiting review (status: ${run.status})`);
	}

	if (input.action === 'abandon') {
		const canceled = await transitionRun(
			input.runId,
			RUN_STATUS.AWAITING_REVIEW,
			RUN_STATUS.CANCELED,
			{ finishedAt: new Date() }
		);
		if (!canceled) throw new RunMutationError('Run is no longer awaiting review');
		await removeRunCheckout(run.projectId, input.runId);
		return { status: RUN_STATUS.CANCELED, pullRequestUrl: null, projectId: run.projectId };
	}

	if (!input.githubToken) {
		throw new RunMutationError('Connect your GitHub account to continue');
	}

	const claimed = await transitionRun(input.runId, RUN_STATUS.AWAITING_REVIEW, RUN_STATUS.PUSHING);
	if (!claimed) throw new RunMutationError('Run is no longer awaiting review');

	try {
		const checkout = runWorktreePath(workspaceRoot(), run.projectId, input.runId);
		await pushBranch(checkout, run.project.cloneUrl, run.agentBranch, input.githubToken);

		let pullRequestUrl: string | null = null;
		if (input.action === 'push_pr') {
			const title =
				run.prompt.split('\n')[0].slice(0, 72) || `dotWeaver run ${input.runId.slice(0, 8)}`;
			const body = `Automated changes from a dotWeaver agent run.\n\n**Prompt:**\n\n> ${run.prompt}`;
			const pr = await openPullRequest(
				input.githubToken,
				run.project.owner,
				run.project.name,
				run.agentBranch,
				run.baseBranch,
				title,
				body
			);
			await prisma.pullRequest.create({
				data: { runId: input.runId, number: pr.number, url: pr.url, state: pr.state }
			});
			pullRequestUrl = pr.url;
		}

		await transitionRun(input.runId, RUN_STATUS.PUSHING, RUN_STATUS.COMPLETED, {
			finishedAt: new Date()
		});
		return { status: RUN_STATUS.COMPLETED, pullRequestUrl, projectId: run.projectId };
	} catch (err) {
		await transitionRun(input.runId, RUN_STATUS.PUSHING, RUN_STATUS.FAILED, {
			error: String((err as Error)?.message ?? err)
		});
		throw err;
	}
}
