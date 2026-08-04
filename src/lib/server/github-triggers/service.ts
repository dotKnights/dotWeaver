import { randomBytes } from 'node:crypto';
import type { GithubTrigger, Prisma } from '@prisma/client';
import { validatePromptTemplate } from '$lib/domain/github-triggers';
import type {
	CreateGithubTriggerInput,
	TriggerConditions,
	TriggerRunTemplate,
	UpdateGithubTriggerInput
} from '$lib/schemas/github-triggers';
import {
	createGithubTriggerSchema,
	updateGithubTriggerSchema
} from '$lib/schemas/github-triggers';
import { prisma } from '$lib/server/prisma';
import {
	decryptProjectSecretValue,
	encryptProjectSecretValue
} from '$lib/server/project-agent-config/encryption';

/** Erreur métier des triggers GitHub (mappée 400/404 côté remote). */
export class GithubTriggerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GithubTriggerError';
	}
}

export type GithubTriggerContext = {
	id: string;
	projectId: string;
	organizationId: string;
};

/** Colonnes de conditions dérivées du discriminant `eventType`. */
function conditionColumns(conditions: TriggerConditions) {
	return {
		eventType: conditions.eventType,
		labelFilter: conditions.labelFilter ?? null,
		commentKeyword: conditions.commentKeyword ?? null,
		baseBranchPattern: conditions.baseBranchPattern ?? null
	};
}

function runTemplateColumns(runTemplate: TriggerRunTemplate) {
	return {
		agent: runTemplate.agent,
		model: runTemplate.model,
		runBaseBranch: runTemplate.runBaseBranch,
		promptTemplate: runTemplate.promptTemplate
	};
}

export function listGithubTriggersForOrg(
	organizationId: string,
	projectId: string
): Promise<GithubTrigger[]> {
	return prisma.githubTrigger.findMany({
		where: { organizationId, projectId },
		orderBy: { createdAt: 'desc' }
	});
}

/** Trigger d'un projet (scope org). Lève `GithubTriggerError` si absent/hors org. */
export async function getGithubTriggerForOrg(
	organizationId: string,
	triggerId: string
): Promise<GithubTrigger> {
	const trigger = await prisma.githubTrigger.findFirst({
		where: { id: triggerId, organizationId }
	});
	if (!trigger) throw new GithubTriggerError('Trigger not found');
	return trigger;
}

/**
 * Résout le projet/org d'un trigger sans contrôle d'accès : sert uniquement aux remotes
 * pour savoir sur quel projet appliquer `requireProjectPermission`.
 */
export async function findGithubTriggerContext(
	triggerId: string
): Promise<GithubTriggerContext | null> {
	return prisma.githubTrigger.findUnique({
		where: { id: triggerId },
		select: { id: true, projectId: true, organizationId: true }
	});
}

export async function createGithubTriggerForOrg(
	organizationId: string,
	createdById: string,
	rawInput: CreateGithubTriggerInput
): Promise<GithubTrigger> {
	const input = createGithubTriggerSchema.parse(rawInput);
	const project = await prisma.project.findFirst({
		where: { id: input.projectId, organizationId },
		select: { id: true }
	});
	if (!project) throw new GithubTriggerError('Project not found');

	return prisma.githubTrigger.create({
		data: {
			projectId: input.projectId,
			organizationId,
			createdById,
			name: input.name,
			description: input.description ?? null,
			enabled: input.enabled,
			...conditionColumns(input.conditions),
			...runTemplateColumns(input.runTemplate)
		}
	});
}

export async function updateGithubTriggerForOrg(
	organizationId: string,
	rawInput: UpdateGithubTriggerInput
): Promise<GithubTrigger> {
	const input = updateGithubTriggerSchema.parse(rawInput);
	const existing = await getGithubTriggerForOrg(organizationId, input.triggerId);

	// Conditions et template sont solidaires du type d'évènement. Le schéma ne peut valider
	// leur cohérence que si les deux sont fournis ; sinon on complète avec l'état stocké.
	const eventType = input.conditions?.eventType ?? existing.eventType;
	const promptTemplate = input.runTemplate?.promptTemplate ?? existing.promptTemplate;
	const unknownVariables = validatePromptTemplate(promptTemplate, eventType);
	if (unknownVariables.length > 0) {
		throw new GithubTriggerError(
			`Unknown variable${unknownVariables.length > 1 ? 's' : ''} for this event: ${unknownVariables
				.map((name) => `{{${name}}}`)
				.join(', ')}`
		);
	}

	const data: Prisma.GithubTriggerUpdateInput = {};
	if (input.name !== undefined) data.name = input.name;
	if (input.description !== undefined) data.description = input.description || null;
	if (input.enabled !== undefined) data.enabled = input.enabled;
	if (input.conditions) Object.assign(data, conditionColumns(input.conditions));
	if (input.runTemplate) Object.assign(data, runTemplateColumns(input.runTemplate));

	return prisma.githubTrigger.update({
		where: { id: existing.id },
		data
	});
}

export async function deleteGithubTriggerForOrg(
	organizationId: string,
	triggerId: string
): Promise<void> {
	const result = await prisma.githubTrigger.deleteMany({
		where: { id: triggerId, organizationId }
	});
	if (result.count === 0) throw new GithubTriggerError('Trigger not found');
}

export async function setGithubTriggerEnabledForOrg(
	organizationId: string,
	triggerId: string,
	enabled: boolean
): Promise<GithubTrigger> {
	const trigger = await getGithubTriggerForOrg(organizationId, triggerId);
	return prisma.githubTrigger.update({ where: { id: trigger.id }, data: { enabled } });
}

// ── Secret de webhook (org) ──────────────────────────────────────────────────

/** Secret aléatoire de 32 octets, au format hexadécimal, à coller dans GitHub. */
export function generateWebhookSecret(): string {
	return randomBytes(32).toString('hex');
}

export async function setWebhookSecret(organizationId: string, secret: string): Promise<void> {
	const organization = await prisma.organization.findUnique({
		where: { id: organizationId },
		select: { id: true }
	});
	if (!organization) throw new GithubTriggerError('Organization not found');

	await prisma.organization.update({
		where: { id: organizationId },
		data: { webhookSecretEncrypted: encryptProjectSecretValue(secret) }
	});
}

/** Secret en clair : réservé à la vérification HMAC, jamais renvoyé à un client. */
export async function getWebhookSecret(organizationId: string): Promise<string | null> {
	const organization = await prisma.organization.findUnique({
		where: { id: organizationId },
		select: { webhookSecretEncrypted: true }
	});
	if (!organization?.webhookSecretEncrypted) return null;
	return decryptProjectSecretValue(organization.webhookSecretEncrypted);
}

export async function hasWebhookSecret(organizationId: string): Promise<boolean> {
	const organization = await prisma.organization.findUnique({
		where: { id: organizationId },
		select: { webhookSecretEncrypted: true }
	});
	return Boolean(organization?.webhookSecretEncrypted);
}
