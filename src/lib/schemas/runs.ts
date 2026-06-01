import { z } from 'zod';

/** Modèles proposés au lancement d'un run. Alias résolus par Claude Code (pas d'ID figé). */
export const RUN_MODELS = [
	{ value: 'sonnet', label: 'Sonnet' },
	{ value: 'opus', label: 'Opus' },
	{ value: 'haiku', label: 'Haiku' }
] as const;

export const runModelSchema = z.enum(['sonnet', 'opus', 'haiku']);
export type RunModel = z.infer<typeof runModelSchema>;

export const startRunSchema = z.object({
	projectId: z.string().min(1, 'Project is required'),
	prompt: z.string().min(1, 'A prompt is required'),
	// Absent = on laisse l'agent décider (pas d'override de modèle).
	model: runModelSchema.optional()
});

export type StartRunSchema = typeof startRunSchema;

export const approveRunSchema = z.object({
	runId: z.string().min(1),
	action: z.enum(['push_pr', 'push', 'abandon'])
});

export type ApproveRunSchema = typeof approveRunSchema;
