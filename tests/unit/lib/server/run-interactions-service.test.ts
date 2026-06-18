import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		$transaction: vi.fn(),
		run: {
			findFirst: vi.fn()
		},
		runInteraction: {
			findFirst: vi.fn(),
			update: vi.fn(),
			findUnique: vi.fn(),
			updateMany: vi.fn()
		}
	}
}));

import { prisma } from '$lib/server/prisma';
import { RUN_INTERACTION_STATUS } from '$lib/domain/run-interaction-status';
import {
	createPendingRunInteraction,
	answerPendingRunInteractionForOrg,
	answerPendingRunQuestionTextForOrg,
	cancelPendingRunInteractions,
	waitForRunInteractionAnswer,
	PendingRunInteractionError,
	RunInteractionAnswerError
} from '$lib/server/run-interactions-service';

type RunInteractionMockDelegate = {
	findFirst?: Mock;
	create?: Mock;
	updateMany?: Mock;
	findUnique?: Mock;
};

type RunInteractionTransaction = {
	runInteraction: RunInteractionMockDelegate;
};

type RunInteractionTransactionCallback = (tx: RunInteractionTransaction) => unknown;

const transactionMock = prisma.$transaction as unknown as Mock;
const runFindFirstMock = prisma.run.findFirst as unknown as Mock;
const runInteractionFindFirstMock = prisma.runInteraction.findFirst as unknown as Mock;
const runInteractionUpdateMock = prisma.runInteraction.update as unknown as Mock;
const runInteractionFindUniqueMock = prisma.runInteraction.findUnique as unknown as Mock;
const runInteractionUpdateManyMock = prisma.runInteraction.updateMany as unknown as Mock;

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

function mockTransaction(runInteraction: RunInteractionMockDelegate) {
	transactionMock.mockImplementationOnce((fn: RunInteractionTransactionCallback) =>
		fn({ runInteraction })
	);
}

function mockAnswerTransaction(updated: unknown, count = 1) {
	const updateMany = vi.fn().mockResolvedValue({ count });
	const findUnique = vi.fn().mockResolvedValue(updated);
	mockTransaction({ updateMany, findUnique });
	return { updateMany, findUnique };
}

