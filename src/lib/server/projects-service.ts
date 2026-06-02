import { prisma } from '$lib/server/prisma';

/** Projets d'une organisation, du plus récent au plus ancien. */
export function listProjectsForOrg(organizationId: string) {
	return prisma.project.findMany({
		where: { organizationId },
		orderBy: { createdAt: 'desc' }
	});
}

/** Projet par id, scopé à l'org. `null` si absent ou hors org. */
export function getProjectForOrg(organizationId: string, id: string) {
	return prisma.project.findFirst({ where: { id, organizationId } });
}
