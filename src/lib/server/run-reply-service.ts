import { prisma } from '$lib/server/prisma';
import { appendRunEvent, getNextEventSeq } from '$lib/server/run-events';
import { transitionRun } from '$lib/server/run-transitions';
import { enqueueRun } from '$lib/server/queue';
import { RUN_STATUS } from '$lib/domain/run-status';

export class RunReplyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RunReplyError';
	}
}

/**
 * Enregistre une réponse utilisateur sur un run en `awaiting_review` et le relance :
 * event `user_message`, `pendingPrompt` posé, transition gardée vers `queued`, enqueue.
 * Retourne `null` si le run est absent/hors org.
 */
export async function replyToRunForOrg(
	organizationId: string,
	input: { runId: string; message: string; timeoutAt: Date }
): Promise<{ runId: string; projectId: string } | null> {
	const text = input.message.trim();
	if (!text) throw new RunReplyError('A message is required');

	const run = await prisma.run.findFirst({
		where: { id: input.runId, organizationId },
		select: { id: true, projectId: true, status: true, sessionId: true }
	});
	if (!run) return null;

	if (run.status !== RUN_STATUS.AWAITING_REVIEW) {
		throw new RunReplyError(`Run is not awaiting review (status: ${run.status})`);
	}
	if (!run.sessionId) {
		throw new RunReplyError('This run cannot be resumed (no agent session)');
	}

	const claimed = await transitionRun(run.id, RUN_STATUS.AWAITING_REVIEW, RUN_STATUS.QUEUED, {
		pendingPrompt: text,
		timeoutAt: input.timeoutAt
	});
	if (!claimed) throw new RunReplyError('Run is no longer awaiting review');

	const seq = await getNextEventSeq(run.id);
	await appendRunEvent(run.id, seq, { type: 'user_message', text });

	await enqueueRun(run.id);

	return { runId: run.id, projectId: run.projectId };
}