describe('run-interactions-service', () => {
	beforeEach(() => vi.resetAllMocks());

	it('creates a pending ask_user_question interaction scoped to a run', async () => {
		const findFirst = vi.fn().mockResolvedValue(null);
		const create = vi.fn().mockResolvedValue({
			id: 'i1',
			runId: 'r1',
			kind: 'ask_user_question',
			status: RUN_INTERACTION_STATUS.PENDING,
			toolUseId: 'toolu_1',
			request
		});
		mockTransaction({ findFirst, create });

		const interaction = await createPendingRunInteraction({
			runId: 'r1',
			toolUseId: 'toolu_1',
			request
		});

		expect(findFirst).toHaveBeenCalledWith({
			where: { runId: 'r1', status: RUN_INTERACTION_STATUS.PENDING },
			select: { id: true }
		});
		expect(create).toHaveBeenCalledWith({
			data: {
				runId: 'r1',
				kind: 'ask_user_question',
				status: RUN_INTERACTION_STATUS.PENDING,
				toolUseId: 'toolu_1',
				request
			}
		});
		expect(interaction).toMatchObject({
			id: 'i1',
			runId: 'r1',
			status: RUN_INTERACTION_STATUS.PENDING
		});
	});

	it('rejects creating a second pending interaction for the same run', async () => {
		const create = vi.fn();
		mockTransaction({
			findFirst: vi.fn().mockResolvedValue({ id: 'existing' }),
			create
		});

		await expect(
			createPendingRunInteraction({ runId: 'r1', toolUseId: 'toolu_2', request })
		).rejects.toBeInstanceOf(PendingRunInteractionError);
		expect(create).not.toHaveBeenCalled();
	});

	it('maps a pending interaction unique constraint race to PendingRunInteractionError', async () => {
		const uniqueError = Object.assign(new Error('Unique constraint failed'), {
			code: 'P2002'
		});
		mockTransaction({
			findFirst: vi.fn().mockResolvedValue(null),
			create: vi.fn().mockRejectedValue(uniqueError)
		});

		await expect(
			createPendingRunInteraction({ runId: 'r1', toolUseId: 'toolu_2', request })
		).rejects.toBeInstanceOf(PendingRunInteractionError);
	});

	it('answers a pending interaction for an awaiting_input run and serializes the response', async () => {
		const response = {
			answers: { 'Which layout?': 'Compact' },
			response: 'Use compact mode',
			annotations: { source: { confidence: 1 } }
		};
		const updated = {
			id: 'i1',
			status: RUN_INTERACTION_STATUS.ANSWERED,
			response,
			run: { id: 'r1', projectId: 'p1' }
		};
		runInteractionFindFirstMock.mockResolvedValue({
			id: 'i1',
			status: RUN_INTERACTION_STATUS.PENDING,
			request,
			run: { id: 'r1', projectId: 'p1', status: 'awaiting_input' }
		});
		const { updateMany, findUnique } = mockAnswerTransaction(updated);

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
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: 'i1',
				status: RUN_INTERACTION_STATUS.PENDING,
				run: { organizationId: 'org1', status: 'awaiting_input' }
			},
			data: {
				status: RUN_INTERACTION_STATUS.ANSWERED,
				response,
				answeredAt: expect.any(Date)
			}
		});
		expect(findUnique).toHaveBeenCalledWith({
			where: { id: 'i1' },
			include: { run: { select: { id: true, projectId: true } } }
		});
		expect(result).toEqual({ interaction: updated, response, runId: 'r1', projectId: 'p1' });
	});

	it('returns null when answering an interaction outside the organization scope', async () => {
		runInteractionFindFirstMock.mockResolvedValue(null);

		await expect(
			answerPendingRunInteractionForOrg('org1', {
				interactionId: 'missing',
				answers: { 'Which layout?': { selected: ['Compact'] } }
			})
		).resolves.toBeNull();
		expect(runInteractionUpdateMock).not.toHaveBeenCalled();
	});

	it('rejects answering an interaction that is not pending', async () => {
		runInteractionFindFirstMock.mockResolvedValue({
			id: 'i1',
			status: RUN_INTERACTION_STATUS.ANSWERED,
			request,
			run: { id: 'r1', projectId: 'p1', status: 'awaiting_input' }
		});

		await expect(
			answerPendingRunInteractionForOrg('org1', {
				interactionId: 'i1',
				answers: { 'Which layout?': { selected: ['Compact'] } }
			})
		).rejects.toBeInstanceOf(RunInteractionAnswerError);
		expect(runInteractionUpdateMock).not.toHaveBeenCalled();
	});

	it('rejects answering when the run is not awaiting input', async () => {
		runInteractionFindFirstMock.mockResolvedValue({
			id: 'i1',
			status: RUN_INTERACTION_STATUS.PENDING,
			request,
			run: { id: 'r1', projectId: 'p1', status: 'running' }
		});

		await expect(
			answerPendingRunInteractionForOrg('org1', {
				interactionId: 'i1',
				answers: { 'Which layout?': { selected: ['Compact'] } }
			})
		).rejects.toBeInstanceOf(RunInteractionAnswerError);
		expect(runInteractionUpdateMock).not.toHaveBeenCalled();
	});

	it('rejects invalid answer selections as RunInteractionAnswerError', async () => {
		runInteractionFindFirstMock.mockResolvedValue({
			id: 'i1',
			status: RUN_INTERACTION_STATUS.PENDING,
			request,
			run: { id: 'r1', projectId: 'p1', status: 'awaiting_input' }
		});

		await expect(
			answerPendingRunInteractionForOrg('org1', {
				interactionId: 'i1',
				answers: { 'Which layout?': { selected: ['Grid'] } }
			})
		).rejects.toBeInstanceOf(RunInteractionAnswerError);
		expect(runInteractionUpdateMock).not.toHaveBeenCalled();
		expect(runInteractionUpdateManyMock).not.toHaveBeenCalled();
	});

	it('rejects missing answers as RunInteractionAnswerError', async () => {
		runInteractionFindFirstMock.mockResolvedValue({
			id: 'i1',
			status: RUN_INTERACTION_STATUS.PENDING,
			request,
			run: { id: 'r1', projectId: 'p1', status: 'awaiting_input' }
		});

		await expect(
			answerPendingRunInteractionForOrg('org1', {
				interactionId: 'i1',
				answers: {}
			})
		).rejects.toBeInstanceOf(RunInteractionAnswerError);
		expect(runInteractionUpdateMock).not.toHaveBeenCalled();
		expect(runInteractionUpdateManyMock).not.toHaveBeenCalled();
	});

	it('maps invalid answer input shape to RunInteractionAnswerError before querying', async () => {
		await expect(
			answerPendingRunInteractionForOrg('org1', {
				interactionId: '',
				answers: { 'Which layout?': { selected: ['Compact'] } }
			})
		).rejects.toBeInstanceOf(RunInteractionAnswerError);
		expect(runInteractionFindFirstMock).not.toHaveBeenCalled();
	});

	it('does not overwrite an answer when a concurrent submit wins the pending row', async () => {
		runInteractionFindFirstMock
			.mockResolvedValueOnce({
				id: 'i1',
				status: RUN_INTERACTION_STATUS.PENDING,
				request,
				run: { id: 'r1', projectId: 'p1', status: 'awaiting_input' }
			})
			.mockResolvedValueOnce({
				id: 'i1',
				status: RUN_INTERACTION_STATUS.ANSWERED,
				request,
				run: { id: 'r1', projectId: 'p1', status: 'running' }
			});
		mockAnswerTransaction(null, 0);

		await expect(
			answerPendingRunInteractionForOrg('org1', {
				interactionId: 'i1',
				answers: { 'Which layout?': { selected: ['Compact'] } }
			})
		).rejects.toBeInstanceOf(RunInteractionAnswerError);
		expect(runInteractionUpdateMock).not.toHaveBeenCalled();
	});

	it('rejects if a pending interaction is canceled before the answer write lands', async () => {
		runInteractionFindFirstMock
			.mockResolvedValueOnce({
				id: 'i1',
				status: RUN_INTERACTION_STATUS.PENDING,
				request,
				run: { id: 'r1', projectId: 'p1', status: 'awaiting_input' }
			})
			.mockResolvedValueOnce({
				id: 'i1',
				status: RUN_INTERACTION_STATUS.CANCELED,
				request,
				run: { id: 'r1', projectId: 'p1', status: 'canceled' }
			});
		mockAnswerTransaction(null, 0);

		await expect(
			answerPendingRunInteractionForOrg('org1', {
				interactionId: 'i1',
				answers: { 'Which layout?': { selected: ['Compact'] } }
			})
		).rejects.toBeInstanceOf(RunInteractionAnswerError);
		expect(runInteractionUpdateMock).not.toHaveBeenCalled();
	});

	it('cancels pending interactions for a run', async () => {
		runInteractionUpdateManyMock.mockResolvedValue({ count: 1 });

		await expect(cancelPendingRunInteractions('r1')).resolves.toEqual({ count: 1 });

		expect(prisma.runInteraction.updateMany).toHaveBeenCalledWith({
			where: { runId: 'r1', status: RUN_INTERACTION_STATUS.PENDING },
			data: { status: RUN_INTERACTION_STATUS.CANCELED }
		});
	});

	it('answers the current pending run interaction from free text', async () => {
		runFindFirstMock.mockResolvedValue({
			id: 'r1',
			projectId: 'p1',
			status: 'awaiting_input',
			interactions: [{ id: 'i1', request }]
		});
		runInteractionFindFirstMock.mockResolvedValue({
			id: 'i1',
			status: RUN_INTERACTION_STATUS.PENDING,
			request,
			run: { id: 'r1', projectId: 'p1', status: 'awaiting_input' }
		});
		const response = {
			answers: { 'Which layout?': 'Compact' },
			response: 'Compact',
			annotations: { source: { channel: 'poke', parser: 'text' } }
		};
		const updated = { id: 'i1', response, run: { id: 'r1', projectId: 'p1' } };
		mockAnswerTransaction(updated);

		await expect(
			answerPendingRunQuestionTextForOrg('org1', { runId: 'r1', message: 'Compact' })
		).resolves.toEqual({ interaction: updated, response, runId: 'r1', projectId: 'p1' });

		expect(runFindFirstMock).toHaveBeenCalledWith({
			where: { id: 'r1', organizationId: 'org1' },
			select: {
				id: true,
				projectId: true,
				interactions: {
					where: { status: RUN_INTERACTION_STATUS.PENDING },
					orderBy: { createdAt: 'desc' },
					take: 1,
					select: { id: true, request: true }
				}
			}
		});
	});

	it('returns null when text-answering a run outside the organization', async () => {
		runFindFirstMock.mockResolvedValue(null);

		await expect(
			answerPendingRunQuestionTextForOrg('org1', { runId: 'missing', message: 'Compact' })
		).resolves.toBeNull();
	});

	it('rejects text-answering when the run has no pending question', async () => {
		runFindFirstMock.mockResolvedValue({
			id: 'r1',
			projectId: 'p1',
			interactions: []
		});

		await expect(
			answerPendingRunQuestionTextForOrg('org1', { runId: 'r1', message: 'Compact' })
		).rejects.toBeInstanceOf(RunInteractionAnswerError);
	});

	it('waits until an interaction becomes answered and resolves the response', async () => {
		runInteractionFindUniqueMock
			.mockResolvedValueOnce({
				status: RUN_INTERACTION_STATUS.PENDING,
				response: null,
				run: { status: 'awaiting_input' }
			})
			.mockResolvedValueOnce({
				status: RUN_INTERACTION_STATUS.ANSWERED,
				response: { answers: { 'Which layout?': 'Compact' } },
				run: { status: 'running' }
			});

		await expect(waitForRunInteractionAnswer('i1', { pollMs: 0 })).resolves.toEqual({
			answers: { 'Which layout?': 'Compact' }
		});
	});

	it('rejects while waiting if the pending interaction is canceled', async () => {
		runInteractionFindUniqueMock.mockResolvedValue({
			status: RUN_INTERACTION_STATUS.CANCELED,
			response: null,
			run: { status: 'awaiting_input' }
		});

		await expect(waitForRunInteractionAnswer('i1', { pollMs: 0 })).rejects.toBeInstanceOf(
			RunInteractionAnswerError
		);
	});
});
