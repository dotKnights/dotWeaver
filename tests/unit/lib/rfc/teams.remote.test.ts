import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	requireHeaders: vi.fn(),
	queryRefresh: vi.fn(),
	listOrganizations: vi.fn(),
	getSession: vi.fn(),
	createOrganization: vi.fn(),
	setActiveOrganization: vi.fn(),
	resolveEffectiveActiveOrg: vi.fn(),
	resolveSlug: vi.fn(),
	organizationFindUnique: vi.fn(),
	memberFindFirst: vi.fn(),
	userUpdate: vi.fn()
}));

function remoteHandle<T extends (...args: never[]) => unknown>(
	handler: T
): T & { refresh: () => Promise<void> } {
	const wrapped = vi.fn(handler) as unknown as T & {
		__: { type: 'command' };
		refresh: () => Promise<void>;
	};
	wrapped.__ = { type: 'command' };
	wrapped.refresh = vi.fn(async () => undefined);
	return wrapped;
}

vi.mock('$app/server', () => ({
	command: vi.fn((schemaOrHandler, maybeHandler) => remoteHandle(maybeHandler ?? schemaOrHandler)),
	query: vi.fn((schemaOrHandler, maybeHandler) => {
		const handler = maybeHandler ?? schemaOrHandler;
		const wrapped = vi.fn(() => ({
			current: undefined,
			error: undefined,
			refresh: mocks.queryRefresh
		})) as unknown as { __: { type: 'query' }; serverHandler: unknown };
		wrapped.__ = { type: 'query' };
		wrapped.serverHandler = handler;
		return wrapped;
	}),
	getRequestEvent: mocks.getRequestEvent
}));

vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));

vi.mock('$lib/server/utils', () => ({ requireHeaders: mocks.requireHeaders }));
vi.mock('$lib/server/auth', () => ({
	auth: {
		api: {
			listOrganizations: mocks.listOrganizations,
			getSession: mocks.getSession,
			createOrganization: mocks.createOrganization,
			setActiveOrganization: mocks.setActiveOrganization
		}
	}
}));
vi.mock('$lib/server/auth/org', () => ({
	resolveEffectiveActiveOrg: mocks.resolveEffectiveActiveOrg
}));
vi.mock('$lib/server/slug', () => ({ resolveSlug: mocks.resolveSlug }));
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		organization: { findUnique: mocks.organizationFindUnique },
		member: { findFirst: mocks.memberFindFirst },
		user: { update: mocks.userUpdate }
	}
}));

import { createTeam, listMyTeams, setActiveTeam } from '$lib/rfc/teams.remote';

const listMyTeamsHandler = listMyTeams as unknown as {
	serverHandler: () => Promise<{ teams: unknown[]; activeOrganizationId: string | null }>;
};

describe('teams.remote', () => {
	const headers = new Headers({ cookie: 'session=abc' });

	beforeEach(() => {
		vi.resetAllMocks();
		mocks.requireHeaders.mockReturnValue(headers);
		mocks.queryRefresh.mockResolvedValue(undefined);
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'user1' } } });
		mocks.resolveSlug.mockResolvedValue('new-team');
		mocks.listOrganizations.mockResolvedValue([{ id: 'org_effective', name: 'Effective Team' }]);
		mocks.getSession.mockResolvedValue({
			session: { activeOrganizationId: 'org_session' },
			user: { id: 'user1' }
		});
		mocks.resolveEffectiveActiveOrg.mockResolvedValue('org_effective');
		mocks.createOrganization.mockResolvedValue({ id: 'org_new', slug: 'new-team' });
		mocks.setActiveOrganization.mockResolvedValue(undefined);
		mocks.memberFindFirst.mockResolvedValue({ id: 'member1' });
		mocks.userUpdate.mockResolvedValue({ id: 'user1' });
	});

	it('returns the effective active organization alongside Better Auth teams', async () => {
		await expect(listMyTeamsHandler.serverHandler()).resolves.toEqual({
			teams: [{ id: 'org_effective', name: 'Effective Team' }],
			activeOrganizationId: 'org_effective'
		});

		expect(mocks.listOrganizations).toHaveBeenCalledWith({ headers });
		expect(mocks.resolveEffectiveActiveOrg).toHaveBeenCalledWith(headers);
	});

	it('does not expose stale session active organization when no effective org exists', async () => {
		mocks.resolveEffectiveActiveOrg.mockResolvedValue(null);
		mocks.getSession.mockResolvedValue({
			session: { activeOrganizationId: 'org_stale' },
			user: { id: 'user1' }
		});

		await expect(listMyTeamsHandler.serverHandler()).resolves.toEqual({
			teams: [{ id: 'org_effective', name: 'Effective Team' }],
			activeOrganizationId: null
		});

		expect(mocks.getSession).not.toHaveBeenCalled();
	});

	it('persists a newly created team as the active and preferred organization', async () => {
		await expect(createTeam({ name: 'New Team' })).resolves.toEqual({ slug: 'new-team' });

		expect(mocks.setActiveOrganization).toHaveBeenCalledWith({
			body: { organizationId: 'org_new' },
			headers
		});
		expect(mocks.userUpdate).toHaveBeenCalledWith({
			where: { id: 'user1' },
			data: { preferredOrganizationId: 'org_new' },
			select: { id: true }
		});
		expect(mocks.queryRefresh).toHaveBeenCalledTimes(1);
	});

	it('rejects active team switches for non-members', async () => {
		mocks.memberFindFirst.mockResolvedValue(null);

		await expect(setActiveTeam('org_other')).rejects.toMatchObject({
			status: 403,
			message: 'Not a member of the selected team'
		});

		expect(mocks.memberFindFirst).toHaveBeenCalledWith({
			where: { organizationId: 'org_other', userId: 'user1' },
			select: { id: true }
		});
		expect(mocks.setActiveOrganization).not.toHaveBeenCalled();
		expect(mocks.userUpdate).not.toHaveBeenCalled();
	});

	it('persists selected teams for members', async () => {
		await expect(setActiveTeam('org_member')).resolves.toBeUndefined();

		expect(mocks.setActiveOrganization).toHaveBeenCalledWith({
			body: { organizationId: 'org_member' },
			headers
		});
		expect(mocks.userUpdate).toHaveBeenCalledWith({
			where: { id: 'user1' },
			data: { preferredOrganizationId: 'org_member' },
			select: { id: true }
		});
		expect(mocks.queryRefresh).toHaveBeenCalledTimes(1);
	});

	it('rejects active team switches when no signed-in user is available', async () => {
		mocks.getRequestEvent.mockReturnValue({ locals: { user: null } });

		await expect(setActiveTeam('org_member')).rejects.toMatchObject({
			status: 401,
			message: 'Not authenticated'
		});

		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
		expect(mocks.setActiveOrganization).not.toHaveBeenCalled();
		expect(mocks.userUpdate).not.toHaveBeenCalled();
	});
});
