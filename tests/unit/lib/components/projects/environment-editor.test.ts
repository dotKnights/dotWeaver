import { describe, expect, it } from 'vitest';
import {
	commandValue,
	defaultCommands,
	environmentEditorKey,
	normalizePackageManager,
	normalizeRuntime
} from '$lib/components/projects/environment-editor';

describe('environment editor helpers', () => {
	it('normalizes runtime and package managers', () => {
		expect(normalizeRuntime('python')).toBe('python');
		expect(normalizeRuntime('ruby')).toBe('node');
		expect(normalizePackageManager('poetry', 'python')).toBe('poetry');
		expect(normalizePackageManager('bun', 'python')).toBe('uv');
		expect(normalizePackageManager('npm', 'node')).toBe('npm');
	});

	it('provides command defaults per runtime and package manager', () => {
		expect(defaultCommands('node', 'bun')).toEqual({
			installCommand: 'bun install',
			testCommand: 'bun run test',
			buildCommand: 'bun run build',
			devCommand: 'bun run dev'
		});
		expect(defaultCommands('python', 'poetry')).toEqual({
			installCommand: 'poetry install',
			testCommand: 'poetry run pytest',
			buildCommand: '',
			devCommand: ''
		});
		expect(defaultCommands('custom', 'custom')).toEqual({
			installCommand: '',
			testCommand: '',
			buildCommand: '',
			devCommand: ''
		});
	});

	it('chooses command override, saved value, or fallback by profile mode', () => {
		expect(commandValue('override', 'saved', 'fallback', true)).toBe('override');
		expect(commandValue(null, 'saved', 'fallback', true)).toBe('saved');
		expect(commandValue(null, null, 'fallback', true)).toBe('');
		expect(commandValue(null, null, 'fallback', false)).toBe('fallback');
	});

	it('builds a stable editor key from project and environment fields', () => {
		expect(
			environmentEditorKey('p1', {
				id: 'env1',
				runtime: 'node',
				packageManager: 'bun',
				installCommand: 'bun install',
				testCommand: 'bun test',
				devCommand: undefined
			})
		).toBe('p1:env1:node:bun:bun install:bun test::');
	});
});
