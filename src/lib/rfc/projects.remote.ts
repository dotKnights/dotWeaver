import { query, command, getRequestEvent } from '$app/server';
import { z } from 'zod';
import { error } from '@sveltejs/kit';
import { requireHeaders } from '$lib/server/utils';
import { requireActiveOrg } from '$lib/server/auth/org';
import {
	listProjectsForOrg,
	getProjectForOrg,
	importGithubProjectForOrg,
	GithubProjectImportError
} from '$lib/server/projects/service';
import { listBranchesForProject } from '$lib/server/projects/branches';
import { importProjectSchema } from '$lib/schemas/projects';
import {
	getGithubToken,
	listAllUserRepos,
	type RepoListItem
} from '$lib/server/integrations/github/service';

/**
 * Repos GitHub de l'utilisateur (pour l'écran d'import). Renvoie `connected: false`
 * si aucun compte GitHub n'est lié (au lieu de jeter — cf. getGithubToken).
 */
export const listGithubRepos = query(async () => {
	const headers = requireHeaders();
	const token = await getGithubToken(headers);
	if (!token) return { connected: false, repos: [] as RepoListItem[] };
	return { connected: true, repos: await listAllUserRepos(token) };
});

/** Projets importés dans l'organisation active. */
export const listProjects = query(async () => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	return await listProjectsForOrg(organizationId);
});

export const getProject = query(z.string(), async (id) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const project = await getProjectForOrg(organizationId, id);
	if (!project) error(404, 'Project not found');
	return project;
});

export const listProjectBranches = query(z.string(), async (id) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const project = await getProjectForOrg(organizationId, id);
	if (!project) error(404, 'Project not found');
	const token = await getGithubToken(headers);
	return await listBranchesForProject(project, token);
});

/** Importe un repo : on re-fetch le détail côté serveur (source de vérité) puis upsert. */
export const importProject = command(importProjectSchema, async ({ owner, name }) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const { locals } = getRequestEvent();
	const token = await getGithubToken(headers);
	try {
		const project = await importGithubProjectForOrg({
			organizationId,
			userId: locals.user!.id,
			token,
			owner,
			name
		});
		await listProjects().refresh();
		return project;
	} catch (e) {
		if (e instanceof GithubProjectImportError) error(400, e.message);
		throw e;
	}
});
