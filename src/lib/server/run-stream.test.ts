import { describe, it, expect } from 'vitest';
import { formatSseEvent, isTerminalStatus } from './run-stream';

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
