import { describe, it, expect } from 'vitest';
import { startRunSchema, approveRunSchema, RUN_MODELS } from '$lib/schemas/runs';

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
	it('accepts a valid model', () => {
		for (const m of RUN_MODELS) {
			expect(
				startRunSchema.safeParse({ projectId: 'p1', prompt: 'go', model: m.value }).success
			).toBe(true);
		}
	});
	it('accepts an omitted model (default, no override)', () => {
		expect(startRunSchema.safeParse({ projectId: 'p1', prompt: 'go' }).success).toBe(true);
	});
	it('accepts useProjectAgentConfig when starting a run', () => {
		expect(
			startRunSchema.safeParse({
				projectId: 'p1',
				prompt: 'go',
				useProjectAgentConfig: false
			}).success
		).toBe(true);
	});
	it('rejects an unknown model', () => {
		expect(
			startRunSchema.safeParse({ projectId: 'p1', prompt: 'go', model: 'gpt-5' }).success
		).toBe(false);
	});
});

describe('approveRunSchema', () => {
	it('accepts the three actions', () => {
		for (const action of ['push_pr', 'push', 'abandon'] as const) {
			expect(approveRunSchema.safeParse({ runId: 'r1', action }).success).toBe(true);
		}
	});
	it('rejects an unknown action', () => {
		expect(approveRunSchema.safeParse({ runId: 'r1', action: 'merge' }).success).toBe(false);
	});
	it('rejects a missing runId', () => {
		expect(approveRunSchema.safeParse({ action: 'push' }).success).toBe(false);
	});
});
