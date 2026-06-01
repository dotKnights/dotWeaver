import { describe, it, expect } from 'vitest';
import { parseNumstat, parseNameStatus, mergeDiffFiles } from './diff';

describe('parseNumstat', () => {
	it('parses additions/deletions and path; null for binary', () => {
		expect(parseNumstat('3\t1\tsrc/a.ts\n-\t-\timg.png\n')).toEqual([
			{ path: 'src/a.ts', additions: 3, deletions: 1 },
			{ path: 'img.png', additions: null, deletions: null }
		]);
	});
	it('returns [] for empty output', () => {
		expect(parseNumstat('')).toEqual([]);
	});
});

describe('parseNameStatus', () => {
	it('maps the status letter and path', () => {
		expect(parseNameStatus('A\tnew.ts\nM\tsrc/a.ts\nD\told.ts\n')).toEqual([
			{ path: 'new.ts', status: 'A' },
			{ path: 'src/a.ts', status: 'M' },
			{ path: 'old.ts', status: 'D' }
		]);
	});
});

describe('mergeDiffFiles', () => {
	it('joins status with counts by path', () => {
		const merged = mergeDiffFiles(
			[{ path: 'src/a.ts', additions: 3, deletions: 1 }],
			[{ path: 'src/a.ts', status: 'M' }]
		);
		expect(merged).toEqual([{ path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 }]);
	});
});
