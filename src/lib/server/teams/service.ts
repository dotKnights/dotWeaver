import { prisma } from '$lib/server/prisma';

/** Organisations dont l'utilisateur est membre (avec son role). */
export async function listTeamsForUser(userId: string) {
	const memberships = await prisma.member.findMany({
		where: { userId },
		select: { role: true, organization: { select: { id: true, slug: true, name: true } } }
	});
	return memberships.map((m) => ({
		id: m.organization.id,
		slug: m.organization.slug,
		name: m.organization.name,
		role: m.role
	}));
}
