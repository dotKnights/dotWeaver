import { query, command, getRequestEvent } from '$app/server';
import { z } from 'zod';
import { error } from '@sveltejs/kit';
import { requireHeaders } from '$lib/server/utils';
import { requireActiveOrg } from '$lib/server/org';
import { prisma } from '$lib/server/prisma';
import { startRunSchema } from '$lib/schemas/runs';
import { agentBranch } from '$lib/server/workspace-paths';
import { enqueueRun } from '$lib/server/queue';

/** Crée un run (queued) sur un projet de l'org active et l'enqueue. */
export const startRun = command(startRunSchema, async ({ projectId, prompt }) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const { locals } = getRequestEvent();
	const project = await prisma.project.findFirst({ where: { id: projectId, organizationId } });
	if (!project) error(404, 'Project not found');

	const id = crypto.randomUUID();
	await prisma.run.create({
		data: {
			id,
			projectId,
			organizationId,
			createdById: locals.user!.id,
			prompt,
			agentBranch: agentBranch(id),
			status: 'queued'
		}
	});
	await enqueueRun(id);
	await listRuns(projectId).refresh();
	return { runId: id };
});

/** Runs d'un projet (org active), du plus récent au plus ancien. */
export const listRuns = query(z.string(), async (projectId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	return prisma.run.findMany({
		where: { projectId, organizationId },
		orderBy: { queuedAt: 'desc' },
		select: {
			id: true,
			status: true,
			prompt: true,
			queuedAt: true,
			finishedAt: true,
			error: true
		}
	});
});

/** Détail d'un run (org active) avec ses events ordonnés. */
export const getRun = query(z.string(), async (runId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const run = await prisma.run.findFirst({
		where: { id: runId, organizationId },
		include: { events: { orderBy: { seq: 'asc' } } }
	});
	if (!run) error(404, 'Run not found');
	return run;
});
