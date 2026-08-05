import { timingSafeEqual } from 'node:crypto';
import type { GithubTrigger, Prisma } from '@prisma/client';
import { env as privateEnv } from '$env/dynamic/private';
import { resolveBaseBranch } from '$lib/domain/github-triggers';
import type { RunAgent, RunModel } from '$lib/schemas/runs';
import { prisma } from '$lib/server/prisma';
import { eventRepo, parseGithubEvent, readPayloadAction } from '$lib/server/github-triggers/events';
import type { ParsedEvent } from '$lib/server/github-triggers/events';
import { matchesTrigger, renderPromptTemplate } from '$lib/server/github-triggers/matching';
import { getWebhookSecret } from '$lib/server/github-triggers/service';
import { startRunForOrg } from '$lib/server/runs/service';

const TIMEOUT_MS = Number(privateEnv.RUN_TIMEOUT_MS ?? 30 * 60 * 1000);

/** Longueur d'un HMAC-SHA256 en hexadécimal. */
const SIGNATURE_HEX_LENGTH = 64;

/** Extrait du corps conservé quand le payload n'est pas du JSON exploitable. */
const UNPARSABLE_PAYLOAD_EXCERPT_LENGTH = 2_000;

export type WebhookHandleInput = {
	rawBody: string;
	/** `orgId` de l'URL enregistrée sur GitHub — entrée non fiable, authentifiée par le HMAC. */
	organizationId: string | null;
	headers: {
		signature: string;
		event: string;
		deliveryId: string;
	};
};

export type WebhookHandleResult =
	| { status: 'invalid_signature' }
	| { status: 'duplicate'; deliveryId: string }
	| { status: 'skipped'; deliveryId: string; reason: string }
	| { status: 'completed'; deliveryId: string; runsCreated: string[] }
	| { status: 'failed'; deliveryId: string; error: string };

type TriggerRunError = { triggerId: string; error: string };

function isHex(value: string): boolean {
	return /^[0-9a-f]+$/i.test(value);
}

/**
 * Vérifie l'en-tête `X-Hub-Signature-256`. Le HMAC est calculé via Web Crypto (compatible
 * Bun) et la comparaison est à temps constant pour ne pas transformer l'endpoint en oracle.
 */
export async function verifySignature(
	rawBody: string,
	signatureHeader: string,
	secret: string
): Promise<boolean> {
	const [algorithm, receivedHex] = signatureHeader.split('=');
	if (algorithm !== 'sha256' || !receivedHex) return false;
	if (receivedHex.length !== SIGNATURE_HEX_LENGTH || !isHex(receivedHex)) return false;

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
	const expectedHex = Buffer.from(signature).toString('hex');

	return timingSafeEqual(
		Buffer.from(receivedHex.toLowerCase(), 'utf8'),
		Buffer.from(expectedHex, 'utf8')
	);
}

function isPrismaUniqueConstraintError(e: unknown): boolean {
	return (
		typeof e === 'object' &&
		e !== null &&
		'code' in e &&
		(e as { code?: unknown }).code === 'P2002'
	);
}

function parseJsonPayload(rawBody: string): { ok: true; payload: unknown } | { ok: false } {
	try {
		return { ok: true, payload: JSON.parse(rawBody) as unknown };
	} catch {
		return { ok: false };
	}
}

function asJsonPayload(payload: unknown): Prisma.InputJsonValue {
	return payload as Prisma.InputJsonValue;
}

async function markSkipped(deliveryId: string, reason: string): Promise<void> {
	await prisma.githubWebhookDelivery.update({
		where: { id: deliveryId },
		data: { status: 'SKIPPED', processedAt: new Date(), errorMessage: reason }
	});
}

async function markFailed(deliveryId: string, error: string): Promise<void> {
	await prisma.githubWebhookDelivery.update({
		where: { id: deliveryId },
		data: { status: 'FAILED', processedAt: new Date(), errorMessage: error }
	});
}

/** Crée les runs des triggers déclenchés ; une erreur sur l'un n'interrompt pas les autres. */
async function createRunsForTriggers(input: {
	triggers: GithubTrigger[];
	event: ParsedEvent;
	deliveryId: string;
	defaultBranch: string;
}): Promise<{ runIds: string[]; errors: TriggerRunError[] }> {
	const runIds: string[] = [];
	const errors: TriggerRunError[] = [];

	for (const trigger of input.triggers) {
		try {
			const result = await startRunForOrg({
				organizationId: trigger.organizationId,
				// Le run est attribué à l'auteur du trigger : pas de session pour un webhook.
				userId: trigger.createdById,
				// Pas de token utilisateur disponible hors session : le miroir est lu en anonyme.
				githubToken: null,
				projectId: trigger.projectId,
				prompt: renderPromptTemplate(trigger.promptTemplate, input.event),
				agent: trigger.agent as RunAgent,
				baseBranch: resolveBaseBranch(trigger.runBaseBranch, input.defaultBranch),
				model: trigger.model as RunModel,
				useProjectAgentConfig: true,
				timeoutAt: new Date(Date.now() + TIMEOUT_MS),
				githubTriggerId: trigger.id,
				webhookDeliveryId: input.deliveryId
			});
			if (!result) {
				errors.push({ triggerId: trigger.id, error: 'Project not found' });
				continue;
			}
			runIds.push(result.runId);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			console.error('[github-triggers] run creation failed', {
				triggerId: trigger.id,
				projectId: trigger.projectId,
				deliveryId: input.deliveryId,
				error: message
			});
			errors.push({ triggerId: trigger.id, error: message });
		}
	}

	return { runIds, errors };
}

