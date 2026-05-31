import { query, command, getRequestEvent } from '$app/server';
import { z } from 'zod';
import { error } from '@sveltejs/kit';
import { requireHeaders } from '$lib/server/utils';
import { requireActiveOrg } from '$lib/server/org';
import { prisma } from '$lib/server/prisma';
import { importProjectSchema } from '$lib/schemas/projects';
import {
	getGithubToken,
	listAllUserRepos,
	getRepo,
	mapRepoToProjectInput
} from '$lib/server/github';

/** Repos GitHub de l'utilisateur (pour l'écran d'import). */
export const listGithubRepos = query(async () => {
	const headers = requireHeaders();
	const token = await getGithubToken(headers);
	return await listAllUserRepos(token);
});

/** Projets importés dans l'organisation active. */
export const listProjects = query(async () => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	return await prisma.project.findMany({
		where: { organizationId },
		orderBy: { createdAt: 'desc' }
	});
});

export const getProject = query(z.string(), async (id) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const project = await prisma.project.findFirst({ where: { id, organizationId } });
	if (!project) error(404, 'Project not found');
	return project;
});

/** Importe un repo : on re-fetch le détail côté serveur (source de vérité) puis upsert. */
export const importProject = command(importProjectSchema, async ({ owner, name }) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const { locals } = getRequestEvent();
	const token = await getGithubToken(headers);
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
