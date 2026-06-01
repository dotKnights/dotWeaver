import { describe, it, expect } from 'vitest';
import { describeToolUse, normalizeEvent } from './run-event-display';

describe('describeToolUse', () => {
	it('shows the command for Bash', () => {
		expect(describeToolUse('Bash', { command: 'ls /workspace' })).toEqual({ title: 'Bash', detail: 'ls /workspace' });
	});
	it('shows the file path for Write/Edit/Read', () => {
		expect(describeToolUse('Write', { file_path: '/workspace/NOTES.md' }).detail).toBe('/workspace/NOTES.md');
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
	it('splits an assistant message into thinking/text/tool_use items', () => {
		const out = normalizeEvent({ type: 'assistant', message: { content: [
			{ type: 'thinking', thinking: 'hmm' },
			{ type: 'text', text: 'Hello **world**' },
			{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }
		] } });
		expect(out.map((e) => e.kind)).toEqual(['thinking', 'assistant_text', 'tool_use']);
		expect(out[1]).toEqual({ kind: 'assistant_text', markdown: 'Hello **world**' });
		expect(out[2]).toMatchObject({ kind: 'tool_use', tool: 'Bash', detail: 'ls' });
	});
	it('maps a user tool_result (with is_error)', () => {
		const out = normalizeEvent({ type: 'user', message: { content: [{ type: 'tool_result', content: 'oops', is_error: true }] } });
		expect(out).toEqual([{ kind: 'tool_result', text: 'oops', isError: true }]);
	});
	it('joins array tool_result content into text', () => {
		const out = normalizeEvent({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] } });
		expect(out).toEqual([{ kind: 'tool_result', text: 'a\nb', isError: false }]);
	});
	it('maps a result event', () => {
		const out = normalizeEvent({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.02, duration_ms: 1500, result: 'done' });
		expect(out[0]).toEqual({ kind: 'result', isError: false, subtype: 'success', numTurns: 2, costUsd: 0.02, durationMs: 1500, text: 'done' });
	});
	it('maps system:init to session_start', () => {
		expect(normalizeEvent({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' })).toEqual([{ kind: 'session_start', model: 'claude-sonnet-4-6' }]);
	});
	it('maps subagent task events', () => {
		expect(normalizeEvent({ type: 'system', subtype: 'task_started', prompt: 'Explore the repo' })[0]).toMatchObject({ kind: 'subagent', phase: 'started' });
		expect(normalizeEvent({ type: 'system', subtype: 'task_progress', description: 'find …' })[0]).toMatchObject({ kind: 'subagent', phase: 'progress', label: 'find …' });
		expect(normalizeEvent({ type: 'system', subtype: 'task_notification', summary: 'Explore', status: 'completed' })[0]).toMatchObject({ kind: 'subagent', phase: 'done', status: 'completed' });
	});
	it('maps rate_limit_event', () => {
		expect(normalizeEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 123 } })).toEqual([{ kind: 'rate_limit', status: 'allowed', resetsAt: 123 }]);
	});
	it('hides runner_summary', () => {
		expect(normalizeEvent({ type: 'runner_summary', head: 'abc' })).toEqual([{ kind: 'hidden' }]);
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
