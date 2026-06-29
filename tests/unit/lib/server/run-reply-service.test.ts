import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: { run: { findFirst: vi.fn() } }
}));
vi.mock('$lib/server/runs/events', () => ({
	getNextEventSeq: vi.fn(),
	appendRunEvent: vi.fn()
}));
vi.mock('$lib/server/runs/transitions', () => ({ transitionRun: vi.fn() }));
vi.mock('$lib/server/queue', () => ({ enqueueRun: vi.fn() }));

import { prisma } from '$lib/server/prisma';
import { getNextEventSeq, appendRunEvent } from '$lib/server/runs/events';
import { transitionRun } from '$lib/server/runs/transitions';
import { enqueueRun } from '$lib/server/queue';
import { replyToRunForOrg, RunReplyError } from '$lib/server/runs/reply-service';
import { RUN_STATUS } from '$lib/domain/run-status';

const findFirst = prisma.run.findFirst as unknown as Mock;
const nextSeq = getNextEventSeq as unknown as Mock;
const append = appendRunEvent as unknown as Mock;
const transition = transitionRun as unknown as Mock;
const enqueue = enqueueRun as unknown as Mock;

const timeoutAt = new Date('2026-06-15T12:00:00Z');

beforeEach(() => vi.resetAllMocks());

describe('replyToRunForOrg', () => {
	it('rejects an empty message', async () => {
		await expect(
			replyToRunForOrg('org1', { runId: 'r1', message: '   ', timeoutAt })
		).rejects.toBeInstanceOf(RunReplyError);
		expect(findFirst).not.toHaveBeenCalled();
	});

	it('returns null when the run is not found in the org', async () => {
		findFirst.mockResolvedValue(null);
		await expect(
			replyToRunForOrg('org1', { runId: 'r1', message: 'hi', timeoutAt })
		).resolves.toBeNull();
	});

	it('rejects when the run is not awaiting review', async () => {
		findFirst.mockResolvedValue({
			id: 'r1',
			projectId: 'p1',
			status: RUN_STATUS.RUNNING,
			sessionId: 's1'
		});
		await expect(
			replyToRunForOrg('org1', { runId: 'r1', message: 'hi', timeoutAt })
		).rejects.toThrow(/awaiting review/i);
	});

	it('rejects when the run has no session to resume', async () => {
		findFirst.mockResolvedValue({
			id: 'r1',
			projectId: 'p1',
			status: RUN_STATUS.AWAITING_REVIEW,
			sessionId: null
		});
		await expect(
			replyToRunForOrg('org1', { runId: 'r1', message: 'hi', timeoutAt })
		).rejects.toThrow(/cannot be resumed/i);
	});

	it('records the message, queues the run and enqueues a job', async () => {
		findFirst.mockResolvedValue({
			id: 'r1',
			projectId: 'p1',
			status: RUN_STATUS.AWAITING_REVIEW,
			sessionId: 's1'
		});
		transition.mockResolvedValue(true);
		nextSeq.mockResolvedValue(5);

		const res = await replyToRunForOrg('org1', {
			runId: 'r1',
			message: '  please continue  ',
			timeoutAt
		});

		expect(res).toEqual({ runId: 'r1', projectId: 'p1' });
		expect(transition).toHaveBeenCalledWith('r1', RUN_STATUS.AWAITING_REVIEW, RUN_STATUS.QUEUED, {
			pendingPrompt: 'please continue',
			timeoutAt
		});
		expect(append).toHaveBeenCalledWith('r1', 5, {
			type: 'user_message',
			text: 'please continue'
		});
		expect(enqueue).toHaveBeenCalledWith('r1');
	});

	it('does not enqueue when the transition is lost to a concurrent action', async () => {
		findFirst.mockResolvedValue({
			id: 'r1',
			projectId: 'p1',
			status: RUN_STATUS.AWAITING_REVIEW,
			sessionId: 's1'
		});
		transition.mockResolvedValue(false);

		await expect(
			replyToRunForOrg('org1', { runId: 'r1', message: 'hi', timeoutAt })
		).rejects.toThrow(/no longer awaiting review/i);
		expect(enqueue).not.toHaveBeenCalled();
	});
});
