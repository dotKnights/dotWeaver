import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: { runEvent: { findMany: vi.fn() }, run: { findUnique: vi.fn() } }
}));

import { formatSseEvent, isTerminalStatus, streamRunEvents } from './run-stream';
import { prisma } from '$lib/server/prisma';

describe('formatSseEvent', () => {
	it('formats an SSE message with id (seq) and JSON data', () => {
		expect(formatSseEvent(3, { type: 'assistant', text: 'hi' })).toBe(
			'id: 3\ndata: {"type":"assistant","text":"hi"}\n\n'
		);
	});
});

describe('isTerminalStatus', () => {
	it('is true for terminal states', () => {
		for (const s of ['awaiting_review', 'completed', 'failed', 'canceled', 'timed_out'] as const) {
			expect(isTerminalStatus(s)).toBe(true);
		}
	});
	it('is false for active states', () => {
		for (const s of ['queued', 'preparing', 'running', 'pushing'] as const) {
			expect(isTerminalStatus(s)).toBe(false);
		}
	});
});

describe('streamRunEvents', () => {
	beforeEach(() => vi.clearAllMocks());

	it('emet les events par seq croissant puis termine sur statut terminal', async () => {
		(prisma.runEvent.findMany as any)
			.mockResolvedValueOnce([{ seq: 0, payload: { a: 1 } }, { seq: 1, payload: { a: 2 } }])
			.mockResolvedValue([]);
		(prisma.run.findUnique as any).mockResolvedValue({ status: 'completed' });

		const items: any[] = [];
		for await (const it of streamRunEvents('r1', { pollMs: 0, pingEvery: 1000 })) items.push(it);

		expect(items[0]).toEqual({ kind: 'event', seq: 0, payload: { a: 1 } });
		expect(items[1]).toEqual({ kind: 'event', seq: 1, payload: { a: 2 } });
		expect(items.at(-1)).toEqual({ kind: 'done', status: 'completed' });
	});

	it('reprend apres fromSeq (curseur)', async () => {
		(prisma.runEvent.findMany as any).mockResolvedValue([]);
		(prisma.run.findUnique as any).mockResolvedValue({ status: 'completed' });
		const it = streamRunEvents('r1', { fromSeq: 5, pollMs: 0 });
		await it.next();
		expect(prisma.runEvent.findMany).toHaveBeenCalledWith({
			where: { runId: 'r1', seq: { gt: 5 } },
			orderBy: { seq: 'asc' }
		});
	});

	it('s arrete immediatement si signal deja aborte', async () => {
		const ac = new AbortController();
		ac.abort();
		const items: any[] = [];
		for await (const it of streamRunEvents('r1', { signal: ac.signal, pollMs: 0 })) items.push(it);
		expect(items).toEqual([]);
	});
});
