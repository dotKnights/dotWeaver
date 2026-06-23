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

const { load } = await import('../../../src/routes/+page.server');

describe('root page redirect', () => {
	it('redirects authenticated users to the dashboard', () => {
		const event = {
			locals: { session: { id: 'sess1' }, user: { id: 'u1' } },
			parent: async () => ({}),
			depends: vi.fn(),
			untrack: vi.fn()
		} as unknown;

		expect(() => load(event as Parameters<typeof load>[0])).toThrow('Redirect to /dashboard');
	});

	it('renders the public landing page without a session', () => {
		const event = {
			locals: { session: null, user: null },
			parent: async () => ({}),
			depends: vi.fn(),
			untrack: vi.fn()
		} as unknown;

		expect(load(event as Parameters<typeof load>[0])).toEqual({});
	});
});
