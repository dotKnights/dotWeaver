import { env as privateEnv } from '$env/dynamic/private';
import { RUN_MODE, type RunMode } from '$lib/domain/run-mode';
import { RUN_STATUS } from '$lib/domain/run-status';
import { prisma } from '$lib/server/prisma';
import { enqueueRun } from '$lib/server/queue';
import {
	buildRunAgentConfig,
	ProjectAgentConfigError
} from '$lib/server/project-agent-config-service';
import { assertProjectBranchExists } from '$lib/server/project-branches-service';
import { transitionRun } from '$lib/server/run-transitions';
import { getGithubTokenForUser } from '$lib/server/github-git';
import { agentBranch } from '$lib/server/workspace-paths';
import type { RunAgent, RunModel } from '$lib/schemas/runs';

const TIMEOUT_MS = Number(privateEnv.RUN_TIMEOUT_MS ?? 30 * 60 * 1000);

export class RunStartError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RunStartError';
	}
}

export type StartRunForOrgInput = {
	organizationId: string;
	userId: string;
	githubToken?: string | null;
	projectId: string;
	prompt: string;
	agent?: RunAgent;
	baseBranch?: string;
	model?: RunModel;
	useProjectAgentConfig?: boolean;
	mode?: RunMode;
	timeoutAt?: Date;
};

export async function startRunForOrg(input: StartRunForOrgInput) {
	const mode = input.mode ?? RUN_MODE.AGENT;
	const agent = input.agent ?? 'claude';
	const useProjectAgentConfig = input.useProjectAgentConfig ?? true;
	const project = await prisma.project.findFirst({
		where: { id: input.projectId, organizationId: input.organizationId }
	});
	if (!project) return null;

	if (mode === RUN_MODE.CDC && !useProjectAgentConfig) {
		throw new RunStartError('CDC runs require project agent config');
	}

	const effectiveBaseBranch = input.baseBranch ?? project.defaultBranch;
	const token =
		'githubToken' in input
			? (input.githubToken ?? null)
			: await getGithubTokenForUser(input.userId);
	try {
		await assertProjectBranchExists(project, effectiveBaseBranch, token);
	} catch (e) {
		throw new RunStartError(e instanceof Error ? e.message : 'Invalid base branch');
	}

	if (useProjectAgentConfig) {
		try {
			await buildRunAgentConfig(input.organizationId, input.projectId, {
				useProjectAgentConfig: true,
				mode
			});
		} catch (e) {
			if (e instanceof ProjectAgentConfigError) throw new RunStartError(e.message);
			throw e;
		}
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
				model: input.model ?? null,
				mode,
				agent,
				useProjectAgentConfig,
				agentBranch: agentBranch(id),
				baseBranch: effectiveBaseBranch,
				status: RUN_STATUS.QUEUED,
				timeoutAt: input.timeoutAt ?? new Date(Date.now() + TIMEOUT_MS)
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

	return { runId: id, projectId: input.projectId, agent, mode, baseBranch: effectiveBaseBranch };
}
