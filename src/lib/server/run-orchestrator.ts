import { prisma } from '$lib/server/prisma';
import { ensureMirror, createRunCheckout, getHeadSha } from '$lib/server/workspace';
import { buildRunArgs, runContainer } from '$lib/server/docker';
import { appendRunEvent, type SdkMessage } from '$lib/server/run-events';
import { authedCloneUrl, getGithubTokenForUser, makeGitAuth } from '$lib/server/github-git';
import { containerName } from '$lib/server/workspace-paths';

const RUNNER_IMAGE = process.env.RUNNER_IMAGE ?? 'dotweaver-runner';

/**
 * Exécute un run de bout en bout : mirror → checkout → conteneur agent → events →
 * `awaiting_review`. Toute erreur → `failed`. Le checkout est CONSERVÉ (Phase 4).
 */
export async function executeRun(runId: string): Promise<void> {
	const run = await prisma.run.findUnique({ where: { id: runId }, include: { project: true } });
	if (!run) throw new Error(`Run ${runId} not found`);
	const project = run.project;

	try {
		await prisma.run.update({
			where: { id: runId },
			data: { status: 'preparing', startedAt: new Date() }
		});

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
			await prisma.run.update({
				where: { id: runId },
				data: { status: 'running', baseCommitSha: baseSha }
			});

			let seq = 0;
			let sessionId: string | undefined;
			const pending: Promise<void>[] = [];

			const env: Record<string, string> = {
				RUN_PROMPT: run.prompt,
				CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ''
			};
			if (run.model) env.RUN_MODEL = run.model;
			if (run.sessionId) env.RUN_RESUME_SESSION = run.sessionId;

			const args = buildRunArgs({
				image: RUNNER_IMAGE,
				name: containerName(runId),
				workspacePath: checkoutPath,
				env
			});

			const { exitCode } = await runContainer(args, (line) => {
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
			});

			await Promise.all(pending);

			if (exitCode === 0) {
				const head = await getHeadSha(checkoutPath, auth?.env);
				await prisma.run.update({
					where: { id: runId },
					data: {
						status: 'awaiting_review',
						headCommitSha: head,
						sessionId: sessionId ?? null,
						finishedAt: new Date()
					}
				});
			} else {
				await prisma.run.update({
					where: { id: runId },
					data: {
						status: 'failed',
						error: `Container exited with code ${exitCode}`,
						finishedAt: new Date()
					}
				});
			}
		} finally {
			await auth?.cleanup();
		}
	} catch (err) {
		await prisma.run.update({
			where: { id: runId },
			data: {
				status: 'failed',
				error: String((err as Error)?.message ?? err),
				finishedAt: new Date()
			}
		});
	}
}
