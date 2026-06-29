import { describe, it, expect } from 'vitest';
import { canTransition, assertTransition } from '$lib/domain/run-status';

describe('run-state', () => {
	it('allows the happy path queued → preparing → running → awaiting_review', () => {
		expect(canTransition('queued', 'preparing')).toBe(true);
		expect(canTransition('preparing', 'running')).toBe(true);
		expect(canTransition('running', 'awaiting_review')).toBe(true);
	});
	it('forbids skipping states or going backwards', () => {
		expect(canTransition('queued', 'awaiting_review')).toBe(false);
		expect(canTransition('completed', 'running')).toBe(false);
	});
	it('allows resuming a finished run: awaiting_review → queued → running', () => {
		expect(canTransition('awaiting_review', 'queued')).toBe(true);
		expect(canTransition('queued', 'running')).toBe(true);
	});
	it('allows failure/cancel from active states', () => {
		expect(canTransition('running', 'failed')).toBe(true);
		expect(canTransition('preparing', 'canceled')).toBe(true);
		expect(canTransition('running', 'timed_out')).toBe(true);
	});
	it('allows awaiting_input pause and resume from running', () => {
		expect(canTransition('running', 'awaiting_input')).toBe(true);
		expect(canTransition('awaiting_input', 'running')).toBe(true);
		expect(canTransition('awaiting_input', 'canceled')).toBe(true);
		expect(canTransition('awaiting_input', 'timed_out')).toBe(true);
		expect(canTransition('awaiting_input', 'failed')).toBe(true);
		expect(canTransition('awaiting_input', 'completed')).toBe(false);
	});
	it('assertTransition throws on an invalid transition', () => {
		expect(() => assertTransition('queued', 'completed')).toThrow(/Invalid run transition/);
	});
});
