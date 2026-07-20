import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRemoteCommand, mockRemoteQueryWithTrackedRefresh } from './remote-test-helpers';

const mocks = vi.hoisted(() => {
	class ClientAccessError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'ClientAccessError';
		}
	}

	return {
		getRequestEvent: vi.fn(),
		requireHeaders: vi.fn(),
		requireActiveOrg: vi.fn(),
		requireActor: vi.fn(),
		requirePermission: vi.fn(),
		projectResource: vi.fn((id: string) => ({ type: 'project', id })),
		refresh: vi.fn(),
		queryRefreshes: [] as unknown[],
		listClientOrganizations: vi.fn(),
		createClientOrganization: vi.fn(),
		inviteClientMember: vi.fn(),
		acceptClientInvitationForService: vi.fn(),
		listProjectAccessGrants: vi.fn(),
		upsertProjectAccessGrant: vi.fn(),
		removeProjectAccessGrant: vi.fn(),
		permissionsForPreset: vi.fn(),
		ClientAccessError
	};
});

vi.mock('$app/server', () => ({
	command: vi.fn((schemaOrHandler, maybeHandler) =>
		mockRemoteCommand(maybeHandler ?? schemaOrHandler)
	),
	query: vi.fn((schemaOrHandler, maybeHandler) =>
		mockRemoteQueryWithTrackedRefresh(
			maybeHandler ?? schemaOrHandler,
			mocks.queryRefreshes,
			mocks.refresh
		)
	),
	getRequestEvent: mocks.getRequestEvent
}));

vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));

vi.mock('$lib/server/auth/request', () => ({ requireHeaders: mocks.requireHeaders }));
vi.mock('$lib/server/auth/org', () => ({ requireActiveOrg: mocks.requireActiveOrg }));
vi.mock('$lib/server/authz/actor', () => ({ requireActor: mocks.requireActor }));
vi.mock('$lib/server/authz/service', () => ({ requirePermission: mocks.requirePermission }));
vi.mock('$lib/authz/resources', () => ({ projectResource: mocks.projectResource }));
vi.mock('$lib/server/client-access/service', () => ({
	ClientAccessError: mocks.ClientAccessError,
	listClientOrganizations: mocks.listClientOrganizations,
	createClientOrganization: mocks.createClientOrganization,
	inviteClientMember: mocks.inviteClientMember,
	acceptClientInvitation: mocks.acceptClientInvitationForService,
	listProjectAccessGrants: mocks.listProjectAccessGrants,
	upsertProjectAccessGrant: mocks.upsertProjectAccessGrant,
	removeProjectAccessGrant: mocks.removeProjectAccessGrant,
	permissionsForPreset: mocks.permissionsForPreset
}));

import {
	acceptClientInvitation,
	createClient,
	getProjectAccess,
	inviteClient,
	listClients,
	removeProjectAccess,
	upsertProjectAccess
} from '$lib/rfc/client-access.remote';

const listClientsMock = listClients as typeof listClients & {
	serverHandler: () => Promise<unknown>;
};
const getProjectAccessMock = getProjectAccess as typeof getProjectAccess & {
	serverHandler: (projectId: string) => Promise<unknown>;
};

