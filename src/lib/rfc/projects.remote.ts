import { query, command, getRequestEvent } from '$app/server';
import { z } from 'zod';
import { error } from '@sveltejs/kit';
import { requireHeaders } from '$lib/server/utils';
import { requireActiveOrg } from '$lib/server/org';
import { prisma } from '$lib/server/prisma';
import { listProjectsForOrg, getProjectForOrg } from '$lib/server/projects-service';
import { importProjectSchema } from '$lib/schemas/projects';
import {
	getGithubToken,
	listAllUserRepos,
	getRepo,
	mapRepoToProjectInput,
	type RepoListItem
} from '$lib/server/github';

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

/** Importe un repo : on re-fetch le détail côté serveur (source de vérité) puis upsert. */
export const importProject = command(importProjectSchema, async ({ owner, name }) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const { locals } = getRequestEvent();
	const token = await getGithubToken(headers);
	if (!token) error(400, 'Connect your GitHub account to import repositories.');
	const repo = await getRepo(token, owner, name);
	const data = mapRepoToProjectInput(repo, organizationId, locals.user!.id);
	const project = await prisma.project.upsert({
		where: { organizationId_githubRepoId: { organizationId, githubRepoId: data.githubRepoId } },
		create: data,
		update: { defaultBranch: data.defaultBranch, cloneUrl: data.cloneUrl, private: data.private }
	});
	await listProjects().refresh();
	return { id: project.id };
});
