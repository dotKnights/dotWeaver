import { describe, it, expect } from 'vitest';
import { describeToolUse } from './run-event-display';

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
