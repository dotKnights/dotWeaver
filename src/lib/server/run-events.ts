import type { Prisma, RunEventType } from '@prisma/client';
import { prisma } from '$lib/server/prisma';

export interface SdkMessage {
	type?: string;
	[key: string]: unknown;
}

/** Classe un message SDK (ou de l'entrypoint runner) dans notre enum RunEventType. */
export function classifyMessage(message: SdkMessage): RunEventType {
	switch (message.type) {
		case 'assistant':
			return 'assistant';
		case 'user':
			return 'tool_result';
		case 'result':
			return 'result';
		case 'error':
			return 'error';
		default:
			return 'system';
	}
}

/** Persiste un message comme RunEvent avec un seq monotone (fourni par l'appelant). */
export async function appendRunEvent(
	runId: string,
	seq: number,
	message: SdkMessage
): Promise<void> {
	await prisma.runEvent.create({
		data: {
			runId,
			seq,
			type: classifyMessage(message),
			payload: message as Prisma.InputJsonValue
		}
	});
}
