import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		$transaction: vi.fn(),
		runInteraction: {
			findFirst: vi.fn(),
			update: vi.fn(),
			findUnique: vi.fn(),
			updateMany: vi.fn()
		}
	}
}));

import { prisma } from '$lib/server/prisma';
import {
	createPendingRunInteraction,
	answerPendingRunInteractionForOrg,
	cancelPendingRunInteractions,
	waitForRunInteractionAnswer,
	PendingRunInteractionError,
	RunInteractionAnswerError
} from './run-interactions-service';

const request = {
	questions: [
		{
			question: 'Which layout?',
			header: 'Layout',
			multiSelect: false,
			options: [
				{ label: 'Compact', description: 'Dense inspector' },
				{ label: 'Split', description: 'Events and side panel' }
			]
		}
	]
};

describe('run-interactions-service', () => {
	beforeEach(() => vi.clearAllMocks());

	it('creates a pending ask_user_question interaction scoped to a run', async () => {
		const findFirst = vi.fn().mockResolvedValue(null);
		const create = vi.fn().mockResolvedValue({
			id: 'i1',
			runId: 'r1',
			kind: 'ask_user_question',
			status: 'pending',
			toolUseId: 'toolu_1',
			request
		});
		(prisma.$transaction as any).mockImplementationOnce((fn: any) =>
			fn({ runInteraction: { findFirst, create } })
		);

		const interaction = await createPendingRunInteraction({
			runId: 'r1',
			toolUseId: 'toolu_1',
			request
		});

		expect(findFirst).toHaveBeenCalledWith({
			where: { runId: 'r1', status: 'pending' },
			select: { id: true }
		});
		expect(create).toHaveBeenCalledWith({
			data: {
				runId: 'r1',
				kind: 'ask_user_question',
				status: 'pending',
				toolUseId: 'toolu_1',
				request
			}
		});
		expect(interaction).toMatchObject({ id: 'i1', runId: 'r1', status: 'pending' });
	});

	it('rejects creating a second pending interaction for the same run', async () => {
		const create = vi.fn();
		(prisma.$transaction as any).mockImplementationOnce((fn: any) =>
			fn({
				runInteraction: {
					findFirst: vi.fn().mockResolvedValue({ id: 'existing' }),
					create
				}
			})
		);

		await expect(
			createPendingRunInteraction({ runId: 'r1', toolUseId: 'toolu_2', request })
		).rejects.toBeInstanceOf(PendingRunInteractionError);
		expect(create).not.toHaveBeenCalled();
	});

	it('answers a pending interaction for an awaiting_input run and serializes the response', async () => {
		const response = {
			answers: { 'Which layout?': 'Compact' },
			response: 'Use compact mode',
			annotations: { source: { confidence: 1 } }
		};
		const updated = {
			id: 'i1',
			status: 'answered',
			response,
			run: { id: 'r1', projectId: 'p1' }
		};
		(prisma.runInteraction.findFirst as any).mockResolvedValue({
			id: 'i1',
			status: 'pending',
			request,
			run: { id: 'r1', projectId: 'p1', status: 'awaiting_input' }
		});
		(prisma.runInteraction.update as any).mockResolvedValue(updated);

		const result = await answerPendingRunInteractionForOrg('org1', {
			interactionId: 'i1',
			answers: { 'Which layout?': { selected: ['Compact'] } },
			response: ' Use compact mode ',
			annotations: { source: { confidence: 1 } }
		});

		expect(prisma.runInteraction.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: 'i1', run: { organizationId: 'org1' } }
			})
		);
		expect(prisma.runInteraction.update).toHaveBeenCalledWith({
			where: { id: 'i1' },
			data: {
				status: 'answered',
				response,
				answeredAt: expect.any(Date)
			},
			include: { run: { select: { id: true, projectId: true } } }
		});
		expect(result).toEqual({ interaction: updated, response, runId: 'r1', projectId: 'p1' });
	});

	it('returns null when answering an interaction outside the organization scope', async () => {
		(prisma.runInteraction.findFirst as any).mockResolvedValue(null);

		await expect(
			answerPendingRunInteractionForOrg('org1', {
				interactionId: 'missing',
				answers: { 'Which layout?': { selected: ['Compact'] } }
			})
		).resolves.toBeNull();
		expect(prisma.runInteraction.update).not.toHaveBeenCalled();
	});

	it('rejects answering an interaction that is not pending', async () => {
		(prisma.runInteraction.findFirst as any).mockResolvedValue({
			id: 'i1',
			status: 'answered',
			request,
			run: { id: 'r1', projectId: 'p1', status: 'awaiting_input' }
		});

		await expect(
			answerPendingRunInteractionForOrg('org1', {
				interactionId: 'i1',
				answers: { 'Which layout?': { selected: ['Compact'] } }
			})
		).rejects.toBeInstanceOf(RunInteractionAnswerError);
		expect(prisma.runInteraction.update).not.toHaveBeenCalled();
	});

	it('rejects answering when the run is not awaiting input', async () => {
		(prisma.runInteraction.findFirst as any).mockResolvedValue({
			id: 'i1',
			status: 'pending',
			request,
			run: { id: 'r1', projectId: 'p1', status: 'running' }
		});

		await expect(
			answerPendingRunInteractionForOrg('org1', {
				interactionId: 'i1',
				answers: { 'Which layout?': { selected: ['Compact'] } }
			})
		).rejects.toBeInstanceOf(RunInteractionAnswerError);
		expect(prisma.runInteraction.update).not.toHaveBeenCalled();
	});

	it('cancels pending interactions for a run', async () => {
		(prisma.runInteraction.updateMany as any).mockResolvedValue({ count: 1 });

		await expect(cancelPendingRunInteractions('r1')).resolves.toEqual({ count: 1 });

		expect(prisma.runInteraction.updateMany).toHaveBeenCalledWith({
			where: { runId: 'r1', status: 'pending' },
			data: { status: 'canceled' }
		});
	});

	it('waits until an interaction becomes answered and resolves the response', async () => {
		(prisma.runInteraction.findUnique as any)
			.mockResolvedValueOnce({
				status: 'pending',
				response: null,
				run: { status: 'awaiting_input' }
			})
			.mockResolvedValueOnce({
				status: 'answered',
				response: { answers: { 'Which layout?': 'Compact' } },
				run: { status: 'running' }
			});

		await expect(waitForRunInteractionAnswer('i1', { pollMs: 0 })).resolves.toEqual({
			answers: { 'Which layout?': 'Compact' }
		});
	});

	it('rejects while waiting if the pending interaction is canceled', async () => {
		(prisma.runInteraction.findUnique as any).mockResolvedValue({
			status: 'canceled',
			response: null,
			run: { status: 'awaiting_input' }
		});

		await expect(waitForRunInteractionAnswer('i1', { pollMs: 0 })).rejects.toBeInstanceOf(
			RunInteractionAnswerError
		);
	});
});
