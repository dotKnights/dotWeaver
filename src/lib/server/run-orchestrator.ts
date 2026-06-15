import { prisma } from '$lib/server/prisma';
import { ensureMirror, createRunCheckout, getHeadSha } from '$lib/server/workspace';
import { buildRunArgs, runContainer, type RunContainerControl } from '$lib/server/docker';
import { existsSync } from 'node:fs';
import { appendRunEvent, getNextEventSeq, type SdkMessage } from '$lib/server/run-events';
import { authedCloneUrl, getGithubTokenForUser, makeGitAuth } from '$lib/server/github-git';
import { containerName, runWorktreePath, workspaceRoot } from '$lib/server/workspace-paths';
import {
	cancelPendingRunInteractions,
	createPendingRunInteraction,
	waitForRunInteractionAnswer
} from '$lib/server/run-interactions-service';
import {
	buildRunAgentConfig,
	materializeRunAgentConfig
} from '$lib/server/project-agent-config-service';
import { RUN_STATUS } from '$lib/domain/run-status';
import { transitionRun } from '$lib/server/run-transitions';
import { env as privateEnv } from '$env/dynamic/private';

const RUNNER_IMAGE = privateEnv.RUNNER_IMAGE ?? 'dotweaver-runner';
const DEFAULT_TIMEOUT_MS = Number(privateEnv.RUN_TIMEOUT_MS ?? 30 * 60 * 1000);

function isInteractionRequest(message: SdkMessage): message is SdkMessage & {
	type: 'interaction_request';
	kind: 'ask_user_question';
	toolUseId: string;
	request: unknown;
} {
	return (
		message.type === 'interaction_request' &&
		message.kind === 'ask_user_question' &&
		typeof message.toolUseId === 'string' &&
		Object.prototype.hasOwnProperty.call(message, 'request')
	);
}

/**
 * Exécute un run de bout en bout : mirror → checkout → conteneur agent → events →
 * `awaiting_review`. Transitions conditionnelles : une annulation/timeout concurrente
 * n'est jamais écrasée. Le checkout est CONSERVÉ (Phase 4).
 */
