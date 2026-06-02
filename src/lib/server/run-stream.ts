import type { RunStatus } from '@prisma/client';
import { prisma } from '$lib/server/prisma';

/** Formate un message SSE : `id` = seq (pour Last-Event-ID), `data` = payload JSON. */
export function formatSseEvent(seq: number, payload: unknown): string {
	return `id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const TERMINAL: RunStatus[] = ['awaiting_review', 'completed', 'failed', 'canceled', 'timed_out'];

/** Un run terminal n'émettra plus d'events → le flux SSE peut se fermer. */
export function isTerminalStatus(status: RunStatus): boolean {
	return TERMINAL.includes(status);
}

export type RunStreamItem =
	| { kind: 'event'; seq: number; payload: unknown }
	| { kind: 'ping' }
	| { kind: 'done'; status: RunStatus };

export interface StreamRunEventsOptions {
	fromSeq?: number;
	pollMs?: number;
	pingEvery?: number;
	signal?: AbortSignal;
}

/**
 * Generator partage : emet les RunEvent par `seq` croissant (curseur), un `ping`
 * periodique, et un `done` final sur statut terminal. Consomme par l'endpoint SSE
 * web ET l'outil MCP. S'arrete sur abort.
 */
export async function* streamRunEvents(
	runId: string,
	opts: StreamRunEventsOptions = {}
): AsyncGenerator<RunStreamItem> {
	const pollMs = opts.pollMs ?? 1000;
	const pingEvery = opts.pingEvery ?? 15;
	let cursor = opts.fromSeq ?? -1;
	let tick = 0;

	while (!opts.signal?.aborted) {
		const events = await prisma.runEvent.findMany({
			where: { runId, seq: { gt: cursor } },
			orderBy: { seq: 'asc' }
		});
		for (const ev of events) {
			yield { kind: 'event', seq: ev.seq, payload: ev.payload };
			cursor = ev.seq;
		}
		const current = await prisma.run.findUnique({
			where: { id: runId },
			select: { status: true }
		});
		if (current && isTerminalStatus(current.status)) {
			yield { kind: 'done', status: current.status };
			return;
		}
		if (++tick % pingEvery === 0) yield { kind: 'ping' };
		if (opts.signal?.aborted) return;
		await new Promise((r) => setTimeout(r, pollMs));
	}
}
