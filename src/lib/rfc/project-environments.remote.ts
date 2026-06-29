import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { getGithubToken } from '$lib/server/integrations/github/service';
import { requireActiveOrg } from '$lib/server/auth/org';
import {
	detectProjectEnvironmentForOrg,
	getDefaultProjectEnvironmentForOrg,
	listProjectEnvironmentPrepareEventsForOrg,
	ProjectEnvironmentError,
	requireProjectEnvironmentProfileForOrg,
	upsertProjectEnvironmentProfileForOrg
} from '$lib/server/project-environments/service';
import { enqueueProjectEnvironmentPrepare } from '$lib/server/runtime/queue';
import { requireHeaders } from '$lib/server/utils';
import {
	projectEnvironmentDetectSchema,
	projectEnvironmentPrepareSchema,
	projectEnvironmentProfileInputSchema
} from '$lib/schemas/project-environments';

async function context() {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
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
	const { organizationId } = await context();
	try {
		return await getDefaultProjectEnvironmentForOrg(organizationId, projectId);
	} catch (e) {
		mapEnvironmentError(e);
	}
});

export const getProjectEnvironmentPrepareEvents = query(
	z.object({ projectId: z.string().min(1), profileId: z.string().min(1) }),
	async ({ projectId, profileId }) => {
		const { organizationId } = await context();
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
		const { headers, organizationId, userId } = await context();
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
		const { organizationId, userId } = await context();
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
		const { organizationId, userId } = await context();
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