export async function executeRun(runId: string): Promise<void> {
	const run = await prisma.run.findUnique({ where: { id: runId }, include: { project: true } });
	if (!run) throw new Error(`Run ${runId} not found`);
	const project = run.project;
	const isResume = Boolean(run.sessionId && run.pendingPrompt);
	const pending: Promise<void>[] = [];
	const interactionAbort = new AbortController();
	const interactionSetupTasks = new Set<Promise<unknown>>();
	const interactionAnswerTasks = new Set<Promise<unknown>>();

	function trackInteractionTask<T>(tasks: Set<Promise<unknown>>, task: Promise<T>): Promise<T> {
		const tracked = task.finally(() => {
			tasks.delete(tracked);
		});
		tasks.add(tracked);
		void tracked.catch(() => {});
		return task;
	}

	async function waitForInteractionTasks(propagateErrors: boolean): Promise<void> {
		while (interactionSetupTasks.size > 0 || interactionAnswerTasks.size > 0) {
			const tasks = [...interactionSetupTasks, ...interactionAnswerTasks];
			if (propagateErrors) {
				await Promise.all(tasks);
			} else {
				await Promise.allSettled(tasks);
			}
		}
	}

	async function abortAndSettleInteractionTasks(): Promise<void> {
		interactionAbort.abort();
		await waitForInteractionTasks(false);
	}

	// Réclame le job avec la bonne transition initiale.
	if (isResume) {
		if (!(await transitionRun(runId, RUN_STATUS.QUEUED, RUN_STATUS.RUNNING, { pendingPrompt: null }))) {
			return;
		}
	} else {
		if (
			!(await transitionRun(runId, RUN_STATUS.QUEUED, RUN_STATUS.PREPARING, {
				startedAt: new Date()
			}))
		) {
			return;
		}
	}

	try {
		// La reprise n'a besoin ni de mirror ni de clone : le checkout est déjà sur l'hôte.
		const token = isResume ? null : await getGithubTokenForUser(run.createdById);
		const auth = token ? await makeGitAuth(token) : null;
		try {
			let checkoutPath: string;
			let baseSha: string | undefined;

			if (isResume) {
				checkoutPath = runWorktreePath(workspaceRoot(), project.id, runId);
				if (!existsSync(checkoutPath)) {
					await transitionRun(runId, RUN_STATUS.RUNNING, RUN_STATUS.FAILED, {
						error: 'Run workspace is no longer available for resume',
						finishedAt: new Date()
					});
					return;
				}
			} else {
				const cloneUrl = token ? authedCloneUrl(project.cloneUrl) : project.cloneUrl;
				await ensureMirror(project.id, cloneUrl, auth?.env);
				const checkout = await createRunCheckout(project.id, runId, run.baseBranch, auth?.env);
				checkoutPath = checkout.checkoutPath;
				baseSha = checkout.baseSha;
			}

			const agentConfig = await buildRunAgentConfig(run.organizationId, project.id, {
				useProjectAgentConfig: run.useProjectAgentConfig
			});
			if (run.useProjectAgentConfig) {
				await materializeRunAgentConfig(checkoutPath, agentConfig);
			}

			if (!isResume) {
				if (
					!(await transitionRun(runId, RUN_STATUS.PREPARING, RUN_STATUS.RUNNING, {
						baseCommitSha: baseSha,
						agentConfigSnapshot: agentConfig.snapshot
					}))
				) {
					return;
				}
			}

			let seq = await getNextEventSeq(runId);
			let sessionId: string | undefined = run.sessionId ?? undefined;
			const env: Record<string, string> = {
				RUN_PROMPT: isResume ? run.pendingPrompt! : run.prompt,
				CLAUDE_CODE_OAUTH_TOKEN: privateEnv.CLAUDE_CODE_OAUTH_TOKEN ?? '',
				...agentConfig.secretEnv
			};
			if (run.model) env.RUN_MODEL = run.model;
			if (run.sessionId) env.RUN_RESUME_SESSION = run.sessionId;

			const timeoutMs = run.timeoutAt
				? Math.max(1000, run.timeoutAt.getTime() - Date.now())
				: DEFAULT_TIMEOUT_MS;
			const args = buildRunArgs({
				image: RUNNER_IMAGE,
				name: containerName(runId),
				workspacePath: checkoutPath,
				env
			});

			const containerResult = await runContainer(
				args,
				async (line, control: RunContainerControl) => {
					let msg: SdkMessage;
					try {
						msg = JSON.parse(line);
					} catch {
						return;
					}
					if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
						sessionId = (msg as { session_id?: string }).session_id;
					}
					if (isInteractionRequest(msg)) {
						const setupTask = (async () => {
							const interaction = await createPendingRunInteraction({
								runId,
								toolUseId: msg.toolUseId,
								request: msg.request
							});
							pending.push(
								appendRunEvent(runId, seq++, {
									...msg,
									interactionId: interaction.id
								}).catch(() => {})
							);
							await transitionRun(runId, RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_INPUT);
							const answerTask = (async () => {
								const response = await waitForRunInteractionAnswer(interaction.id, {
									signal: interactionAbort.signal
								});
								if (interactionAbort.signal.aborted) return;
								await control.sendControlMessage({
									type: 'interaction_response',
									toolUseId: msg.toolUseId,
									response
								});
								if (interactionAbort.signal.aborted) return;
								await transitionRun(runId, RUN_STATUS.AWAITING_INPUT, RUN_STATUS.RUNNING);
							})().catch((error: unknown) => {
								if (interactionAbort.signal.aborted) return;
								throw error;
							});
							trackInteractionTask(interactionAnswerTasks, answerTask);
						})();
						await trackInteractionTask(interactionSetupTasks, setupTask);
						return;
					}
					pending.push(appendRunEvent(runId, seq++, msg).catch(() => {}));
				},
				{ timeoutMs, name: containerName(runId) }
			);
			const { exitCode, timedOut } = containerResult;

			if (timedOut) {
				await abortAndSettleInteractionTasks();
				await Promise.all(pending);
				await cancelPendingRunInteractions(runId);
				await transitionRun(
					runId,
					[RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_INPUT],
					RUN_STATUS.TIMED_OUT,
					{
						error: 'Run exceeded the time limit',
						finishedAt: new Date()
					}
				);
			} else if (exitCode === 0) {
				await waitForInteractionTasks(true);
				await Promise.all(pending);
				const head = await getHeadSha(checkoutPath, auth?.env);
				await transitionRun(runId, RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_REVIEW, {
					headCommitSha: head,
					sessionId: sessionId ?? null,
					finishedAt: new Date()
				});
			} else {
				await abortAndSettleInteractionTasks();
				await Promise.all(pending);
				await cancelPendingRunInteractions(runId);
				await transitionRun(
					runId,
					[RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_INPUT],
					RUN_STATUS.FAILED,
					{
						error: `Container exited with code ${exitCode}`,
						finishedAt: new Date()
					}
				);
			}
		} finally {
			await auth?.cleanup();
		}
	} catch (err) {
		await abortAndSettleInteractionTasks();
		await Promise.allSettled(pending);
		await cancelPendingRunInteractions(runId);
		await transitionRun(
			runId,
			[RUN_STATUS.QUEUED, RUN_STATUS.PREPARING, RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_INPUT],
			RUN_STATUS.FAILED,
			{
				error: String((err as Error)?.message ?? err),
				finishedAt: new Date()
			}
		);
	}
}
