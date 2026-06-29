import { query, command, getRequestEvent } from '$app/server';
import { z } from 'zod';
import { error } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { createTeamSchema, inviteSchema } from '$lib/schemas/teams';
import { resolveSlug } from '$lib/server/teams/slug';
import { prisma } from '$lib/server/prisma';
import { requireHeaders } from '$lib/server/auth/request';
import { resolveEffectiveActiveOrg } from '$lib/server/auth/org';

async function persistPreferredOrganization(userId: string, organizationId: string) {
	await prisma.user.update({
		where: { id: userId },
		data: { preferredOrganizationId: organizationId },
		select: { id: true }
	});
}

async function setAuthActiveOrganization(headers: Headers, organizationId: string) {
	await auth.api.setActiveOrganization({ body: { organizationId }, headers });
}

async function persistActiveOrganization(headers: Headers, userId: string, organizationId: string) {
	await setAuthActiveOrganization(headers, organizationId);
	await persistPreferredOrganization(userId, organizationId);
}

export const listMyTeams = query(async () => {
	const headers = requireHeaders();
	const [teams, effectiveActiveOrganizationId] = await Promise.all([
		auth.api.listOrganizations({ headers }),
		resolveEffectiveActiveOrg(headers)
	]);
	return {
		teams,
		activeOrganizationId: effectiveActiveOrganizationId
	};
});

export const getTeam = query(z.string(), async (slug) => {
	const headers = requireHeaders();
	const org = await auth.api.getFullOrganization({
		query: { organizationSlug: slug },
		headers
	});
	if (!org) error(404, 'Team not found');
	const invitations = await auth.api.listInvitations({
		query: { organizationId: org.id },
		headers
	});
	return {
		org,
		pendingInvitations: invitations.filter((i) => i.status === 'pending')
	};
});

export const createTeam = command(createTeamSchema, async ({ name }) => {
	const headers = requireHeaders();
	const slug = await resolveSlug(
		name,
		async (s) => (await prisma.organization.findUnique({ where: { slug: s } })) !== null
	);
	const org = await auth.api.createOrganization({ body: { name, slug }, headers });
	const { locals } = getRequestEvent();
	if (org?.id && locals.user) {
		await persistActiveOrganization(headers, locals.user.id, org.id);
	}
	await listMyTeams().refresh();
	return { slug: org?.slug ?? slug };
});

export const inviteMember = command(
	inviteSchema.extend({ organizationId: z.string() }),
	async ({ email, role, organizationId }) => {
		const headers = requireHeaders();
		const invitation = await auth.api.createInvitation({
			body: { email, role, organizationId },
			headers
		});
		return { invitationId: invitation.id };
	}
);

export const acceptInvitation = command(z.string(), async (invitationId) => {
	const headers = requireHeaders();
	await auth.api.acceptInvitation({ body: { invitationId }, headers });
	await listMyTeams().refresh();
});

export const cancelInvitation = command(z.string(), async (invitationId) => {
	const headers = requireHeaders();
	await auth.api.cancelInvitation({ body: { invitationId }, headers });
});

export const setActiveTeam = command(z.string(), async (organizationId) => {
	const headers = requireHeaders();
	const { locals } = getRequestEvent();
	if (!locals.user) error(401, 'Not authenticated');

	const member = await prisma.member.findFirst({
		where: { organizationId, userId: locals.user.id },
		select: { id: true }
	});
	if (!member) error(403, 'Not a member of the selected team');

	await persistActiveOrganization(headers, locals.user.id, organizationId);
	await listMyTeams().refresh();
});

export const removeMember = command(
	z.object({ organizationId: z.string(), memberIdOrEmail: z.string() }),
	async ({ organizationId, memberIdOrEmail }) => {
		const headers = requireHeaders();
		await auth.api.removeMember({ body: { organizationId, memberIdOrEmail }, headers });
	}
);
