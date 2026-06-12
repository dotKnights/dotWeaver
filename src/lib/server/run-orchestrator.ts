import { prisma } from '$lib/server/prisma';
import { ensureMirror, createRunCheckout, getHeadSha } from '$lib/server/workspace';
import { buildRunArgs, runContainer, type RunContainerControl } from '$lib/server/docker';
import { appendRunEvent, type SdkMessage } from '$lib/server/run-events';
import { authedCloneUrl, getGithubTokenForUser, makeGitAuth } from '$lib/server/github-git';
import { containerName } from '$lib/server/workspace-paths';
import {
	cancelPendingRunInteractions,
	createPendingRunInteraction,
	waitForRunInteractionAnswer
} from '$lib/server/run-interactions-service';
import type { RunStatus } from '@prisma/client';
import { env as privateEnv } from '$env/dynamic/private';

const RUNNER_IMAGE = privateEnv.RUNNER_IMAGE ?? 'dotweaver-runner';
const DEFAULT_TIMEOUT_MS = Number(privateEnv.RUN_TIMEOUT_MS ?? 30 * 60 * 1000);

/** Transition conditionnelle : n'écrit que si le run est encore au statut `from`. Renvoie true si appliquée. */
async function transition(
	runId: string,
	from: RunStatus | RunStatus[],
	data: Record<string, unknown>
): Promise<boolean> {
	const res = await prisma.run.updateMany({
		where: { id: runId, status: { in: Array.isArray(from) ? from : [from] } },
		data
	});
	return res.count > 0;
}

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

	if (!(await transition(runId, 'queued', { status: 'preparing', startedAt: new Date() }))) return;

	try {
		const token = await getGithubTokenForUser(run.createdById);
		const auth = token ? await makeGitAuth(token) : null;
		try {
			const cloneUrl = token ? authedCloneUrl(project.cloneUrl) : project.cloneUrl;
			await ensureMirror(project.id, cloneUrl, auth?.env);
			const { checkoutPath, baseSha } = await createRunCheckout(
				project.id,
				runId,
				project.defaultBranch,
				auth?.env
			);

			if (!(await transition(runId, 'preparing', { status: 'running', baseCommitSha: baseSha }))) {
				return;
			}

			let seq = 0;
			let sessionId: string | undefined;
			const pending: Promise<void>[] = [];
			const env: Record<string, string> = {
				RUN_PROMPT: run.prompt,
				CLAUDE_CODE_OAUTH_TOKEN: privateEnv.CLAUDE_CODE_OAUTH_TOKEN ?? ''
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
			const interactionAbort = new AbortController();

			let containerResult: Awaited<ReturnType<typeof runContainer>>;
			try {
				containerResult = await runContainer(
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
							await transition(runId, 'running', { status: 'awaiting_input' });
							const response = await waitForRunInteractionAnswer(interaction.id, {
								signal: interactionAbort.signal
							});
							await control.sendControlMessage({
								type: 'interaction_response',
								toolUseId: msg.toolUseId,
								response
							});
							await transition(runId, 'awaiting_input', { status: 'running' });
							return;
						}
						pending.push(appendRunEvent(runId, seq++, msg).catch(() => {}));
					},
					{ timeoutMs, name: containerName(runId) }
				);
			} finally {
				interactionAbort.abort();
			}
			const { exitCode, timedOut } = containerResult;
			await Promise.all(pending);

			if (timedOut) {
				await cancelPendingRunInteractions(runId);
				await transition(runId, ['running', 'awaiting_input'], {
					status: 'timed_out',
					error: 'Run exceeded the time limit',
					finishedAt: new Date()
				});
			} else if (exitCode === 0) {
				const head = await getHeadSha(checkoutPath, auth?.env);
				await transition(runId, 'running', {
					status: 'awaiting_review',
					headCommitSha: head,
					sessionId: sessionId ?? null,
					finishedAt: new Date()
				});
			} else {
				await cancelPendingRunInteractions(runId);
				await transition(runId, ['running', 'awaiting_input'], {
					status: 'failed',
					error: `Container exited with code ${exitCode}`,
					finishedAt: new Date()
				});
			}
		} finally {
			await auth?.cleanup();
		}
	} catch (err) {
		await transition(runId, ['queued', 'preparing', 'running', 'awaiting_input'], {
			status: 'failed',
			error: String((err as Error)?.message ?? err),
			finishedAt: new Date()
		});
	}
}
