import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

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
			status: 'pending',
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
			status: 'answered',
			response,
			run: { id: 'r1', projectId: 'p1' }
		};
		runInteractionFindFirstMock.mockResolvedValue({
			id: 'i1',
			status: 'pending',
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
				status: 'pending',
				run: { organizationId: 'org1', status: 'awaiting_input' }
			},
			data: {
				status: 'answered',
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
		expect(runInteractionUpdateMock).not.toHaveBeenCalled();
	});

	it('rejects answering when the run is not awaiting input', async () => {
		runInteractionFindFirstMock.mockResolvedValue({
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
		expect(runInteractionUpdateMock).not.toHaveBeenCalled();
	});

	it('rejects invalid answer selections as RunInteractionAnswerError', async () => {
		runInteractionFindFirstMock.mockResolvedValue({
			id: 'i1',
			status: 'pending',
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
			status: 'pending',
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
				status: 'pending',
				request,
				run: { id: 'r1', projectId: 'p1', status: 'awaiting_input' }
			})
			.mockResolvedValueOnce({
				id: 'i1',
				status: 'answered',
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
				status: 'pending',
				request,
				run: { id: 'r1', projectId: 'p1', status: 'awaiting_input' }
			})
			.mockResolvedValueOnce({
				id: 'i1',
				status: 'canceled',
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
			where: { runId: 'r1', status: 'pending' },
			data: { status: 'canceled' }
		});
	});

	it('waits until an interaction becomes answered and resolves the response', async () => {
		runInteractionFindUniqueMock
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
		runInteractionFindUniqueMock.mockResolvedValue({
			status: 'canceled',
			response: null,
			run: { status: 'awaiting_input' }
		});

		await expect(waitForRunInteractionAnswer('i1', { pollMs: 0 })).rejects.toBeInstanceOf(
			RunInteractionAnswerError
		);
	});
});
