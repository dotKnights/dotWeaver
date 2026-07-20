import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { getGithubToken } from '$lib/server/integrations/github/service';
import { requireActor } from '$lib/server/authz/actor';
import { requireProjectPermission } from '$lib/server/authz/service';
import type { Permission } from '$lib/authz/permissions';
import {
	detectProjectEnvironmentForOrg,
	getDefaultProjectEnvironmentForOrg,
	listProjectEnvironmentPrepareEventsForOrg,
	ProjectEnvironmentError,
	requireProjectEnvironmentProfileForOrg,
	upsertProjectEnvironmentProfileForOrg
} from '$lib/server/project-environments/service';
import { enqueueProjectEnvironmentPrepare } from '$lib/server/runtime/queue';
import { requireHeaders } from '$lib/server/auth/request';
import {
	projectEnvironmentDetectSchema,
	projectEnvironmentPrepareSchema,
	projectEnvironmentProfileInputSchema
} from '$lib/schemas/project-environments';

type ProjectConfigPermission = Extract<Permission, 'project.config.view' | 'project.config.manage'>;

async function context(projectId: string, permission: ProjectConfigPermission) {
	const headers = requireHeaders();
	const actor = await requireActor();
	const { organizationId } = await requireProjectPermission(actor, permission, projectId);
	const { locals } = getRequestEvent();
	return { headers, organizationId, userId: locals.user!.id };
}

function mapEnvironmentError(e: unknown): never {
	if (e instanceof ProjectEnvironmentError) {
		error(e.message === 'Project not found' ? 404 : 400, e.message);
	}
	throw e;
}

export const getProjectEnvironment = query(z.string().min(1), async (projectId) => {
	const { organizationId } = await context(projectId, 'project.config.view');
	try {
		return await getDefaultProjectEnvironmentForOrg(organizationId, projectId);
	} catch (e) {
		mapEnvironmentError(e);
	}
});

export const getProjectEnvironmentPrepareEvents = query(
	z.object({ projectId: z.string().min(1), profileId: z.string().min(1) }),
	async ({ projectId, profileId }) => {
		const { organizationId } = await context(projectId, 'project.config.view');
		try {
			return await listProjectEnvironmentPrepareEventsForOrg(organizationId, projectId, profileId);
		} catch (e) {
			mapEnvironmentError(e);
		}
	}
);

export const detectProjectEnvironment = command(
	projectEnvironmentDetectSchema,
	async ({ projectId }) => {
		const { headers, organizationId, userId } = await context(projectId, 'project.config.manage');
		const githubToken = await getGithubToken(headers);
		try {
			const result = await detectProjectEnvironmentForOrg({
				organizationId,
				userId,
				projectId,
				githubToken
			});
			await getProjectEnvironment(projectId).refresh();
			return result;
		} catch (e) {
			mapEnvironmentError(e);
		}
	}
);

export const saveProjectEnvironment = command(
	projectEnvironmentProfileInputSchema,
	async (input) => {
		const { organizationId, userId } = await context(input.projectId, 'project.config.manage');
		try {
			const result = await upsertProjectEnvironmentProfileForOrg(organizationId, userId, input);
			await getProjectEnvironment(input.projectId).refresh();
			return result;
		} catch (e) {
			mapEnvironmentError(e);
		}
	}
);

export const prepareProjectEnvironment = command(
	projectEnvironmentPrepareSchema,
	async ({ projectId, profileId, force }) => {
		const { organizationId, userId } = await context(projectId, 'project.config.manage');
		try {
			await requireProjectEnvironmentProfileForOrg(organizationId, projectId, profileId);
			await enqueueProjectEnvironmentPrepare({ profileId, requestedById: userId, force });
			await getProjectEnvironment(projectId).refresh();
			await getProjectEnvironmentPrepareEvents({ projectId, profileId }).refresh();
			return { queued: true };
		} catch (e) {
			mapEnvironmentError(e);
		}
	}
);
