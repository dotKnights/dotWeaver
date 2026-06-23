import { describe, it, expect } from 'vitest';
import {
	describeToolUse,
	normalizeEvent,
	normalizeTimeline,
	normalizeTimelineEntries
} from '$lib/components/runs/run-event-display';

describe('describeToolUse', () => {
	it('shows the command for Bash', () => {
		expect(describeToolUse('Bash', { command: 'ls /workspace' })).toEqual({
			title: 'Bash',
			detail: 'ls /workspace'
		});
	});
	it('shows the file path for Write/Edit/Read', () => {
		expect(describeToolUse('Write', { file_path: '/workspace/NOTES.md' }).detail).toBe(
			'/workspace/NOTES.md'
		);
		expect(describeToolUse('Edit', { file_path: 'a.ts' }).title).toBe('Edit');
		expect(describeToolUse('Read', { file_path: 'b.ts' }).detail).toBe('b.ts');
	});
	it('shows the pattern for Glob/Grep', () => {
		expect(describeToolUse('Glob', { pattern: '**/*.ts' }).detail).toBe('**/*.ts');
		expect(describeToolUse('Grep', { pattern: 'TODO' }).detail).toBe('TODO');
	});
	it('falls back to JSON for unknown tools', () => {
		expect(describeToolUse('Mystery', { a: 1 })).toEqual({ title: 'Mystery', detail: '{"a":1}' });
	});
});

