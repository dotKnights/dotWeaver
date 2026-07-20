import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import {
	createClientOrganizationSchema,
	deleteClientOrganizationSchema,
	inviteClientMemberSchema,
	removeClientMemberSchema,
	removeProjectAccessGrantSchema,
	upsertProjectAccessGrantSchema
} from '$lib/schemas/client-access';
import { requireActiveOrg } from '$lib/server/auth/org';
import { requireHeaders } from '$lib/server/auth/request';
import { requireActor } from '$lib/server/authz/actor';
import { requireInternalOrgAdmin, requireProjectPermission } from '$lib/server/authz/service';
import {
	ClientAccessError,
	acceptClientInvitation as acceptClientInvitationForUser,
	createClientOrganization,
	deleteClientOrganization,
	inviteClientMember,
	listClientOrganizations,
	listProjectAccessGrants,
	permissionsForPreset,
	removeClientMember,
	removeProjectAccessGrant,
	upsertProjectAccessGrant
} from '$lib/server/client-access/service';

async function requireActiveOrganizationId(): Promise<string> {
	const headers = requireHeaders();
	return await requireActiveOrg(headers);
}

/** Org-level client management is reserved for internal owners/admins of the active team. */
async function requireInternalAdminContext(): Promise<{ organizationId: string; userId: string }> {
	const organizationId = await requireActiveOrganizationId();
	const actor = await requireActor();
	requireInternalOrgAdmin(actor, organizationId);

	return { organizationId, userId: actor.userId };
}

function requireCurrentUser() {
	const { locals } = getRequestEvent();
	const user = locals.user;
	if (!user) error(401, 'Not authenticated');

	return user;
}

function mapClientAccessError(e: unknown): never {
	if (e instanceof ClientAccessError) error(400, e.message);
	throw e;
}

/**
 * Managing project access requires `project.manage_access` (internal owner/admin, enforced by the
 * authz service). The owning organization is derived from the project itself — never the session's
 * active org — so multi-org users can manage access regardless of which team is active.
 */
async function requireProjectAccessContext(
	projectId: string
): Promise<{ organizationId: string; userId: string }> {
	const actor = await requireActor();
	const project = await requireProjectPermission(actor, 'project.manage_access', projectId);

	return { organizationId: project.organizationId, userId: actor.userId };
}

export const listClients = query(async () => {
	const organizationId = await requireActiveOrganizationId();
	try {
		return await listClientOrganizations(organizationId);
	} catch (e) {
		mapClientAccessError(e);
	}
});

export const createClient = command(createClientOrganizationSchema, async ({ name }) => {
	const { organizationId, userId } = await requireInternalAdminContext();
	try {
		const result = await createClientOrganization({ organizationId, userId, name });
		await listClients().refresh();
		return result;
	} catch (e) {
		mapClientAccessError(e);
	}
});

export const inviteClient = command(inviteClientMemberSchema, async (input) => {
	const { organizationId, userId } = await requireInternalAdminContext();
	try {
		const result = await inviteClientMember({ organizationId, userId, ...input });
		await listClients().refresh();
		return result;
	} catch (e) {
		mapClientAccessError(e);
	}
});

export const removeClientContact = command(removeClientMemberSchema, async (input) => {
	const { organizationId } = await requireInternalAdminContext();
	try {
		const result = await removeClientMember({ organizationId, ...input });
		await listClients().refresh();
		return result;
	} catch (e) {
		mapClientAccessError(e);
	}
});

export const deleteClient = command(
	deleteClientOrganizationSchema,
	async ({ clientOrganizationId }) => {
		const { organizationId } = await requireInternalAdminContext();
		try {
			const result = await deleteClientOrganization({ organizationId, clientOrganizationId });
			await listClients().refresh();
			return result;
		} catch (e) {
			mapClientAccessError(e);
		}
	}
);

export const acceptClientInvitation = command(z.string().min(1), async (invitationId) => {
	const user = requireCurrentUser();
	try {
		return await acceptClientInvitationForUser({
			invitationId,
			userId: user.id,
			email: user.email
		});
	} catch (e) {
		mapClientAccessError(e);
	}
});

export const getProjectAccess = query(z.string().min(1), async (projectId) => {
	const { organizationId } = await requireProjectAccessContext(projectId);
	try {
		return await listProjectAccessGrants(organizationId, projectId);
	} catch (e) {
		mapClientAccessError(e);
	}
});

export const upsertProjectAccess = command(upsertProjectAccessGrantSchema, async (input) => {
	const { organizationId, userId } = await requireProjectAccessContext(input.projectId);
	try {
		const result = await upsertProjectAccessGrant({
			organizationId,
			userId,
			projectId: input.projectId,
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			permissions: permissionsForPreset(input.preset)
		});
		await getProjectAccess(input.projectId).refresh();
		return result;
	} catch (e) {
		mapClientAccessError(e);
	}
});

export const removeProjectAccess = command(removeProjectAccessGrantSchema, async (input) => {
	const { organizationId } = await requireProjectAccessContext(input.projectId);
	try {
		const result = await removeProjectAccessGrant({ organizationId, ...input });
		await getProjectAccess(input.projectId).refresh();
		return result;
	} catch (e) {
		mapClientAccessError(e);
	}
});
