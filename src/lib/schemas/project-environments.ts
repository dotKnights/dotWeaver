import { z } from 'zod';
import {
	NODE_PACKAGE_MANAGERS,
	PROJECT_ENVIRONMENT_PACKAGE_MANAGERS,
	PROJECT_ENVIRONMENT_RUNTIMES,
	PYTHON_PACKAGE_MANAGERS
} from '$lib/domain/project-environment';

export const projectEnvironmentRuntimeSchema = z.enum(PROJECT_ENVIRONMENT_RUNTIMES);
export const projectEnvironmentPackageManagerSchema = z.enum(PROJECT_ENVIRONMENT_PACKAGE_MANAGERS);

const commandSchema = z
	.string()
	.trim()
	.max(500)
	.refine((value) => !value.includes('\0'), 'Command cannot contain null bytes')
	.default('');

export const projectEnvironmentProfileInputSchema = z
	.object({
		projectId: z.string().min(1),
		name: z.literal('default').default('default'),
		runtime: projectEnvironmentRuntimeSchema,
		adapterId: z.enum(['node', 'python', 'custom']),
		packageManager: projectEnvironmentPackageManagerSchema,
		installCommand: commandSchema,
		testCommand: commandSchema,
		buildCommand: commandSchema,
		devCommand: commandSchema
	})
	.superRefine((input, ctx) => {
		if (
			input.runtime === 'node' &&
			!NODE_PACKAGE_MANAGERS.includes(input.packageManager as never)
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['packageManager'],
				message: `${input.packageManager} is not valid for node`
			});
		}
		if (
			input.runtime === 'python' &&
			!PYTHON_PACKAGE_MANAGERS.includes(input.packageManager as never)
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['packageManager'],
				message: `${input.packageManager} is not valid for python`
			});
		}
		if (input.runtime === 'custom' && input.packageManager !== 'custom') {
			ctx.addIssue({
				code: 'custom',
				path: ['packageManager'],
				message: `${input.packageManager} is not valid for custom`
			});
		}
		if (input.adapterId !== input.runtime) {
			ctx.addIssue({
				code: 'custom',
				path: ['adapterId'],
				message: `Adapter ${input.adapterId} does not match runtime ${input.runtime}`
			});
		}
	});

export type ProjectEnvironmentProfileInput = z.infer<typeof projectEnvironmentProfileInputSchema>;

export const projectEnvironmentProjectIdSchema = z.object({
	projectId: z.string().min(1)
});

export const projectEnvironmentDetectSchema = projectEnvironmentProjectIdSchema;

export const projectEnvironmentPrepareSchema = projectEnvironmentProjectIdSchema.extend({
	profileId: z.string().min(1),
	force: z.boolean().default(false)
});
