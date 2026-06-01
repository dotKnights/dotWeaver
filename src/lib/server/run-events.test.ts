import { describe, it, expect } from 'vitest';
import { classifyMessage } from './run-events';

describe('classifyMessage', () => {
	it('maps known SDK message types to RunEventType', () => {
		expect(classifyMessage({ type: 'assistant' })).toBe('assistant');
		expect(classifyMessage({ type: 'user' })).toBe('tool_result');
		expect(classifyMessage({ type: 'result' })).toBe('result');
		expect(classifyMessage({ type: 'error' })).toBe('error');
		expect(classifyMessage({ type: 'system' })).toBe('system');
	});
	it('falls back to system for unknown/missing types', () => {
		expect(classifyMessage({ type: 'runner_summary' })).toBe('system');
		expect(classifyMessage({})).toBe('system');
	});
});
