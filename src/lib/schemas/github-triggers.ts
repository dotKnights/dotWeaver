import { GithubTriggerEventType } from '@prisma/client';
import { z } from 'zod';
import { validatePromptTemplate } from '$lib/domain/github-triggers';
import { CLAUDE_RUN_MODELS, CODEX_RUN_MODELS } from '$lib/schemas/runs';

export const githubTriggerEventTypeSchema = z.enum(GithubTriggerEventType);

const CLAUDE_MODEL_VALUES: readonly string[] = CLAUDE_RUN_MODELS.map((model) => model.value);
const CODEX_MODEL_VALUES: readonly string[] = CODEX_RUN_MODELS.map((model) => model.value);

// ── Conditions (discriminées par eventType) ──────────────────────────────────

const issuesOpenedConditionsSchema = z.object({
	eventType: z.literal(GithubTriggerEventType.ISSUES_OPENED),
	labelFilter: z.string().trim().min(1, 'Label is required').max(120),
	commentKeyword: z.undefined().optional(),
	baseBranchPattern: z.undefined().optional()
});

const issueCommentCreatedConditionsSchema = z.object({
	eventType: z.literal(GithubTriggerEventType.ISSUE_COMMENT_CREATED),
	labelFilter: z.string().trim().min(1, 'Label is required').max(120),
	commentKeyword: z.string().trim().min(1).max(120).optional(),
	baseBranchPattern: z.undefined().optional()
});

const pullRequestReviewSubmittedConditionsSchema = z.object({
	eventType: z.literal(GithubTriggerEventType.PULL_REQUEST_REVIEW_SUBMITTED),
	labelFilter: z.undefined().optional(),
	commentKeyword: z.undefined().optional(),
	baseBranchPattern: z.string().trim().min(1).max(200).optional()
});

export const triggerConditionsSchema = z.discriminatedUnion('eventType', [
	issuesOpenedConditionsSchema,
	issueCommentCreatedConditionsSchema,
	pullRequestReviewSubmittedConditionsSchema
]);
export type TriggerConditions = z.infer<typeof triggerConditionsSchema>;

// ── Modèle de run ────────────────────────────────────────────────────────────

export const triggerRunTemplateSchema = z
	.object({
		agent: z.enum(['claude', 'codex']),
		model: z.string().min(1, 'Model is required'),
		runBaseBranch: z.string().trim().min(1).default('{{default_branch}}'),
		promptTemplate: z.string().trim().min(1, 'Prompt template is required').max(20_000)
	})
	.superRefine((input, ctx) => {
		// Le run créé par le trigger doit rester valide au regard de `startRunSchema`.
		const allowed = input.agent === 'codex' ? CODEX_MODEL_VALUES : CLAUDE_MODEL_VALUES;
		if (!allowed.includes(input.model)) {
			ctx.addIssue({
				code: 'custom',
				path: ['model'],
				message: `Model ${input.model} is not available for ${input.agent} runs`
			});
		}
	});
export type TriggerRunTemplate = z.infer<typeof triggerRunTemplateSchema>;

// ── Triggers ─────────────────────────────────────────────────────────────────

const githubTriggerBaseSchema = z.object({
	projectId: z.string().min(1),
	name: z.string().trim().min(1, 'Name is required').max(120),
	description: z.string().trim().max(500).optional(),
	enabled: z.boolean().default(true),
	conditions: triggerConditionsSchema,
	runTemplate: triggerRunTemplateSchema
});

/**
 * Message d'erreur si le template référence une variable indisponible pour l'évènement
 * choisi (§5.3). `null` quand il n'y a rien à signaler.
 */
function promptTemplateIssue(input: {
	conditions?: TriggerConditions;
	runTemplate?: TriggerRunTemplate;
}): string | null {
	if (!input.conditions || !input.runTemplate) return null;
	const unknown = validatePromptTemplate(
		input.runTemplate.promptTemplate,
		input.conditions.eventType
	);
	if (unknown.length === 0) return null;
	return `Unknown variable${unknown.length > 1 ? 's' : ''} for this event: ${unknown
		.map((name) => `{{${name}}}`)
		.join(', ')}`;
}

export const createGithubTriggerSchema = githubTriggerBaseSchema.superRefine((input, ctx) => {
	const message = promptTemplateIssue(input);
	if (message) {
		ctx.addIssue({ code: 'custom', path: ['runTemplate', 'promptTemplate'], message });
	}
});
export type CreateGithubTriggerInput = z.infer<typeof createGithubTriggerSchema>;

export const updateGithubTriggerSchema = githubTriggerBaseSchema
	.partial()
	.extend({ triggerId: z.string().min(1) })
	.superRefine((input, ctx) => {
		const message = promptTemplateIssue(input);
		if (message) {
			ctx.addIssue({ code: 'custom', path: ['runTemplate', 'promptTemplate'], message });
		}
	});
export type UpdateGithubTriggerInput = z.infer<typeof updateGithubTriggerSchema>;

export const githubTriggerIdSchema = z.object({ triggerId: z.string().min(1) });

export const toggleGithubTriggerSchema = z.object({
	triggerId: z.string().min(1),
	enabled: z.boolean()
});

/** Forme renvoyée au client : identique au modèle Prisma, jamais de secret. */
export const githubTriggerSchema = z.object({
	id: z.string(),
	createdAt: z.date(),
	updatedAt: z.date(),
	projectId: z.string(),
	organizationId: z.string(),
	createdById: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	eventType: githubTriggerEventTypeSchema,
	labelFilter: z.string().nullable(),
	commentKeyword: z.string().nullable(),
	baseBranchPattern: z.string().nullable(),
	agent: z.string(),
	model: z.string(),
	runBaseBranch: z.string(),
	promptTemplate: z.string(),
	enabled: z.boolean()
});
export type GithubTrigger = z.infer<typeof githubTriggerSchema>;

// ── Secret de webhook (org) ──────────────────────────────────────────────────

export const setWebhookSecretSchema = z.object({
	organizationId: z.string().min(1),
	secret: z.string().min(16, 'Secret must be at least 16 characters').max(200)
});
export type SetWebhookSecretInput = z.infer<typeof setWebhookSecretSchema>;

export const organizationIdSchema = z.object({ organizationId: z.string().min(1) });
