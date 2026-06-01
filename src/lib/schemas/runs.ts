import { z } from 'zod';

export const startRunSchema = z.object({
	projectId: z.string().min(1, 'Project is required'),
	prompt: z.string().min(1, 'A prompt is required')
});

export type StartRunSchema = typeof startRunSchema;

export const approveRunSchema = z.object({
	runId: z.string().min(1),
	action: z.enum(['push_pr', 'push', 'abandon'])
});

export type ApproveRunSchema = typeof approveRunSchema;
