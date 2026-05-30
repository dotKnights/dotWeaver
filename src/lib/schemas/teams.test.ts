import { describe, it, expect } from 'vitest';
import { createTeamSchema, inviteSchema } from './teams';

describe('createTeamSchema', () => {
	it('accepts a valid name', () => {
		expect(createTeamSchema.safeParse({ name: 'Acme' }).success).toBe(true);
	});

	it('rejects a name shorter than 2 chars', () => {
		expect(createTeamSchema.safeParse({ name: 'A' }).success).toBe(false);
	});
});

describe('inviteSchema', () => {
	it('accepts a valid email and role', () => {
		expect(inviteSchema.safeParse({ email: 'a@b.com', role: 'member' }).success).toBe(true);
	});

	it('rejects an invalid email', () => {
		expect(inviteSchema.safeParse({ email: 'nope', role: 'member' }).success).toBe(false);
	});

	it('rejects an unknown role', () => {
		expect(inviteSchema.safeParse({ email: 'a@b.com', role: 'owner' }).success).toBe(false);
	});
});
