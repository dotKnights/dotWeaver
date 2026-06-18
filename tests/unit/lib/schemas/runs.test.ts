import { describe, it, expect } from 'vitest';
import {
	approveRunSchema,
	CLAUDE_RUN_MODELS,
	CODEX_RUN_MODELS,
	RUN_AGENTS,
	replyToRunSchema,
	startRunSchema
} from '$lib/schemas/runs';

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
	it('accepts a valid Claude model by default', () => {
		for (const m of CLAUDE_RUN_MODELS) {
			expect(
				startRunSchema.safeParse({ projectId: 'p1', prompt: 'go', model: m.value }).success
			).toBe(true);
		}
	});
	it('accepts each supported agent', () => {
		for (const agent of RUN_AGENTS) {
			expect(
				startRunSchema.safeParse({ projectId: 'p1', prompt: 'go', agent: agent.value }).success
			).toBe(true);
		}
	});
	it('defaults agent to claude', () => {
		const parsed = startRunSchema.parse({ projectId: 'p1', prompt: 'go' });
		expect(parsed.agent).toBe('claude');
	});
	it('accepts Codex models only for Codex runs', () => {
		for (const model of CODEX_RUN_MODELS) {
			expect(
				startRunSchema.safeParse({
					projectId: 'p1',
					prompt: 'go',
					agent: 'codex',
					model: model.value
				}).success
			).toBe(true);
			expect(
				startRunSchema.safeParse({
					projectId: 'p1',
					prompt: 'go',
					agent: 'claude',
					model: model.value
				}).success
			).toBe(false);
		}
	});
	it('accepts Claude models only for Claude runs', () => {
		for (const model of CLAUDE_RUN_MODELS) {
			expect(
				startRunSchema.safeParse({
					projectId: 'p1',
					prompt: 'go',
					agent: 'claude',
					model: model.value
				}).success
			).toBe(true);
			expect(
				startRunSchema.safeParse({
					projectId: 'p1',
					prompt: 'go',
					agent: 'codex',
					model: model.value
				}).success
			).toBe(false);
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
	it('accepts a baseBranch when starting a run', () => {
		const parsed = startRunSchema.parse({
			projectId: 'p1',
			prompt: 'go',
			baseBranch: 'feature/login'
		});

		expect(parsed.baseBranch).toBe('feature/login');
	});
	it('rejects an empty baseBranch', () => {
		expect(
			startRunSchema.safeParse({
				projectId: 'p1',
				prompt: 'go',
				baseBranch: ''
			}).success
		).toBe(false);
	});
	it('defaults useProjectAgentConfig to true', () => {
		const parsed = startRunSchema.parse({ projectId: 'p1', prompt: 'go' });
		expect(parsed.useProjectAgentConfig).toBe(true);
	});
	it('rejects an unknown model', () => {
		expect(
			startRunSchema.safeParse({ projectId: 'p1', prompt: 'go', model: 'gpt-5' }).success
		).toBe(false);
	});
	it('rejects an unknown agent', () => {
		expect(
			startRunSchema.safeParse({ projectId: 'p1', prompt: 'go', agent: 'gemini' }).success
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

describe('replyToRunSchema', () => {
	it('accepts a runId and a non-empty message', () => {
		const parsed = replyToRunSchema.safeParse({ runId: 'r1', message: 'continue please' });
		expect(parsed.success).toBe(true);
	});

	it('rejects an empty message', () => {
		const parsed = replyToRunSchema.safeParse({ runId: 'r1', message: '' });
		expect(parsed.success).toBe(false);
	});

	it('rejects a missing runId', () => {
		const parsed = replyToRunSchema.safeParse({ message: 'hi' });
		expect(parsed.success).toBe(false);
	});
});
