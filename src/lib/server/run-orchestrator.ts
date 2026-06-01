import { prisma } from '$lib/server/prisma';
import { ensureMirror, createRunCheckout, getHeadSha } from '$lib/server/workspace';
import { buildRunArgs, runContainer } from '$lib/server/docker';
import { appendRunEvent, type SdkMessage } from '$lib/server/run-events';
import { authedCloneUrl, getGithubTokenForUser, makeGitAuth } from '$lib/server/github-git';
import { containerName } from '$lib/server/workspace-paths';
import type { RunStatus } from '@prisma/client';

const RUNNER_IMAGE = process.env.RUNNER_IMAGE ?? 'dotweaver-runner';
const DEFAULT_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 30 * 60 * 1000);

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
				CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ''
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

			const { exitCode, timedOut } = await runContainer(
				args,
				(line) => {
					let msg: SdkMessage;
					try {
						msg = JSON.parse(line);
					} catch {
						return;
					}
					if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
						sessionId = (msg as { session_id?: string }).session_id;
					}
					pending.push(appendRunEvent(runId, seq++, msg).catch(() => {}));
				},
				{ timeoutMs, name: containerName(runId) }
			);
			await Promise.all(pending);

			if (timedOut) {
				await transition(runId, 'running', {
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
				await transition(runId, 'running', {
					status: 'failed',
					error: `Container exited with code ${exitCode}`,
					finishedAt: new Date()
				});
			}
		} finally {
			await auth?.cleanup();
		}
	} catch (err) {
		await transition(runId, ['queued', 'preparing', 'running'], {
			status: 'failed',
			error: String((err as Error)?.message ?? err),
			finishedAt: new Date()
		});
	}
}
