import { describe, expect, it } from 'vitest';
import { getMailThreadSchema } from '$lib/schemas/mail';

describe('getMailThreadSchema', () => {
	it('accepts a gmail thread id', () => {
		expect(getMailThreadSchema.safeParse({ gmailThreadId: '18fabc123' }).success).toBe(true);
	});

	it('rejects empty thread id', () => {
		expect(getMailThreadSchema.safeParse({ gmailThreadId: '' }).success).toBe(false);
	});
});
