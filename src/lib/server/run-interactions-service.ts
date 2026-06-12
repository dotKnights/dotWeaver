import { Prisma, type RunStatus } from '@prisma/client';
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

function isPrismaUniqueConstraintError(error: unknown): boolean {
	if (error instanceof Prisma.PrismaClientKnownRequestError) {
		return error.code === 'P2002';
	}
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === 'P2002'
	);
}

function assertInteractionCanBeAnswered(interaction: {
	status: 'pending' | 'answered' | 'canceled';
	run: { status: RunStatus };
}): void {
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
}

async function inspectAnswerWriteMiss(organizationId: string, interactionId: string) {
	const interaction = await prisma.runInteraction.findFirst({
		where: { id: interactionId, run: { organizationId } },
		include: { run: { select: { status: true } } }
	});

	if (!interaction) return null;
	assertInteractionCanBeAnswered(interaction);
	throw new RunInteractionAnswerError('Interaction could not be answered');
}

export async function createPendingRunInteraction(args: {
	runId: string;
	toolUseId: string;
	request: unknown;
}) {
	const request = askUserQuestionRequestSchema.parse(args.request);

	try {
		return await prisma.$transaction(async (tx) => {
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
	} catch (error) {
		if (isPrismaUniqueConstraintError(error)) {
			throw new PendingRunInteractionError(args.runId);
		}
		throw error;
	}
}

export async function answerPendingRunInteractionForOrg(organizationId: string, input: unknown) {
	const parsed = answerRunInteractionSchema.safeParse(input);
	if (!parsed.success) throw new RunInteractionAnswerError(parsed.error.message);

	const interaction = await prisma.runInteraction.findFirst({
		where: { id: parsed.data.interactionId, run: { organizationId } },
		include: { run: { select: { id: true, projectId: true, status: true } } }
	});

	if (!interaction) return null;
	assertInteractionCanBeAnswered(interaction);

	let response: SerializedAskUserQuestionResponse;
	try {
		response = validateAskUserQuestionResponse(
			interaction.request,
			parsed.data.answers,
			parsed.data.response,
			parsed.data.annotations
		);
	} catch (error) {
		throw new RunInteractionAnswerError(
			error instanceof Error ? error.message : 'Invalid interaction answer'
		);
	}

	const updated = await prisma.$transaction(async (tx) => {
		const res = await tx.runInteraction.updateMany({
			where: {
				id: interaction.id,
				status: 'pending',
				run: { organizationId, status: 'awaiting_input' }
			},
			data: {
				status: 'answered',
				response: response as unknown as Prisma.InputJsonValue,
				answeredAt: new Date()
			}
		});

		if (res.count !== 1) return null;

		return tx.runInteraction.findUnique({
			where: { id: interaction.id },
			include: { run: { select: { id: true, projectId: true } } }
		});
	});

	if (!updated) {
		return await inspectAnswerWriteMiss(organizationId, parsed.data.interactionId);
	}

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
		function onAbort() {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', onAbort);
			reject(new RunInteractionAnswerError('Interaction wait aborted'));
		}

		const timeout = setTimeout(() => {
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
