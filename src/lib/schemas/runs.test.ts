import { describe, it, expect } from 'vitest';
import { startRunSchema } from './runs';

describe('startRunSchema', () => {
	it('accepts a project id and a non-empty prompt', () => {
		expect(startRunSchema.safeParse({ projectId: 'p1', prompt: 'do it' }).success).toBe(true);
	});
	it('rejects an empty prompt', () => {
		expect(startRunSchema.safeParse({ projectId: 'p1', prompt: '' }).success).toBe(false);
	});
	it('rejects a missing project id', () => {
		expect(startRunSchema.safeParse({ prompt: 'do it' }).success).toBe(false);
	});
});
