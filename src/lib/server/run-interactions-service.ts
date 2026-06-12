import type { Prisma, RunStatus } from '@prisma/client';
import { prisma } from '$lib/server/prisma';
import {
	answerRunInteractionSchema,
	askUserQuestionRequestSchema,
	validateAskUserQuestionResponse,
	type SerializedAskUserQuestionResponse
} from '$lib/schemas/run-interactions';

const TERMINAL_RUN_STATUSES: RunStatus[] = [
	'awaiting_review',
	'completed',
	'failed',
	'canceled',
	'timed_out'
];

export class PendingRunInteractionError extends Error {
	constructor(runId: string) {
		super(`Run ${runId} already has a pending interaction`);
		this.name = 'PendingRunInteractionError';
	}
}

export class RunInteractionAnswerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RunInteractionAnswerError';
	}
}

export async function createPendingRunInteraction(args: {
	runId: string;
	toolUseId: string;
	request: unknown;
}) {
	const request = askUserQuestionRequestSchema.parse(args.request);

	return prisma.$transaction(async (tx) => {
		const existing = await tx.runInteraction.findFirst({
			where: { runId: args.runId, status: 'pending' },
			select: { id: true }
		});
		if (existing) throw new PendingRunInteractionError(args.runId);

		return tx.runInteraction.create({
			data: {
				runId: args.runId,
				kind: 'ask_user_question',
				status: 'pending',
				toolUseId: args.toolUseId,
				request: request as Prisma.InputJsonValue
			}
		});
	});
}

export async function answerPendingRunInteractionForOrg(organizationId: string, input: unknown) {
	const parsed = answerRunInteractionSchema.parse(input);
	const interaction = await prisma.runInteraction.findFirst({
		where: { id: parsed.interactionId, run: { organizationId } },
		include: { run: { select: { id: true, projectId: true, status: true } } }
	});

	if (!interaction) return null;
	if (interaction.status === 'answered') {
		throw new RunInteractionAnswerError('Interaction has already been answered');
	}
	if (interaction.status === 'canceled') {
		throw new RunInteractionAnswerError('Interaction was canceled');
	}
	if (interaction.run.status !== 'awaiting_input') {
		throw new RunInteractionAnswerError(
			`Run is not awaiting input (status: ${interaction.run.status})`
		);
	}

	const response = validateAskUserQuestionResponse(
		interaction.request,
		parsed.answers,
		parsed.response,
		parsed.annotations
	);
	const updated = await prisma.runInteraction.update({
		where: { id: interaction.id },
		data: {
			status: 'answered',
			response: response as unknown as Prisma.InputJsonValue,
			answeredAt: new Date()
		},
		include: { run: { select: { id: true, projectId: true } } }
	});

	return {
		interaction: updated,
		response,
		runId: updated.run.id,
		projectId: updated.run.projectId
	};
}

export function cancelPendingRunInteractions(runId: string) {
	return prisma.runInteraction.updateMany({
		where: { runId, status: 'pending' },
		data: { status: 'canceled' }
	});
}

function wait(ms: number, signal?: AbortSignal) {
	if (signal?.aborted) {
		return Promise.reject(new RunInteractionAnswerError('Interaction wait aborted'));
	}

	return new Promise<void>((resolve, reject) => {
		let timeout: ReturnType<typeof setTimeout>;
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new RunInteractionAnswerError('Interaction wait aborted'));
		};

		timeout = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export async function waitForRunInteractionAnswer(
	interactionId: string,
	opts: { signal?: AbortSignal; pollMs?: number } = {}
): Promise<SerializedAskUserQuestionResponse> {
	const pollMs = opts.pollMs ?? 1000;

	while (!opts.signal?.aborted) {
		const interaction = await prisma.runInteraction.findUnique({
			where: { id: interactionId },
			select: {
				status: true,
				response: true,
				run: { select: { status: true } }
			}
		});

		if (!interaction) throw new RunInteractionAnswerError('Interaction not found');
		if (interaction.status === 'answered') {
			if (!interaction.response) {
				throw new RunInteractionAnswerError('Interaction answer is missing a response');
			}
			return interaction.response as unknown as SerializedAskUserQuestionResponse;
		}
		if (interaction.status === 'canceled') {
			throw new RunInteractionAnswerError('Interaction was canceled');
		}
		if (TERMINAL_RUN_STATUSES.includes(interaction.run.status)) {
			throw new RunInteractionAnswerError(
				`Run ended while waiting for input (${interaction.run.status})`
			);
		}

		await wait(pollMs, opts.signal);
	}

	throw new RunInteractionAnswerError('Interaction wait aborted');
}
