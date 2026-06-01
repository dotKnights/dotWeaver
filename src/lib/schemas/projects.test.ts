import { describe, it, expect } from 'vitest';
import { importProjectSchema } from './projects';

describe('importProjectSchema', () => {
	it('accepts a valid owner/name pair', () => {
		expect(importProjectSchema.safeParse({ owner: 'octocat', name: 'my-repo' }).success).toBe(true);
	});

	it('rejects empty owner', () => {
		expect(importProjectSchema.safeParse({ owner: '', name: 'my-repo' }).success).toBe(false);
	});

	it('rejects missing name', () => {
		expect(importProjectSchema.safeParse({ owner: 'octocat' }).success).toBe(false);
	});
});
