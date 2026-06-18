import { z } from 'zod';

export const RUN_AGENTS = [
	{ value: 'claude', label: 'Claude Code' },
	{ value: 'codex', label: 'Codex' }
] as const;

export const runAgentSchema = z.enum(['claude', 'codex']);
export type RunAgent = z.infer<typeof runAgentSchema>;

/** Modèles proposés au lancement d'un run Claude. Alias résolus par Claude Code. */
export const CLAUDE_RUN_MODELS = [
	{ value: 'sonnet', label: 'Sonnet' },
	{ value: 'opus', label: 'Opus' },
	{ value: 'haiku', label: 'Haiku' }
] as const;

/** Modèles proposés au lancement d'un run Codex. */
export const CODEX_RUN_MODELS = [
	{ value: 'gpt-5.5', label: 'GPT-5.5' },
	{ value: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
	{ value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' }
] as const;

export const RUN_MODELS = [...CLAUDE_RUN_MODELS, ...CODEX_RUN_MODELS] as const;

const CLAUDE_MODEL_VALUES = CLAUDE_RUN_MODELS.map((model) => model.value);
const CODEX_MODEL_VALUES = CODEX_RUN_MODELS.map((model) => model.value);

export const runModelSchema = z.enum([
	'sonnet',
	'opus',
	'haiku',
	'gpt-5.5',
	'gpt-5.4-mini',
	'gpt-5.3-codex-spark'
]);
export type RunModel = z.infer<typeof runModelSchema>;

export const startRunSchema = z
	.object({
		projectId: z.string().min(1, 'Project is required'),
		prompt: z.string().min(1, 'A prompt is required'),
		agent: runAgentSchema.default('claude'),
		baseBranch: z.string().min(1, 'Base branch is required').optional(),
		// Absent = on laisse l'agent décider (pas d'override de modèle).
		model: runModelSchema.optional(),
		useProjectAgentConfig: z.boolean().default(true)
	})
	.superRefine((input, ctx) => {
		if (!input.model) return;
		const allowed =
			input.agent === 'codex'
				? (CODEX_MODEL_VALUES as readonly string[])
				: (CLAUDE_MODEL_VALUES as readonly string[]);
		if (!allowed.includes(input.model)) {
			ctx.addIssue({
				code: 'custom',
				path: ['model'],
				message: `Model ${input.model} is not available for ${input.agent} runs`
			});
		}
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
