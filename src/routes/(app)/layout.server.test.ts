import { describe, it, expect, vi } from 'vitest';

vi.mock('@sveltejs/kit', () => ({
	redirect: vi.fn((status: number, url: string) => {
		const error = new Error(`Redirect to ${url}`) as Error & {
			status?: number;
			location?: string;
		};
		error.status = status;
		error.location = url;
		throw error;
	})
}));

const { load } = await import('./+layout.server');

describe('(app) layout guard', () => {
	it('redirects to /login when no session', async () => {
		const event = {
			locals: { session: null, user: null },
			parent: async () => ({}),
			depends: vi.fn(),
			untrack: vi.fn()
		} as unknown;
		await expect(load(event as Parameters<typeof load>[0])).rejects.toThrow('Redirect to /login');
	});

	it('returns user when session exists', async () => {
		const user = { id: '1', name: 'Jane', email: 'jane@example.com' };
		const event = {
			locals: { session: { id: 'sess1' }, user },
			parent: async () => ({}),
			depends: vi.fn(),
			untrack: vi.fn()
		} as unknown;
		const result = await load(event as Parameters<typeof load>[0]);
		expect(result).toEqual({ user });
	});
});
