import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	memberFindFirst: vi.fn(),
	userFindUnique: vi.fn()
}));

vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));
vi.mock('$lib/server/auth', () => ({
	auth: { api: { getSession: mocks.getSession } }
}));
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		member: { findFirst: mocks.memberFindFirst },
		user: { findUnique: mocks.userFindUnique }
	}
}));

import { requireActiveOrg, resolveActiveOrgId } from '$lib/server/org';

describe('resolveActiveOrgId', () => {
	it('returns the active org id when present', () => {
		expect(resolveActiveOrgId({ activeOrganizationId: 'org_1' })).toBe('org_1');
	});

	it('throws when no active org is selected', () => {
		expect(() => resolveActiveOrgId({ activeOrganizationId: null })).toThrow('No active team');
	});

	it('throws when session is null', () => {
		expect(() => resolveActiveOrgId(null)).toThrow('No active team');
	});
});

describe('requireActiveOrg', () => {
	const headers = new Headers({ cookie: 'session=abc' });

	beforeEach(() => {
		vi.resetAllMocks();
		mocks.memberFindFirst.mockResolvedValue({ id: 'member_1' });
	});

	it('falls back to the user preferred org when the session has no active org and membership exists', async () => {
		mocks.getSession.mockResolvedValue({
			session: { activeOrganizationId: null },
			user: { id: 'user_1' }
		});
		mocks.userFindUnique.mockResolvedValue({
			preferredOrganizationId: 'org_preferred',
			preferredOrganization: {
				id: 'org_preferred',
				members: [{ id: 'member_1' }]
			}
		});

		await expect(requireActiveOrg(headers)).resolves.toBe('org_preferred');

		expect(mocks.userFindUnique).toHaveBeenCalledWith({
			where: { id: 'user_1' },
			select: {
				preferredOrganizationId: true,
				preferredOrganization: {
					select: {
						id: true,
						members: {
							where: { userId: 'user_1' },
							select: { id: true },
							take: 1
						}
					}
				}
			}
		});
		expect(mocks.memberFindFirst).toHaveBeenCalledWith({
			where: { organizationId: 'org_preferred', userId: 'user_1' },
			select: { id: true }
		});
	});
});
