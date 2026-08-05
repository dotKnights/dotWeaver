import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import {
	createGithubTriggerSchema,
	githubTriggerIdSchema,
	organizationIdSchema,
	setWebhookSecretSchema,
	toggleGithubTriggerSchema,
	updateGithubTriggerSchema
} from '$lib/schemas/github-triggers';
import { requireActor, type AuthzActor } from '$lib/server/authz/actor';
import { requireInternalOrgAdmin, requireProjectPermission } from '$lib/server/authz/service';
import {
	createGithubTriggerForOrg,
	deleteGithubTriggerForOrg,
	findGithubTriggerContext,
	generateWebhookSecret,
	getGithubTriggerForOrg,
	GithubTriggerError,
	hasWebhookSecret,
	listGithubTriggersForOrg,
	setGithubTriggerEnabledForOrg,
	setWebhookSecret,
	updateGithubTriggerForOrg
} from '$lib/server/github-triggers/service';

function mapGithubTriggerError(e: unknown): never {
	if (e instanceof GithubTriggerError) {
		error(e.message.endsWith('not found') ? 404 : 400, e.message);
	}
	throw e;
}

/**
 * Résout le trigger puis vérifie la permission sur SON projet : un id de trigger deviné
 * ne donne aucune information si l'acteur n'a pas accès au projet propriétaire.
 */
async function requireTriggerPermission(
	actor: AuthzActor,
	triggerId: string,
	permission: 'project.config.view' | 'project.config.manage'
): Promise<{ organizationId: string }> {
	const context = await findGithubTriggerContext(triggerId);
	if (!context) error(404, 'Trigger not found');
	const project = await requireProjectPermission(actor, permission, context.projectId);
	if (project.organizationId !== context.organizationId) error(404, 'Trigger not found');
	return { organizationId: project.organizationId };
}

/** Triggers d'un projet (org active), du plus récent au plus ancien. */
export const listGithubTriggers = query(z.string(), async (projectId) => {
	const actor = await requireActor();
	const { organizationId } = await requireProjectPermission(
		actor,
		'project.config.view',
		projectId
	);
	return await listGithubTriggersForOrg(organizationId, projectId);
});

/** Détail d'un trigger (org active). */
export const getGithubTrigger = query(githubTriggerIdSchema, async ({ triggerId }) => {
	const actor = await requireActor();
	const { organizationId } = await requireTriggerPermission(actor, triggerId, 'project.config.view');
	try {
		return await getGithubTriggerForOrg(organizationId, triggerId);
	} catch (e) {
		mapGithubTriggerError(e);
	}
});

export const createGithubTrigger = command(createGithubTriggerSchema, async (input) => {
	const actor = await requireActor();
	const { organizationId } = await requireProjectPermission(
		actor,
		'project.config.manage',
		input.projectId
	);
	try {
		const trigger = await createGithubTriggerForOrg(organizationId, actor.userId, input);
		await listGithubTriggers(input.projectId).refresh();
		return trigger;
	} catch (e) {
		mapGithubTriggerError(e);
	}
});

export const updateGithubTrigger = command(updateGithubTriggerSchema, async (input) => {
	const actor = await requireActor();
	const { organizationId } = await requireTriggerPermission(
		actor,
		input.triggerId,
		'project.config.manage'
	);
	try {
		const trigger = await updateGithubTriggerForOrg(organizationId, input);
		await listGithubTriggers(trigger.projectId).refresh();
		await getGithubTrigger({ triggerId: trigger.id }).refresh();
		return trigger;
	} catch (e) {
		mapGithubTriggerError(e);
	}
});

export const deleteGithubTrigger = command(githubTriggerIdSchema, async ({ triggerId }) => {
	const actor = await requireActor();
	const { organizationId } = await requireTriggerPermission(
		actor,
		triggerId,
		'project.config.manage'
	);
	try {
		const trigger = await getGithubTriggerForOrg(organizationId, triggerId);
		await deleteGithubTriggerForOrg(organizationId, triggerId);
		await listGithubTriggers(trigger.projectId).refresh();
		return { success: true };
	} catch (e) {
		mapGithubTriggerError(e);
	}
});

export const toggleGithubTrigger = command(
	toggleGithubTriggerSchema,
	async ({ triggerId, enabled }) => {
		const actor = await requireActor();
		const { organizationId } = await requireTriggerPermission(
			actor,
			triggerId,
			'project.config.manage'
		);
		try {
			const trigger = await setGithubTriggerEnabledForOrg(organizationId, triggerId, enabled);
			await listGithubTriggers(trigger.projectId).refresh();
			return trigger;
		} catch (e) {
			mapGithubTriggerError(e);
		}
	}
);

// ── Secret de webhook (admin org) ────────────────────────────────────────────

/** Indique seulement si un secret existe : sa valeur n'est jamais renvoyée (§7.4). */
export const getWebhookSecretStatus = query(organizationIdSchema, async ({ organizationId }) => {
	const actor = await requireActor();
	requireInternalOrgAdmin(actor, organizationId);
	return { configured: await hasWebhookSecret(organizationId) };
});

export const setOrganizationWebhookSecret = command(setWebhookSecretSchema, async (input) => {
	const actor = await requireActor();
	requireInternalOrgAdmin(actor, input.organizationId);
	try {
		await setWebhookSecret(input.organizationId, input.secret);
		await getWebhookSecretStatus({ organizationId: input.organizationId }).refresh();
		return { success: true };
	} catch (e) {
		mapGithubTriggerError(e);
	}
});

/**
 * Génère (ou fait tourner) le secret côté serveur et le renvoie UNE seule fois :
 * l'utilisateur doit le coller dans GitHub immédiatement, il ne sera plus jamais affiché.
 */
export const rotateOrganizationWebhookSecret = command(
	organizationIdSchema,
	async ({ organizationId }) => {
		const actor = await requireActor();
		requireInternalOrgAdmin(actor, organizationId);
		const secret = generateWebhookSecret();
		try {
			await setWebhookSecret(organizationId, secret);
			await getWebhookSecretStatus({ organizationId }).refresh();
			return { secret };
		} catch (e) {
			mapGithubTriggerError(e);
		}
	}
);
