import { getRepo, mapRepoToProjectInput } from '$lib/server/integrations/github/service';
import { prisma } from '$lib/server/prisma';
import { projectResource } from '$lib/authz/resources';
import type { AuthzActor } from '$lib/server/authz/actor';
import { listAccessibleProjects, can } from '$lib/server/authz/service';

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

export function listProjectsForActor(actor: AuthzActor) {
	return listAccessibleProjects(actor);
}

export async function getProjectForActor(actor: AuthzActor, id: string) {
	if (!(await can(actor, 'project.view', projectResource(id)))) return null;

	return prisma.project.findFirst({ where: { id } });
}

export class GithubProjectImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GithubProjectImportError';
	}
}

export async function importGithubProjectForOrg(input: {
	organizationId: string;
	userId: string;
	token: string | null;
	owner: string;
	name: string;
}): Promise<{ id: string }> {
	if (!input.token) {
		throw new GithubProjectImportError('Connect your GitHub account to continue');
	}

	const repo = await getRepo(input.token, input.owner, input.name);
	const data = mapRepoToProjectInput(repo, input.organizationId, input.userId);
	const project = await prisma.project.upsert({
		where: {
			organizationId_githubRepoId: {
				organizationId: input.organizationId,
				githubRepoId: data.githubRepoId
			}
		},
		create: data,
		update: {
			defaultBranch: data.defaultBranch,
			cloneUrl: data.cloneUrl,
			private: data.private
		}
	});

	return { id: project.id };
}
