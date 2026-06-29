import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { getProjectEnvironment } from '$lib/rfc/project-environments.remote';
import { requireActiveOrg } from '$lib/server/org';
import {
	createProjectEnvironmentServiceForOrg,
	listProjectEnvironmentServicesForOrg,
	ProjectEnvironmentServiceError,
	setProjectEnvironmentServiceEnabledForOrg,
	updateProjectEnvironmentServiceEnvMappingsForOrg
} from '$lib/server/project-environment-services/service';
import { enqueueProjectEnvironmentServiceProvision } from '$lib/server/runtime/queue';
import { requireHeaders } from '$lib/server/utils';
import {
	projectEnvironmentServiceCreateSchema,
	projectEnvironmentServiceEnabledSchema,
	projectEnvironmentServiceEnvMappingsSchema,
	projectEnvironmentServiceMutationSchema
} from '$lib/schemas/project-environment-services';

const projectEnvironmentServicesQuerySchema = z.object({
	projectId: z.string().min(1),
	profileId: z.string().min(1)
});

async function context() {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const { locals } = getRequestEvent();
	return { organizationId, userId: locals.user!.id };
}

function mapServiceError(e: unknown): never {
	if (e instanceof ProjectEnvironmentServiceError) {
		error(400, e.message);
	}
	throw e;
}

export const getProjectEnvironmentServices = query(
	projectEnvironmentServicesQuerySchema,
	async ({ projectId, profileId }) => {
		const { organizationId } = await context();
		try {
			return await listProjectEnvironmentServicesForOrg(organizationId, projectId, profileId);
		} catch (e) {
			mapServiceError(e);
		}
	}
);

export const createProjectEnvironmentService = command(
	projectEnvironmentServiceCreateSchema,
	async (input) => {
		const { organizationId, userId } = await context();
		try {
			const service = await createProjectEnvironmentServiceForOrg(organizationId, userId, input);
			await enqueueProjectEnvironmentServiceProvision({ serviceId: service.id });
			await getProjectEnvironmentServices({
				projectId: input.projectId,
				profileId: input.profileId
			}).refresh();
			await getProjectEnvironment(input.projectId).refresh();
			return service;
		} catch (e) {
			mapServiceError(e);
		}
	}
);

export const provisionProjectEnvironmentService = command(
	projectEnvironmentServiceMutationSchema,
	async (input) => {
		const { organizationId } = await context();
		try {
			const services = await listProjectEnvironmentServicesForOrg(
				organizationId,
				input.projectId,
				input.profileId
			);
			if (!services.some((service) => service.id === input.serviceId)) {
				throw new ProjectEnvironmentServiceError('Project environment service not found');
			}
			await enqueueProjectEnvironmentServiceProvision({ serviceId: input.serviceId });
			await getProjectEnvironmentServices({
				projectId: input.projectId,
				profileId: input.profileId
			}).refresh();
			return { queued: true };
		} catch (e) {
			mapServiceError(e);
		}
	}
);

export const setProjectEnvironmentServiceEnabled = command(
	projectEnvironmentServiceEnabledSchema,
	async (input) => {
		const { organizationId } = await context();
		try {
			await setProjectEnvironmentServiceEnabledForOrg(organizationId, input);
			await getProjectEnvironmentServices({
				projectId: input.projectId,
				profileId: input.profileId
			}).refresh();
			await getProjectEnvironment(input.projectId).refresh();
			return { updated: true };
		} catch (e) {
			mapServiceError(e);
		}
	}
);

export const updateProjectEnvironmentServiceEnvMappings = command(
	projectEnvironmentServiceEnvMappingsSchema,
	async (input) => {
		const { organizationId } = await context();
		try {
			await updateProjectEnvironmentServiceEnvMappingsForOrg(organizationId, input);
			await getProjectEnvironmentServices({
				projectId: input.projectId,
				profileId: input.profileId
			}).refresh();
			await getProjectEnvironment(input.projectId).refresh();
			return { updated: true };
		} catch (e) {
			mapServiceError(e);
		}
	}
);
