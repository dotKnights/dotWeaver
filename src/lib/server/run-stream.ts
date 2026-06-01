import type { RunStatus } from '@prisma/client';

/** Formate un message SSE : `id` = seq (pour Last-Event-ID), `data` = payload JSON. */
export function formatSseEvent(seq: number, payload: unknown): string {
	return `id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const TERMINAL: RunStatus[] = ['awaiting_review', 'completed', 'failed', 'canceled', 'timed_out'];

/** Un run terminal n'émettra plus d'events → le flux SSE peut se fermer. */
export function isTerminalStatus(status: RunStatus): boolean {
	return TERMINAL.includes(status);
}
