import { prisma } from '$lib/server/prisma';
import {
	decryptProjectSecretValue,
	encryptProjectSecretValue
} from '$lib/server/project-agent-config-encryption';
import { askUserQuestionRequestSchema } from '$lib/schemas/run-interactions';

const POKE_API_MESSAGE_URL = 'https://poke.com/api/v1/inbound/api-message';

type FetchLike = typeof fetch;

export interface UserPokeConnector {
	connected: boolean;
	enabled: boolean;
	lastNotifiedAt: Date | null;
	lastError: string | null;
}

export class PokeConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PokeConfigError';
	}
}

function masked(
	row: {
		enabled: boolean;
		lastNotifiedAt: Date | null;
		lastError: string | null;
	} | null
): UserPokeConnector {
	if (!row) {
		return { connected: false, enabled: false, lastNotifiedAt: null, lastError: null };
	}
	return {
		connected: true,
		enabled: row.enabled,
		lastNotifiedAt: row.lastNotifiedAt,
		lastError: row.lastError
	};
}

function shortError(message: string): string {
	return message.trim().slice(0, 300) || 'Poke notification failed';
}

export async function getUserPokeConfig(userId: string): Promise<UserPokeConnector> {
	const row = await prisma.userPokeConfig.findUnique({
		where: { userId },
		select: { enabled: true, lastNotifiedAt: true, lastError: true }
	});
	return masked(row);
}

export async function upsertUserPokeApiKey(
	userId: string,
	apiKeyInput: string
): Promise<UserPokeConnector> {
	const apiKey = apiKeyInput.trim();
	if (!apiKey) throw new PokeConfigError('Poke API key is required');
	const row = await prisma.userPokeConfig.upsert({
		where: { userId },
		create: {
			userId,
			apiKeyEncrypted: encryptProjectSecretValue(apiKey),
			enabled: true,
			lastError: null
		},
		update: {
			apiKeyEncrypted: encryptProjectSecretValue(apiKey),
			enabled: true,
			lastError: null
		},
		select: { enabled: true, lastNotifiedAt: true, lastError: true }
	});
	return masked(row);
}

export async function setUserPokeEnabled(
	userId: string,
	enabled: boolean
): Promise<UserPokeConnector> {
	const result = await prisma.userPokeConfig.updateMany({
		where: { userId },
		data: { enabled }
	});
	if (result.count === 0) throw new PokeConfigError('Poke is not connected');
	return await getUserPokeConfig(userId);
}

export async function deleteUserPokeConfig(userId: string): Promise<UserPokeConnector> {
	await prisma.userPokeConfig.deleteMany({ where: { userId } });
	return { connected: false, enabled: false, lastNotifiedAt: null, lastError: null };
}

export function buildPokeQuestionMessage(input: {
	runId: string;
	interactionId: string;
	projectLabel: string;
	request: unknown;
}): string {
	const request = askUserQuestionRequestSchema.parse(input.request);
	const questionBlocks = request.questions.map((question, index) => {
		const options = question.options
			.map((option) => `- ${option.label}: ${option.description}`)
			.join('\n');
		return [
			`Question ${index + 1}: ${question.question}`,
			`Header: ${question.header}`,
			'Options:',
			options
		].join('\n');
	});
	return [
		'dotWeaver needs your input to continue a run.',
		'',
		`Run ID: ${input.runId}`,
		`Interaction ID: ${input.interactionId}`,
		`Project: ${input.projectLabel}`,
		'',
		...questionBlocks,
		'',
		'Reply by calling the dotWeaver MCP tool answer_pending_question with:',
		`- runId: ${input.runId}`,
		'- message: your natural-language answer'
	].join('\n');
}

async function pokeResponseError(response: Response): Promise<string | null> {
	if (!response.ok) return `Poke API returned ${response.status}`;
	try {
		const body = (await response.json()) as {
			success?: unknown;
			message?: unknown;
			error?: unknown;
		};
		if (body?.success === false) {
			return shortError(String(body.message ?? body.error ?? 'Poke API returned success=false'));
		}
	} catch {
		return null;
	}
	return null;
}

export async function sendPokeQuestionNotification(input: {
	userId: string;
	runId: string;
	interactionId: string;
	projectLabel: string;
	request: unknown;
	fetchImpl?: FetchLike;
}): Promise<
	| { sent: true }
	| { sent: false; skipped: 'not_configured' | 'disabled' }
	| { sent: false; error: string }
> {
	const row = await prisma.userPokeConfig.findUnique({
		where: { userId: input.userId },
		select: { apiKeyEncrypted: true, enabled: true }
	});
	if (!row) return { sent: false, skipped: 'not_configured' };
	if (!row.enabled) return { sent: false, skipped: 'disabled' };

	const fetchImpl = input.fetchImpl ?? fetch;
	const message = buildPokeQuestionMessage(input);
	try {
		const response = await fetchImpl(POKE_API_MESSAGE_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${decryptProjectSecretValue(row.apiKeyEncrypted)}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ message })
		});
		const error = await pokeResponseError(response);
		if (error) {
			await prisma.userPokeConfig.updateMany({
				where: { userId: input.userId },
				data: { lastError: error }
			});
			return { sent: false, error };
		}
		await prisma.userPokeConfig.updateMany({
			where: { userId: input.userId },
			data: { lastNotifiedAt: new Date(), lastError: null }
		});
		return { sent: true };
	} catch (error) {
		const message = shortError(error instanceof Error ? error.message : String(error));
		await prisma.userPokeConfig.updateMany({
			where: { userId: input.userId },
			data: { lastError: message }
		});
		return { sent: false, error: message };
	}
}
