import { z } from 'zod';
import { RUN_MODE } from '$lib/domain/run-mode';

/** Modèles proposés au lancement d'un run. Alias résolus par Claude Code (pas d'ID figé). */
export const RUN_MODELS = [
	{ value: 'sonnet', label: 'Sonnet' },
	{ value: 'opus', label: 'Opus' },
	{ value: 'haiku', label: 'Haiku' }
] as const;

export const runModelSchema = z.enum(['sonnet', 'opus', 'haiku']);
export type RunModel = z.infer<typeof runModelSchema>;

export const runModeSchema = z.enum([RUN_MODE.AGENT, RUN_MODE.CDC]);

export const startRunSchema = z.object({
	projectId: z.string().min(1, 'Project is required'),
	prompt: z.string().min(1, 'A prompt is required'),
	baseBranch: z.string().min(1, 'Base branch is required').optional(),
	// Absent = on laisse l'agent décider (pas d'override de modèle).
	model: runModelSchema.optional(),
	useProjectAgentConfig: z.boolean().default(true),
	mode: runModeSchema.default(RUN_MODE.AGENT)
});

export type StartRunSchema = typeof startRunSchema;

export const approveRunSchema = z.object({
	runId: z.string().min(1),
	action: z.enum(['push_pr', 'push', 'abandon'])
});

export type ApproveRunSchema = typeof approveRunSchema;

export const replyToRunSchema = z.object({
	runId: z.string().min(1),
	message: z.string().min(1, 'A message is required')
});

export type ReplyToRunSchema = typeof replyToRunSchema;
