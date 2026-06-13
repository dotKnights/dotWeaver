import { describe, expect, it } from 'vitest';
import { getMailThreadSchema } from '$lib/schemas/mail';

describe('getMailThreadSchema', () => {
	it('accepts a gmail thread id', () => {
		expect(getMailThreadSchema.safeParse({ gmailThreadId: '18fabc123' }).success).toBe(true);
	});

	it('rejects empty thread id', () => {
		expect(getMailThreadSchema.safeParse({ gmailThreadId: '' }).success).toBe(false);
	});

	it('rejects whitespace-only thread id', () => {
		expect(getMailThreadSchema.safeParse({ gmailThreadId: '   ' }).success).toBe(false);
	});

	it('trims a gmail thread id', () => {
		expect(getMailThreadSchema.parse({ gmailThreadId: ' 18fabc123 ' })).toEqual({
			gmailThreadId: '18fabc123'
		});
	});

	it('rejects malformed thread id characters', () => {
		expect(getMailThreadSchema.safeParse({ gmailThreadId: '18fabc123/evil?x=1' }).success).toBe(
			false
		);
	});
});
