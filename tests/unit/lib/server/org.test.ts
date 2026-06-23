import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	getSession: vi.fn(),
	setActiveOrganization: vi.fn(),
	memberFindFirst: vi.fn(),
	userFindUnique: vi.fn(),
	userUpdate: vi.fn()
}));

vi.mock('$app/server', () => ({ getRequestEvent: mocks.getRequestEvent }));
vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));
vi.mock('$lib/server/auth', () => ({
	auth: {
		api: { getSession: mocks.getSession, setActiveOrganization: mocks.setActiveOrganization }
	}
}));
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		member: { findFirst: mocks.memberFindFirst },
		user: { findUnique: mocks.userFindUnique, update: mocks.userUpdate }
	}
}));

import { requireActiveOrg, resolveActiveOrgId, resolveEffectiveActiveOrg } from '$lib/server/org';

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
		mocks.getRequestEvent.mockReturnValue({
			locals: {
				session: { id: 'session_1', activeOrganizationId: null },
				user: { id: 'user_1' }
			}
		});
		mocks.getSession.mockResolvedValue({
			session: { activeOrganizationId: null },
			user: { id: 'auth_user_1' }
		});
		mocks.memberFindFirst.mockResolvedValue(null);
		mocks.userFindUnique.mockResolvedValue({
			preferredOrganizationId: null,
			preferredOrganization: null
		});
		mocks.userUpdate.mockResolvedValue({ id: 'user_1' });
		mocks.setActiveOrganization.mockResolvedValue(undefined);
	});

	it('persists and returns the active org when the signed-in user is still a member', async () => {
		mocks.getSession.mockResolvedValue({
			session: { activeOrganizationId: 'org_active' },
			user: { id: 'auth_user_1' }
		});
		mocks.memberFindFirst.mockImplementation(async ({ where, orderBy }) => {
			if (!orderBy && where.organizationId === 'org_active' && where.userId === 'user_1') {
				return { id: 'member_active' };
			}
			return null;
		});

		await expect(resolveEffectiveActiveOrg(headers)).resolves.toBe('org_active');

		expect(mocks.userUpdate).toHaveBeenCalledWith({
			where: { id: 'user_1' },
			data: { preferredOrganizationId: 'org_active' },
			select: { id: true }
		});
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
		expect(mocks.setActiveOrganization).not.toHaveBeenCalled();
	});

	it('falls back to the preferred org when the active org is stale', async () => {
		mocks.getSession.mockResolvedValue({
			session: { activeOrganizationId: 'org_stale' },
			user: { id: 'auth_user_1' }
		});
		mocks.memberFindFirst.mockImplementation(async ({ where, orderBy }) => {
			if (!orderBy && where.organizationId === 'org_preferred' && where.userId === 'user_1') {
				return { id: 'member_preferred' };
			}
			return null;
		});
		mocks.userFindUnique.mockResolvedValue({
			preferredOrganizationId: 'org_preferred',
			preferredOrganization: { id: 'org_preferred' }
		});

		await expect(resolveEffectiveActiveOrg(headers)).resolves.toBe('org_preferred');

		expect(mocks.memberFindFirst).toHaveBeenCalledWith({
			where: { organizationId: 'org_stale', userId: 'user_1' },
			select: { id: true }
		});
		expect(mocks.setActiveOrganization).toHaveBeenCalledWith({
			body: { organizationId: 'org_preferred' },
			headers
		});
	});

	it('clears an invalid preferred org and falls back to the first membership', async () => {
		mocks.userFindUnique.mockResolvedValue({
			preferredOrganizationId: 'org_removed',
			preferredOrganization: { id: 'org_removed' }
		});
		mocks.memberFindFirst.mockImplementation(async ({ where, orderBy }) => {
			if (orderBy?.createdAt === 'asc' && where.userId === 'user_1') {
				return { organizationId: 'org_first' };
			}
			return null;
		});

		await expect(resolveEffectiveActiveOrg(headers)).resolves.toBe('org_first');

		expect(mocks.userUpdate).toHaveBeenNthCalledWith(1, {
			where: { id: 'user_1' },
			data: { preferredOrganizationId: null },
			select: { id: true }
		});
		expect(mocks.userUpdate).toHaveBeenNthCalledWith(2, {
			where: { id: 'user_1' },
			data: { preferredOrganizationId: 'org_first' },
			select: { id: true }
		});
		expect(mocks.setActiveOrganization).toHaveBeenCalledWith({
			body: { organizationId: 'org_first' },
			headers
		});
	});

	it('returns null when the user has no team', async () => {
		await expect(resolveEffectiveActiveOrg(headers)).resolves.toBeNull();

		expect(mocks.userUpdate).not.toHaveBeenCalled();
		expect(mocks.setActiveOrganization).not.toHaveBeenCalled();
	});

	it('maps no effective active org to a 400 response', async () => {
		await expect(requireActiveOrg(headers)).rejects.toMatchObject({
			status: 400,
			message: 'No active team selected'
		});
	});

	it('falls back to the locals active org when the Better Auth session has none', async () => {
		mocks.getRequestEvent.mockReturnValue({
			locals: {
				session: { id: 'session_1', activeOrganizationId: 'org_local' },
				user: { id: 'user_1' }
			}
		});
		mocks.memberFindFirst.mockImplementation(async ({ where, orderBy }) => {
			if (!orderBy && where.organizationId === 'org_local' && where.userId === 'user_1') {
				return { id: 'member_local' };
			}
			return null;
		});

		await expect(resolveEffectiveActiveOrg(headers)).resolves.toBe('org_local');

		expect(mocks.userUpdate).toHaveBeenCalledWith({
			where: { id: 'user_1' },
			data: { preferredOrganizationId: 'org_local' },
			select: { id: true }
		});
	});
});
