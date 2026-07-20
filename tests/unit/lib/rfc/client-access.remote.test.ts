import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockAppServerWithTrackedRefresh } from './remote-test-helpers';

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
		requireInternalOrgAdmin: vi.fn(),
		requireProjectPermission: vi.fn(),
		refresh: vi.fn(),
		queryRefreshes: [] as unknown[],
		listClientOrganizations: vi.fn(),
		createClientOrganization: vi.fn(),
		inviteClientMember: vi.fn(),
		removeClientMember: vi.fn(),
		deleteClientOrganization: vi.fn(),
		acceptClientInvitationForService: vi.fn(),
		listProjectAccessGrants: vi.fn(),
		upsertProjectAccessGrant: vi.fn(),
		removeProjectAccessGrant: vi.fn(),
		permissionsForPreset: vi.fn(),
		ClientAccessError
	};
});

vi.mock('$app/server', () =>
	mockAppServerWithTrackedRefresh({
		getRequestEvent: mocks.getRequestEvent,
		queryRefreshes: mocks.queryRefreshes,
		refresh: mocks.refresh
	})
);

vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));

vi.mock('$lib/server/auth/request', () => ({ requireHeaders: mocks.requireHeaders }));
vi.mock('$lib/server/auth/org', () => ({ requireActiveOrg: mocks.requireActiveOrg }));
vi.mock('$lib/server/authz/actor', () => ({ requireActor: mocks.requireActor }));
vi.mock('$lib/server/authz/service', () => ({
	requireInternalOrgAdmin: mocks.requireInternalOrgAdmin,
	requireProjectPermission: mocks.requireProjectPermission
}));
vi.mock('$lib/server/client-access/service', () => ({
	ClientAccessError: mocks.ClientAccessError,
	listClientOrganizations: mocks.listClientOrganizations,
	createClientOrganization: mocks.createClientOrganization,
	inviteClientMember: mocks.inviteClientMember,
	removeClientMember: mocks.removeClientMember,
	deleteClientOrganization: mocks.deleteClientOrganization,
	acceptClientInvitation: mocks.acceptClientInvitationForService,
	listProjectAccessGrants: mocks.listProjectAccessGrants,
	upsertProjectAccessGrant: mocks.upsertProjectAccessGrant,
	removeProjectAccessGrant: mocks.removeProjectAccessGrant,
	permissionsForPreset: mocks.permissionsForPreset
}));

