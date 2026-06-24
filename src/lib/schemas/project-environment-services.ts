import { z } from 'zod';
import { PROJECT_ENVIRONMENT_SERVICE_KINDS } from '$lib/domain/project-environment-service';

const serviceNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(40)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Use letters, numbers, dashes or underscores');

export const projectEnvironmentServiceKindSchema = z.enum(PROJECT_ENVIRONMENT_SERVICE_KINDS);

export const projectEnvironmentServiceCreateSchema = z
	.object({
		projectId: z.string().min(1),
		profileId: z.string().min(1),
		kind: projectEnvironmentServiceKindSchema,
		name: serviceNameSchema.optional()
	})
	.transform((input) => ({
		...input,
		name: input.name ?? input.kind
	}));

export const projectEnvironmentServiceMutationSchema = z.object({
	projectId: z.string().min(1),
	profileId: z.string().min(1),
	serviceId: z.string().min(1)
});

export const projectEnvironmentServiceEnabledSchema =
	projectEnvironmentServiceMutationSchema.extend({
		enabled: z.boolean()
	});
