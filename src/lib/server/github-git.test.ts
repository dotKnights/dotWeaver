import { describe, it, expect } from 'vitest';
import { authedCloneUrl } from './github-git';

describe('authedCloneUrl', () => {
	it('injects the x-access-token username into an https clone url', () => {
		expect(authedCloneUrl('https://github.com/o/r.git')).toBe(
			'https://x-access-token@github.com/o/r.git'
		);
	});
	it('leaves non-https urls unchanged', () => {
		expect(authedCloneUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
	});
});
