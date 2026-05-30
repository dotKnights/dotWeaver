import { query, command } from '$app/server';
import { z } from 'zod';
import { error } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { createTeamSchema, inviteSchema } from '$lib/schemas/teams';
import { resolveSlug } from '$lib/server/slug';
import { prisma } from '$lib/server/prisma';
import { requireHeaders } from '$lib/server/utils';



export const listMyTeams = query(async () => {
	const headers = requireHeaders();
	const [teams, session] = await Promise.all([
		auth.api.listOrganizations({ headers }),
		auth.api.getSession({ headers })
	]);
	return {
		teams,
		activeOrganizationId: session?.session.activeOrganizationId ?? null
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
	await auth.api.setActiveOrganization({ body: { organizationId }, headers });
	await listMyTeams().refresh();
});

export const removeMember = command(
	z.object({ organizationId: z.string(), memberIdOrEmail: z.string() }),
	async ({ organizationId, memberIdOrEmail }) => {
		const headers = requireHeaders();
		await auth.api.removeMember({ body: { organizationId, memberIdOrEmail }, headers });
	}
);