/**
 * Pipeline complet d'une livraison webhook (§4.2) : signature → idempotence → parsing →
 * matching des triggers → création des runs → mise à jour de la livraison.
 */
export async function handleGithubWebhook(
	input: WebhookHandleInput
): Promise<WebhookHandleResult> {
	const { deliveryId, event: eventName, signature } = input.headers;

	// 1. Signature : sans org identifiable ni secret configuré, la requête n'est pas
	// authentifiable — on refuse sans laisser de trace exploitable (§7.2, §8.1).
	if (!deliveryId || !eventName || !signature || !input.organizationId) {
		console.warn('[github-triggers] webhook rejected: missing headers or orgId', {
			deliveryId: deliveryId || null,
			eventName: eventName || null,
			organizationId: input.organizationId
		});
		return { status: 'invalid_signature' };
	}

	const secret = await getWebhookSecret(input.organizationId);
	if (!secret || !(await verifySignature(input.rawBody, signature, secret))) {
		console.warn('[github-triggers] webhook signature verification failed', {
			deliveryId,
			eventName,
			organizationId: input.organizationId
		});
		return { status: 'invalid_signature' };
	}

	const parsedJson = parseJsonPayload(input.rawBody);
	const payload = parsedJson.ok ? parsedJson.payload : null;

	// 2. Idempotence : l'unicité de `githubDeliveryId` bloque les rejeux de GitHub (§7.6).
	let delivery: { id: string };
	try {
		delivery = await prisma.githubWebhookDelivery.create({
			data: {
				githubDeliveryId: deliveryId,
				eventName,
				action: readPayloadAction(payload),
				organizationId: input.organizationId,
				payload: asJsonPayload(
					parsedJson.ok
						? parsedJson.payload
						: { _unparsable: input.rawBody.slice(0, UNPARSABLE_PAYLOAD_EXCERPT_LENGTH) }
				),
				status: 'PROCESSING'
			},
			select: { id: true }
		});
	} catch (e) {
		if (isPrismaUniqueConstraintError(e)) {
			return { status: 'duplicate', deliveryId };
		}
		throw e;
	}

	try {
		if (!parsedJson.ok) {
			const error = 'Payload is not valid JSON';
			await markFailed(delivery.id, error);
			console.error('[github-triggers] webhook payload is not valid JSON', { deliveryId });
			return { status: 'failed', deliveryId, error };
		}

		// 3. L'org est déjà authentifiée par la signature ; on revalide son existence au cas
		// où elle aurait été supprimée entre-temps.
		const organization = await prisma.organization.findUnique({
			where: { id: input.organizationId },
			select: { id: true }
		});
		if (!organization) {
			await markSkipped(delivery.id, 'organization_not_found');
			console.warn('[github-triggers] organization not found', {
				deliveryId,
				organizationId: input.organizationId
			});
			return { status: 'skipped', deliveryId, reason: 'organization_not_found' };
		}

		// 4. Parsing de l'évènement.
		const parsedEvent = parseGithubEvent(eventName, payload);
		if (!parsedEvent.ok) {
			await markFailed(delivery.id, parsedEvent.error);
			console.error('[github-triggers] webhook payload parse error', {
				deliveryId,
				eventName,
				error: parsedEvent.error
			});
			return { status: 'failed', deliveryId, error: parsedEvent.error };
		}

		const repo = eventRepo(parsedEvent.event);
		if (!repo) {
			await markSkipped(delivery.id, 'unhandled_event');
			return { status: 'skipped', deliveryId, reason: 'unhandled_event' };
		}

		// 5. Un payload venant du dépôt A ne peut déclencher que les triggers du projet A (§7.3).
		const project = await prisma.project.findFirst({
			where: { organizationId: organization.id, githubRepoId: String(repo.id) },
			select: { id: true }
		});
		if (!project) {
			await markSkipped(delivery.id, 'no_project_for_repo');
			return { status: 'skipped', deliveryId, reason: 'no_project_for_repo' };
		}

		const triggers = await prisma.githubTrigger.findMany({
			where: { projectId: project.id, organizationId: organization.id, enabled: true }
		});
		const matched = triggers.filter((trigger) => matchesTrigger(trigger, parsedEvent.event));

		// 6. Création des runs.
		const { runIds, errors } = await createRunsForTriggers({
			triggers: matched,
			event: parsedEvent.event,
			deliveryId: delivery.id,
			defaultBranch: repo.default_branch
		});

		// 7. Clôture de la livraison.
		const errorMessage = errors.length > 0 ? JSON.stringify(errors) : null;
		await prisma.githubWebhookDelivery.update({
			where: { id: delivery.id },
			data: {
				processedAt: new Date(),
				status: errors.length > 0 ? 'FAILED' : 'COMPLETED',
				errorMessage
			}
		});

		if (errors.length > 0) {
			return { status: 'failed', deliveryId, error: errorMessage ?? 'Run creation failed' };
		}
		return { status: 'completed', deliveryId, runsCreated: runIds };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		console.error('[github-triggers] webhook processing failed', { deliveryId, error: message });
		await markFailed(delivery.id, message).catch(() => {});
		return { status: 'failed', deliveryId, error: message };
	}
}
