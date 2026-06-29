import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		runEvent: {
			aggregate: vi.fn(),
			create: vi.fn()
		}
	}
}));

import { prisma } from '$lib/server/prisma';
import { classifyMessage, getNextEventSeq } from '$lib/server/runs/events';

const aggregateMock = prisma.runEvent.aggregate as unknown as Mock;

describe('classifyMessage', () => {
	it('maps known SDK message types to RunEventType', () => {
		expect(classifyMessage({ type: 'assistant' })).toBe('assistant');
		expect(classifyMessage({ type: 'user' })).toBe('tool_result');
		expect(classifyMessage({ type: 'result' })).toBe('result');
		expect(classifyMessage({ type: 'error' })).toBe('error');
		expect(classifyMessage({ type: 'system' })).toBe('system');
	});
	it('maps user_message to its own RunEventType', () => {
		expect(classifyMessage({ type: 'user_message' })).toBe('user_message');
	});
	it('falls back to system for unknown/missing types', () => {
		expect(classifyMessage({ type: 'runner_summary' })).toBe('system');
		expect(classifyMessage({})).toBe('system');
	});
});

describe('getNextEventSeq', () => {
	beforeEach(() => vi.resetAllMocks());

	it('returns 0 when the run has no events yet', async () => {
		aggregateMock.mockResolvedValue({ _max: { seq: null } });
		await expect(getNextEventSeq('r1')).resolves.toBe(0);
	});

	it('returns max seq + 1 when events exist', async () => {
		aggregateMock.mockResolvedValue({ _max: { seq: 7 } });
		await expect(getNextEventSeq('r1')).resolves.toBe(8);
		expect(aggregateMock).toHaveBeenCalledWith({ where: { runId: 'r1' }, _max: { seq: true } });
	});
});
