import { describe, it, expect } from 'vitest';
import { loginSchema, registerSchema } from '$lib/schemas/auth';

describe('loginSchema', () => {
	it('accepts valid email and password', () => {
		const result = loginSchema.safeParse({ email: 'user@example.com', password: 'password123' });
		expect(result.success).toBe(true);
	});

	it('rejects invalid email', () => {
		const result = loginSchema.safeParse({ email: 'not-an-email', password: 'password123' });
		expect(result.success).toBe(false);
		expect(result.error?.issues[0].path).toContain('email');
	});

	it('rejects password shorter than 8 characters', () => {
		const result = loginSchema.safeParse({ email: 'user@example.com', password: 'short' });
		expect(result.success).toBe(false);
		expect(result.error?.issues[0].path).toContain('password');
	});
});

describe('registerSchema', () => {
	const valid = {
		name: 'Jane Doe',
		email: 'jane@example.com',
		password: 'password123',
		confirmPassword: 'password123'
	};

	it('accepts valid registration data', () => {
		expect(registerSchema.safeParse(valid).success).toBe(true);
	});

	it('rejects name shorter than 2 characters', () => {
		const result = registerSchema.safeParse({ ...valid, name: 'J' });
		expect(result.success).toBe(false);
		expect(result.error?.issues[0].path).toContain('name');
	});

	it('rejects mismatched passwords', () => {
		const result = registerSchema.safeParse({ ...valid, confirmPassword: 'different123' });
		expect(result.success).toBe(false);
		expect(result.error?.issues[0].path).toContain('confirmPassword');
	});

	it('rejects short password', () => {
		const result = registerSchema.safeParse({
			...valid,
			password: 'short',
			confirmPassword: 'short'
		});
		expect(result.success).toBe(false);
	});
});
