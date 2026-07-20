import { error } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { prisma } from '$lib/server/prisma';

export type InternalMembership = {
	organizationId: string;
	role: string;
};

export type ClientMembership = {
	id: string;
	organizationId: string;
	clientOrganizationId: string;
	role: string;
};

export type AuthzActor = {
	userId: string;
	internalMemberships: InternalMembership[];
	clientMemberships: ClientMembership[];
};

export async function actorForUserId(userId: string): Promise<AuthzActor> {
	const [internalMemberships, clientMemberships] = await Promise.all([
		prisma.member.findMany({
			where: { userId },
			select: { organizationId: true, role: true }
		}),
		prisma.clientOrganizationMember.findMany({
			where: { userId },
			select: { id: true, organizationId: true, clientOrganizationId: true, role: true }
		})
	]);

	return {
		userId,
		internalMemberships,
		clientMemberships
	};
}

export async function requireActor(): Promise<AuthzActor> {
	const { locals } = getRequestEvent();
	const userId = locals.user?.id;
	if (!userId) error(401, 'Not authenticated');

	return actorForUserId(userId);
}