describe('normalizeEvent', () => {
	it('splits an assistant message into thinking_stream/text/tool_use items', () => {
		const out = normalizeEvent({
			type: 'assistant',
			message: {
				content: [
					{ type: 'thinking', thinking: 'hmm' },
					{ type: 'text', text: 'Hello **world**' },
					{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }
				]
			}
		});
		expect(out.map((e) => e.kind)).toEqual(['thinking_stream', 'assistant_text', 'tool_use']);
		expect(out[0]).toEqual({
			kind: 'thinking_stream',
			text: 'hmm',
			estimatedTokens: null,
			deltaTokens: null,
			streaming: false
		});
		expect(out[1]).toEqual({ kind: 'assistant_text', markdown: 'Hello **world**' });
		expect(out[2]).toMatchObject({ kind: 'tool_use', tool: 'Bash', detail: 'ls' });
	});
	it('maps a user tool_result (with is_error)', () => {
		const out = normalizeEvent({
			type: 'user',
			message: { content: [{ type: 'tool_result', content: 'oops', is_error: true }] }
		});
		expect(out).toEqual([{ kind: 'tool_result', text: 'oops', isError: true }]);
	});
	it('joins array tool_result content into text', () => {
		const out = normalizeEvent({
			type: 'user',
			message: {
				content: [
					{
						type: 'tool_result',
						content: [
							{ type: 'text', text: 'a' },
							{ type: 'text', text: 'b' }
						]
					}
				]
			}
		});
		expect(out).toEqual([{ kind: 'tool_result', text: 'a\nb', isError: false }]);
	});
	it('maps a result event', () => {
		const out = normalizeEvent({
			type: 'result',
			subtype: 'success',
			is_error: false,
			num_turns: 2,
			total_cost_usd: 0.02,
			duration_ms: 1500,
			result: 'done'
		});
		expect(out[0]).toEqual({
			kind: 'result',
			isError: false,
			subtype: 'success',
			numTurns: 2,
			costUsd: 0.02,
			durationMs: 1500,
			text: 'done'
		});
	});
	it('maps system:init to session_start', () => {
		expect(normalizeEvent({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' })).toEqual(
			[{ kind: 'session_start', model: 'claude-sonnet-4-6' }]
		);
	});
	it('maps subagent task events', () => {
		expect(
			normalizeEvent({ type: 'system', subtype: 'task_started', prompt: 'Explore the repo' })[0]
		).toMatchObject({ kind: 'subagent', phase: 'started' });
		expect(
			normalizeEvent({ type: 'system', subtype: 'task_progress', description: 'find …' })[0]
		).toMatchObject({ kind: 'subagent', phase: 'progress', label: 'find …' });
		expect(
			normalizeEvent({
				type: 'system',
				subtype: 'task_notification',
				summary: 'Explore',
				status: 'completed'
			})[0]
		).toMatchObject({ kind: 'subagent', phase: 'done', status: 'completed' });
	});
	it('maps rate_limit_event', () => {
		expect(
			normalizeEvent({
				type: 'rate_limit_event',
				rate_limit_info: { status: 'allowed', resetsAt: 123 }
			})
		).toEqual([{ kind: 'rate_limit', status: 'allowed', resetsAt: 123 }]);
	});
	it('hides runner_summary', () => {
		expect(normalizeEvent({ type: 'runner_summary', head: 'abc' })).toEqual([{ kind: 'hidden' }]);
	});
	it('hides internal interaction_request events', () => {
		expect(normalizeEvent({ type: 'interaction_request', interactionId: 'i1' })).toEqual([
			{ kind: 'hidden' }
		]);
	});
	it('hides AskUserQuestion tool_use events because the interaction card renders them', () => {
		expect(
			normalizeEvent({
				type: 'assistant',
				message: {
					content: [
						{
							type: 'tool_use',
							name: 'AskUserQuestion',
							input: { questions: [] }
						}
					]
				}
			})
		).toEqual([{ kind: 'hidden' }]);

		expect(
			normalizeEvent({
				type: 'assistant',
				message: {
					content: [
						{
							type: 'tool_use',
							name: 'mcp__dotweaver__AskUserQuestion',
							input: { questions: [] }
						}
					]
				}
			})
		).toEqual([{ kind: 'hidden' }]);
	});
	it('falls back to raw for unknown types', () => {
		expect(normalizeEvent({ type: 'totally_new', foo: 1 })[0].kind).toBe('raw');
	});
	it('never throws on malformed input', () => {
		expect(() => normalizeEvent(null)).not.toThrow();
		expect(() => normalizeEvent({})).not.toThrow();
		expect(normalizeEvent(null)[0].kind).toBe('raw');
	});
});

describe('normalizeEvent — user_message', () => {
	it('maps a user_message payload to a user_message display event', () => {
		expect(normalizeEvent({ type: 'user_message', text: 'please continue' })).toEqual([
			{ kind: 'user_message', text: 'please continue' }
		]);
	});

	it('tolerates a missing text field', () => {
		expect(normalizeEvent({ type: 'user_message' })).toEqual([{ kind: 'user_message', text: '' }]);
	});
});

describe('normalizeTimeline', () => {
	const thinkingTokens = (estimatedTokens: unknown, deltaTokens: unknown) => ({
		type: 'system',
		subtype: 'thinking_tokens',
		estimated_tokens: estimatedTokens,
		estimated_tokens_delta: deltaTokens
	});

	it('merges consecutive thinking token payloads into one thinking_stream event', () => {
		expect(normalizeTimeline([thinkingTokens(36, 12), thinkingTokens(88, 52)])).toEqual([
			{
				kind: 'thinking_stream',
				text: null,
				estimatedTokens: 88,
				deltaTokens: 64,
				streaming: true
			}
		]);
	});

	it('merges final assistant thinking text into the active stream and stops streaming', () => {
		expect(
			normalizeTimeline([
				thinkingTokens(36, 12),
				{ type: 'runner_summary', head: 'hidden events do not split streams' },
				{
					type: 'assistant',
					message: { content: [{ type: 'thinking', thinking: 'I have the answer now.' }] }
				}
			])
		).toEqual([
			{
				kind: 'thinking_stream',
				text: 'I have the answer now.',
				estimatedTokens: 36,
				deltaTokens: 12,
				streaming: false
			}
		]);
	});

	it('splits thinking streams around tool calls', () => {
		expect(
			normalizeTimeline([
				thinkingTokens(10, 10),
				{
					type: 'assistant',
					message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }] }
				},
				thinkingTokens(25, 15)
			])
		).toEqual([
			{
				kind: 'thinking_stream',
				text: null,
				estimatedTokens: 10,
				deltaTokens: 10,
				streaming: true
			},
			{ kind: 'tool_use', tool: 'Bash', title: 'Bash', detail: 'pwd' },
			{
				kind: 'thinking_stream',
				text: null,
				estimatedTokens: 25,
				deltaTokens: 15,
				streaming: true
			}
		]);
	});

	it('does not render thinking_tokens as raw display events', () => {
		const out = normalizeTimeline([thinkingTokens(88, 52)]);

		expect(out.some((event) => event.kind === 'raw')).toBe(false);
		expect(JSON.stringify(out)).not.toContain('thinking_tokens');
	});

	it('preserves existing assistant text, tool, result, user result, and user_message behavior', () => {
		expect(
			normalizeTimeline([
				{
					type: 'assistant',
					message: {
						content: [
							{ type: 'text', text: 'Hello **world**' },
							{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }
						]
					}
				},
				{
					type: 'result',
					subtype: 'success',
					is_error: false,
					num_turns: 2,
					total_cost_usd: 0.02,
					duration_ms: 1500,
					result: 'done'
				},
				{
					type: 'user',
					message: { content: [{ type: 'tool_result', content: 'ok', is_error: false }] }
				},
				{ type: 'user_message', text: 'please continue' }
			])
		).toEqual([
			{ kind: 'assistant_text', markdown: 'Hello **world**' },
			{ kind: 'tool_use', tool: 'Bash', title: 'Bash', detail: 'ls' },
			{
				kind: 'result',
				isError: false,
				subtype: 'success',
				numTurns: 2,
				costUsd: 0.02,
				durationMs: 1500,
				text: 'done'
			},
			{ kind: 'tool_result', text: 'ok', isError: false },
			{ kind: 'user_message', text: 'please continue' }
		]);
	});

	it('keeps stable keys when thinking token chunks are merged', () => {
		const out = normalizeTimelineEntries([
			{ key: 7, payload: thinkingTokens(10, 10) },
			{ key: 8, payload: thinkingTokens(25, 15) },
			{
				key: 9,
				payload: {
					type: 'assistant',
					message: {
						content: [
							{ type: 'thinking', thinking: 'Ready.' },
							{ type: 'text', text: 'Done' }
						]
					}
				}
			}
		]);

		expect(out).toEqual([
			{
				key: '7',
				event: {
					kind: 'thinking_stream',
					text: 'Ready.',
					estimatedTokens: 25,
					deltaTokens: 25,
					streaming: false
				}
			},
			{ key: '9:1', event: { kind: 'assistant_text', markdown: 'Done' } }
		]);
	});
});
