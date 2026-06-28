import { ProjectEnvironmentServiceKind } from '@prisma/client';
import { z } from 'zod';

const serviceNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(40)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Use letters, numbers, dashes or underscores');

export const projectEnvironmentServiceKindSchema = z.enum(ProjectEnvironmentServiceKind);

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

const envVarKeySchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use a valid env var name');

export const serviceEnvMappingSchema = z.object({
	key: envVarKeySchema,
	template: z.string().min(1).max(1000),
	enabled: z.boolean(),
	sensitive: z.union([z.literal('auto'), z.boolean()])
});

export const projectEnvironmentServiceEnvMappingsSchema =
	projectEnvironmentServiceMutationSchema.extend({
		envMappings: z.array(serviceEnvMappingSchema).max(50)
	});