import {
	acceptClientInvitation,
	createClient,
	deleteClient,
	getProjectAccess,
	inviteClient,
	listClients,
	removeClientContact,
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
		mocks.requireInternalOrgAdmin.mockReturnValue(undefined);
		mocks.requireProjectPermission.mockResolvedValue({ id: 'project1', organizationId: 'org1' });
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
		mocks.removeClientMember.mockResolvedValue({ removed: true });
		mocks.deleteClientOrganization.mockResolvedValue({ removed: true });
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

	it('createClient requires internal admin then creates and refreshes listClients', async () => {
		await expect(createClient({ name: 'Acme' })).resolves.toEqual({
			id: 'client_org1',
			slug: 'acme'
		});

		expect(mocks.requireInternalOrgAdmin).toHaveBeenCalledWith(actor, 'org1');
		expect(mocks.createClientOrganization).toHaveBeenCalledWith({
			organizationId: 'org1',
			userId: 'user1',
			name: 'Acme'
		});
		expect(mocks.queryRefreshes).toEqual([undefined]);
	});

	it('createClient rejects non-admin internal members with 403', async () => {
		mocks.requireInternalOrgAdmin.mockImplementationOnce(() => {
			throw Object.assign(new Error('Forbidden'), { status: 403 });
		});

		await expect(createClient({ name: 'Acme' })).rejects.toMatchObject({
			status: 403,
			message: 'Forbidden'
		});

		expect(mocks.createClientOrganization).not.toHaveBeenCalled();
		expect(mocks.queryRefreshes).toEqual([]);
	});

	it('inviteClient requires internal admin then invites and refreshes listClients', async () => {
		const input = {
			clientOrganizationId: 'client_org1',
			email: 'client@example.com',
			role: 'member' as const
		};

		await expect(inviteClient(input)).resolves.toEqual({ invitationId: 'invite1' });

		expect(mocks.requireInternalOrgAdmin).toHaveBeenCalledWith(actor, 'org1');
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

	it('removeClientContact requires internal admin then removes and refreshes listClients', async () => {
		const input = { clientOrganizationId: 'client_org1', clientMemberId: 'client_member1' };

		await expect(removeClientContact(input)).resolves.toEqual({ removed: true });

		expect(mocks.requireInternalOrgAdmin).toHaveBeenCalledWith(actor, 'org1');
		expect(mocks.removeClientMember).toHaveBeenCalledWith({ organizationId: 'org1', ...input });
		expect(mocks.queryRefreshes).toEqual([undefined]);
	});

	it('deleteClient requires internal admin then deletes and refreshes listClients', async () => {
		await expect(deleteClient({ clientOrganizationId: 'client_org1' })).resolves.toEqual({
			removed: true
		});

		expect(mocks.requireInternalOrgAdmin).toHaveBeenCalledWith(actor, 'org1');
		expect(mocks.deleteClientOrganization).toHaveBeenCalledWith({
			organizationId: 'org1',
			clientOrganizationId: 'client_org1'
		});
		expect(mocks.queryRefreshes).toEqual([undefined]);
	});

	it('upsertProjectAccess resolves the org from the project and maps preset permissions', async () => {
		const input = {
			projectId: 'project1',
			subjectType: 'client_member' as const,
			subjectId: 'client_member1',
			preset: 'follow_up' as const
		};

		await expect(upsertProjectAccess(input)).resolves.toEqual({ id: 'grant1' });

		expect(mocks.requireActor).toHaveBeenCalled();
		expect(mocks.requireProjectPermission).toHaveBeenCalledWith(
			actor,
			'project.manage_access',
			'project1'
		);
		expect(mocks.permissionsForPreset).toHaveBeenCalledWith('follow_up');
		expect(mocks.upsertProjectAccessGrant).toHaveBeenCalledWith({
			organizationId: 'org1',
			userId: 'user1',
			projectId: 'project1',
			subjectType: 'client_member',
			subjectId: 'client_member1',
			permissions: ['project.view', 'run.view']
		});
		expect(mocks.requireProjectPermission.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.upsertProjectAccessGrant.mock.invocationCallOrder[0]
		);
		expect(mocks.queryRefreshes).toEqual(['project1']);
	});

	it('upsertProjectAccess rejects when manage access is missing and does not write', async () => {
		mocks.requireProjectPermission.mockRejectedValueOnce(
			Object.assign(new Error('Forbidden'), { status: 403 })
		);

		await expect(
			upsertProjectAccess({
				projectId: 'project1',
				subjectType: 'client_member',
				subjectId: 'client_member1',
				preset: 'follow_up'
			})
		).rejects.toMatchObject({ status: 403 });

		expect(mocks.upsertProjectAccessGrant).not.toHaveBeenCalled();
		expect(mocks.queryRefreshes).toEqual([]);
	});

	it('removeProjectAccess resolves the org from the project then deletes and refreshes', async () => {
		const input = {
			projectId: 'project1',
			subjectType: 'client_organization' as const,
			subjectId: 'client_org1'
		};

		await expect(removeProjectAccess(input)).resolves.toEqual({ removed: true });

		expect(mocks.requireProjectPermission).toHaveBeenCalledWith(
			actor,
			'project.manage_access',
			'project1'
		);
		expect(mocks.removeProjectAccessGrant).toHaveBeenCalledWith({
			organizationId: 'org1',
			...input
		});
		expect(mocks.requireProjectPermission.mock.invocationCallOrder[0]).toBeLessThan(
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

	it('getProjectAccess resolves the org from the project before listing grants', async () => {
		await expect(getProjectAccessMock.serverHandler('project1')).resolves.toEqual([
			{ id: 'grant1' }
		]);

		expect(mocks.requireProjectPermission).toHaveBeenCalledWith(
			actor,
			'project.manage_access',
			'project1'
		);
		expect(mocks.listProjectAccessGrants).toHaveBeenCalledWith('org1', 'project1');
		expect(mocks.requireProjectPermission.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.listProjectAccessGrants.mock.invocationCallOrder[0]
		);
	});
});