describe('client-access.remote', () => {
	const headers = new Headers({ cookie: 'session=abc' });
	const actor = { userId: 'user1', internalMemberships: [], clientMemberships: [] };

	beforeEach(() => {
		vi.resetAllMocks();
		mocks.queryRefreshes.length = 0;
		mocks.requireHeaders.mockReturnValue(headers);
		mocks.requireActiveOrg.mockResolvedValue('org1');
		mocks.requireActor.mockResolvedValue(actor);
		mocks.requirePermission.mockResolvedValue(undefined);
		mocks.getRequestEvent.mockReturnValue({
			locals: {
				user: { id: 'user1', email: 'user@example.com' },
				session: { activeOrganizationId: 'org1' }
			}
		});
		mocks.refresh.mockResolvedValue(undefined);
		mocks.listClientOrganizations.mockResolvedValue([{ id: 'client_org1', name: 'Acme' }]);
		mocks.createClientOrganization.mockResolvedValue({ id: 'client_org1', slug: 'acme' });
		mocks.inviteClientMember.mockResolvedValue({ invitationId: 'invite1' });
		mocks.acceptClientInvitationForService.mockResolvedValue({
			clientOrganizationId: 'client_org1'
		});
		mocks.listProjectAccessGrants.mockResolvedValue([{ id: 'grant1' }]);
		mocks.upsertProjectAccessGrant.mockResolvedValue({ id: 'grant1' });
		mocks.removeProjectAccessGrant.mockResolvedValue({ removed: true });
		mocks.permissionsForPreset.mockReturnValue(['project.view', 'run.view']);
	});

	it('listClients returns active team clients', async () => {
		await expect(listClientsMock.serverHandler()).resolves.toEqual([
			{ id: 'client_org1', name: 'Acme' }
		]);

		expect(mocks.requireHeaders).toHaveBeenCalled();
		expect(mocks.requireActiveOrg).toHaveBeenCalledWith(headers);
		expect(mocks.listClientOrganizations).toHaveBeenCalledWith('org1');
	});

	it('createClient uses active org and current user then refreshes listClients', async () => {
		await expect(createClient({ name: 'Acme' })).resolves.toEqual({
			id: 'client_org1',
			slug: 'acme'
		});

		expect(mocks.createClientOrganization).toHaveBeenCalledWith({
			organizationId: 'org1',
			userId: 'user1',
			name: 'Acme'
		});
		expect(mocks.queryRefreshes).toEqual([undefined]);
	});

	it('inviteClient uses active org and current user then refreshes listClients', async () => {
		const input = {
			clientOrganizationId: 'client_org1',
			email: 'client@example.com',
			role: 'member' as const
		};

		await expect(inviteClient(input)).resolves.toEqual({ invitationId: 'invite1' });

		expect(mocks.inviteClientMember).toHaveBeenCalledWith({
			organizationId: 'org1',
			userId: 'user1',
			...input
		});
		expect(mocks.queryRefreshes).toEqual([undefined]);
	});

	it('inviteClient maps ClientAccessError to 400', async () => {
		mocks.inviteClientMember.mockRejectedValueOnce(
			new mocks.ClientAccessError('Client organization not found')
		);

		await expect(
			inviteClient({
				clientOrganizationId: 'client_org_other',
				email: 'client@example.com',
				role: 'member'
			})
		).rejects.toMatchObject({
			status: 400,
			message: 'Client organization not found'
		});
		expect(mocks.queryRefreshes).toEqual([]);
	});

	it('createClient rejects unauthenticated internal-context users with 401', async () => {
		mocks.getRequestEvent.mockReturnValue({ locals: {} });

		await expect(createClient({ name: 'Acme' })).rejects.toMatchObject({
			status: 401,
			message: 'Not authenticated'
		});

		expect(mocks.createClientOrganization).not.toHaveBeenCalled();
		expect(mocks.queryRefreshes).toEqual([]);
	});

	it('upsertProjectAccess requires project.manage_access before writing and maps preset permissions', async () => {
		const input = {
			projectId: 'project1',
			subjectType: 'client_member' as const,
			subjectId: 'client_member1',
			preset: 'follow_up' as const
		};

		await expect(upsertProjectAccess(input)).resolves.toEqual({ id: 'grant1' });

		expect(mocks.requireActor).toHaveBeenCalled();
		expect(mocks.projectResource).toHaveBeenCalledWith('project1');
		expect(mocks.requirePermission).toHaveBeenCalledWith(actor, 'project.manage_access', {
			type: 'project',
			id: 'project1'
		});
		expect(mocks.permissionsForPreset).toHaveBeenCalledWith('follow_up');
		expect(mocks.upsertProjectAccessGrant).toHaveBeenCalledWith({
			organizationId: 'org1',
			userId: 'user1',
			projectId: 'project1',
			subjectType: 'client_member',
			subjectId: 'client_member1',
			permissions: ['project.view', 'run.view']
		});
		expect(mocks.requirePermission.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.upsertProjectAccessGrant.mock.invocationCallOrder[0]
		);
		expect(mocks.queryRefreshes).toEqual(['project1']);
	});

	it('removeProjectAccess requires project.manage_access before deleting and refreshes project access', async () => {
		const input = {
			projectId: 'project1',
			subjectType: 'client_organization' as const,
			subjectId: 'client_org1'
		};

		await expect(removeProjectAccess(input)).resolves.toEqual({ removed: true });

		expect(mocks.requireActor).toHaveBeenCalled();
		expect(mocks.projectResource).toHaveBeenCalledWith('project1');
		expect(mocks.requirePermission).toHaveBeenCalledWith(actor, 'project.manage_access', {
			type: 'project',
			id: 'project1'
		});
		expect(mocks.removeProjectAccessGrant).toHaveBeenCalledWith({
			organizationId: 'org1',
			...input
		});
		expect(mocks.requirePermission.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.removeProjectAccessGrant.mock.invocationCallOrder[0]
		);
		expect(mocks.queryRefreshes).toEqual(['project1']);
	});

	it('maps ClientAccessError from a command to 400', async () => {
		mocks.createClientOrganization.mockRejectedValueOnce(
			new mocks.ClientAccessError('Client organization not found')
		);

		await expect(createClient({ name: 'Acme' })).rejects.toMatchObject({
			status: 400,
			message: 'Client organization not found'
		});
	});

	it('acceptClientInvitation uses current user email', async () => {
		await expect(acceptClientInvitation('invite1')).resolves.toEqual({
			clientOrganizationId: 'client_org1'
		});

		expect(mocks.acceptClientInvitationForService).toHaveBeenCalledWith({
			invitationId: 'invite1',
			userId: 'user1',
			email: 'user@example.com'
		});
	});

	it('acceptClientInvitation rejects unauthenticated users with 401', async () => {
		mocks.getRequestEvent.mockReturnValue({ locals: {} });

		await expect(acceptClientInvitation('invite1')).rejects.toMatchObject({
			status: 401,
			message: 'Not authenticated'
		});

		expect(mocks.acceptClientInvitationForService).not.toHaveBeenCalled();
	});

	it('getProjectAccess requires manage access before listing grants', async () => {
		await expect(getProjectAccessMock.serverHandler('project1')).resolves.toEqual([
			{ id: 'grant1' }
		]);

		expect(mocks.requirePermission).toHaveBeenCalledWith(actor, 'project.manage_access', {
			type: 'project',
			id: 'project1'
		});
		expect(mocks.listProjectAccessGrants).toHaveBeenCalledWith('org1', 'project1');
		expect(mocks.requirePermission.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.listProjectAccessGrants.mock.invocationCallOrder[0]
		);
	});
});
