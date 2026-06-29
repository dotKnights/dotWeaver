import type { UserPokeConfig } from '@prisma/client';
import { prisma } from '$lib/server/prisma';
import {
	decryptProjectSecretValue,
	encryptProjectSecretValue
} from '$lib/server/project-agent-config/encryption';
import { askUserQuestionRequestSchema } from '$lib/schemas/run-interactions';
import { loginPokeLocalAccount, logoutPokeLocalAccount, sendPokeSdkMessage } from './sdk';

export type UserPokeConnector = Pick<UserPokeConfig, 'enabled' | 'lastNotifiedAt' | 'lastError'> & {
	connected: boolean;
};

export type UserPokeLoginState =
	| { status: 'idle'; loggedIn: false }
	| { status: 'pending'; loggedIn: false; userCode: string; loginUrl: string }
	| { status: 'connected'; loggedIn: true }
	| { status: 'failed'; loggedIn: false; error: string };

export class PokeConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PokeConfigError';
	}
}

function masked(
	row: Pick<UserPokeConfig, 'enabled' | 'lastNotifiedAt' | 'lastError'> | null
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

function shortLoginError(error: unknown): string {
	return shortError(error instanceof Error ? error.message : String(error));
}

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const loginStates = new Map<string, UserPokeLoginState>();
const loginGenerations = new Map<string, number>();
const loginInitialStates = new Map<string, Promise<UserPokeLoginState>>();

function loginGeneration(userId: string): number {
	return loginGenerations.get(userId) ?? 0;
}

function nextLoginGeneration(userId: string): number {
	const generation = loginGeneration(userId) + 1;
	loginGenerations.set(userId, generation);
	return generation;
}

function setLoginState(userId: string, state: UserPokeLoginState): UserPokeLoginState {
	loginStates.set(userId, state);
	return state;
}

export async function getUserPokeConfig(userId: string): Promise<UserPokeConnector> {
	const row = await prisma.userPokeConfig.findUnique({
		where: { userId },
		select: { enabled: true, lastNotifiedAt: true, lastError: true }
	});
	return masked(row);
}

async function upsertUserPokeCredential(
	userId: string,
	credential: string
): Promise<UserPokeConnector> {
	const row = await prisma.userPokeConfig.upsert({
		where: { userId },
		create: {
			userId,
			credentialEncrypted: encryptProjectSecretValue(credential),
			enabled: true,
			lastError: null
		},
		update: {
			credentialEncrypted: encryptProjectSecretValue(credential),
			enabled: true,
			lastError: null
		},
		select: { enabled: true, lastNotifiedAt: true, lastError: true }
	});
	return masked(row);
}

export async function getUserPokeLoginState(userId: string): Promise<UserPokeLoginState> {
	if ((await getUserPokeConfig(userId)).connected) return { status: 'connected', loggedIn: true };
	return loginStates.get(userId) ?? { status: 'idle', loggedIn: false };
}

export function cancelUserPokeLogin(userId: string): void {
	nextLoginGeneration(userId);
	loginStates.delete(userId);
	loginInitialStates.delete(userId);
}

export async function startUserPokeLogin(userId: string): Promise<UserPokeLoginState> {
	if ((await getUserPokeConfig(userId)).connected) return { status: 'connected', loggedIn: true };

	const existingInitialState = loginInitialStates.get(userId);
	if (existingInitialState) return await existingInitialState;

	const generation = nextLoginGeneration(userId);
	let settledInitialState = false;
	let resolveInitialState!: (state: UserPokeLoginState) => void;
	const initialState = new Promise<UserPokeLoginState>((resolve) => {
		resolveInitialState = resolve;
	});
	loginInitialStates.set(userId, initialState);
	setLoginState(userId, { status: 'idle', loggedIn: false });

	function resolveOnce(state: UserPokeLoginState) {
		if (settledInitialState) return;
		settledInitialState = true;
		resolveInitialState(state);
	}

	void (async () => {
		try {
			await logoutPokeLocalAccount();
			const result = await loginPokeLocalAccount({
				openBrowser: false,
				timeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
				onCode: (info) => {
					if (loginGeneration(userId) !== generation) return;
					const pendingState = setLoginState(userId, {
						status: 'pending',
						loggedIn: false,
						userCode: info.userCode,
						loginUrl: info.loginUrl
					});
					resolveOnce(pendingState);
				}
			});
			if (loginGeneration(userId) !== generation) return;
			await upsertUserPokeCredential(userId, result.token);
			await logoutPokeLocalAccount().catch(() => undefined);
			const connectedState = setLoginState(userId, { status: 'connected', loggedIn: true });
			resolveOnce(connectedState);
		} catch (error) {
			if (loginGeneration(userId) !== generation) return;
			const failedState = setLoginState(userId, {
				status: 'failed',
				loggedIn: false,
				error: shortLoginError(error)
			});
			resolveOnce(failedState);
		} finally {
			if (loginGeneration(userId) === generation) {
				loginInitialStates.delete(userId);
			}
		}
	})();

	return await initialState;
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
	cancelUserPokeLogin(userId);
	await prisma.userPokeConfig.deleteMany({ where: { userId } });
	return { connected: false, enabled: false, lastNotifiedAt: null, lastError: null };
}

function buildPokeQuestionMessage(input: {
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

export async function sendPokeQuestionNotification(input: {
	userId: string;
	runId: string;
	interactionId: string;
	projectLabel: string;
	request: unknown;
}): Promise<
	| { sent: true }
	| { sent: false; skipped: 'not_configured' | 'disabled' }
	| { sent: false; error: string }
> {
	const row = await prisma.userPokeConfig.findUnique({
		where: { userId: input.userId },
		select: { credentialEncrypted: true, enabled: true }
	});
	if (!row) return { sent: false, skipped: 'not_configured' };
	if (!row.enabled) return { sent: false, skipped: 'disabled' };

	const message = buildPokeQuestionMessage(input);
	try {
		await sendPokeSdkMessage(decryptProjectSecretValue(row.credentialEncrypted), message);
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
