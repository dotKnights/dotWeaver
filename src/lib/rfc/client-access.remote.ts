import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { projectResource } from '$lib/authz/resources';
import {
	createClientOrganizationSchema,
	inviteClientMemberSchema,
	removeProjectAccessGrantSchema,
	upsertProjectAccessGrantSchema
} from '$lib/schemas/client-access';
import { requireActiveOrg } from '$lib/server/auth/org';
import { requireHeaders } from '$lib/server/auth/request';
import { requireActor } from '$lib/server/authz/actor';
import { requirePermission } from '$lib/server/authz/service';
import {
	ClientAccessError,
	acceptClientInvitation as acceptClientInvitationForUser,
	createClientOrganization,
	inviteClientMember,
	listClientOrganizations,
	listProjectAccessGrants,
	permissionsForPreset,
	removeProjectAccessGrant,
	upsertProjectAccessGrant
} from '$lib/server/client-access/service';

async function requireActiveOrganizationId(): Promise<string> {
	const headers = requireHeaders();
	return await requireActiveOrg(headers);
}

async function requireInternalContext(): Promise<{ organizationId: string; userId: string }> {
	const organizationId = await requireActiveOrganizationId();
	const { locals } = getRequestEvent();
	const userId = locals.user?.id;
	if (!userId) error(401, 'Not authenticated');

	return { organizationId, userId };
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

async function requireProjectAccessManager(projectId: string): Promise<void> {
	const actor = await requireActor();
	await requirePermission(actor, 'project.manage_access', projectResource(projectId));
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
	const { organizationId, userId } = await requireInternalContext();
	try {
		const result = await createClientOrganization({ organizationId, userId, name });
		await listClients().refresh();
		return result;
	} catch (e) {
		mapClientAccessError(e);
	}
});

export const inviteClient = command(inviteClientMemberSchema, async (input) => {
	const { organizationId, userId } = await requireInternalContext();
	try {
		const result = await inviteClientMember({ organizationId, userId, ...input });
		await listClients().refresh();
		return result;
	} catch (e) {
		mapClientAccessError(e);
	}
});

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
	await requireProjectAccessManager(projectId);
	const organizationId = await requireActiveOrganizationId();
	try {
		return await listProjectAccessGrants(organizationId, projectId);
	} catch (e) {
		mapClientAccessError(e);
	}
});

export const upsertProjectAccess = command(upsertProjectAccessGrantSchema, async (input) => {
	await requireProjectAccessManager(input.projectId);
	const { organizationId, userId } = await requireInternalContext();
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
	await requireProjectAccessManager(input.projectId);
	const { organizationId } = await requireInternalContext();
	try {
		const result = await removeProjectAccessGrant({ organizationId, ...input });
		await getProjectAccess(input.projectId).refresh();
		return result;
	} catch (e) {
		mapClientAccessError(e);
	}
});
