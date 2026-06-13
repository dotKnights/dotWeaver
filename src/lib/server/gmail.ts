import { Buffer } from 'node:buffer';
import { GMAIL_READONLY_SCOPE } from '$lib/constants/mail';
import { auth } from '$lib/server/auth';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const RETRYABLE_GMAIL_403_REASONS = new Set([
	'rateLimitExceeded',
	'userRateLimitExceeded',
	'dailyLimitExceeded',
	'quotaExceeded'
]);
const GMAIL_RECONNECT_REASONS = new Set(['insufficientPermissions']);
const BETTER_AUTH_RECONNECT_CODES = new Set([
	'FAILED_TO_GET_ACCESS_TOKEN',
	'FAILED_TO_REFRESH_ACCESS_TOKEN',
	'REFRESH_TOKEN_NOT_FOUND',
	'INVALID_GRANT',
	'UNAUTHORIZED'
]);

export type GmailHeader = { name: string; value: string };
export type GmailBody = { data?: string; size?: number };
export type GmailPayload = {
	mimeType?: string;
	filename?: string;
	headers?: GmailHeader[];
	body?: GmailBody;
	parts?: GmailPayload[];
};
export type GmailMessage = {
	id?: string;
	threadId: string;
	labelIds?: string[];
	snippet?: string;
	internalDate?: string;
	payload?: GmailPayload;
};
export type GmailThread = {
	id: string;
	historyId?: string;
	snippet?: string;
	messages?: GmailMessage[];
};
export type GmailThreadListResponse = {
	threads?: Array<{ id: string; threadId?: string }>;
	nextPageToken?: string;
	resultSizeEstimate?: number;
};
export type GoogleTokenState =
	| { connected: true; needsReconnect: false; accessToken: string; scopes: string[] }
	| { connected: true; needsReconnect: true; accessToken: null; scopes: string[] }
	| { connected: false; needsReconnect: false; accessToken: null; scopes: [] };
export type NormalizedGmailError = {
	kind: 'needs_reconnect' | 'retryable' | 'unavailable';
	message: string;
};
export type MailThreadIndexInput = {
	userId: string;
	gmailThreadId: string;
	historyId: string | null;
	subject: string;
	snippet: string;
	participants: Array<{ email: string; name: string | null }>;
	fromEmail: string | null;
	fromName: string | null;
	toEmails: string[];
	labelIds: string[];
	lastMessageAt: Date;
	messageCount: number;
	unread: boolean;
	starred: boolean;
};
export type MailMessageView = {
	gmailMessageId: string;
	fromEmail: string | null;
	fromName: string | null;
	toEmails: string[];
	date: Date | null;
	snippet: string;
	text: string | null;
};
export type MailThreadView = {
	gmailThreadId: string;
	subject: string;
	messages: MailMessageView[];
};

type BetterAuthTokenResponse = {
	accessToken?: string | null;
	scopes?: string[] | string | null;
};

export async function getGoogleAccessToken(headers: Headers): Promise<GoogleTokenState> {
	try {
		const res = (await auth.api.getAccessToken({
			body: { providerId: 'google' },
			headers
		})) as BetterAuthTokenResponse | null;
		const scopes = normalizeScopes(res?.scopes);

		if (!res?.accessToken) {
			return { connected: false, needsReconnect: false, accessToken: null, scopes: [] };
		}

		if (!scopes.includes(GMAIL_READONLY_SCOPE)) {
			return { connected: true, needsReconnect: true, accessToken: null, scopes };
		}

		return { connected: true, needsReconnect: false, accessToken: res.accessToken, scopes };
	} catch (error) {
		if (isGoogleTokenReconnectError(error)) {
			return { connected: true, needsReconnect: true, accessToken: null, scopes: [] };
		}

		return { connected: false, needsReconnect: false, accessToken: null, scopes: [] };
	}
}

export async function listGmailThreadsPage(
	token: string,
	options: { pageToken?: string | null; query: string; maxResults?: number }
): Promise<GmailThreadListResponse> {
	const url = new URL(`${GMAIL_API}/threads`);
	url.searchParams.set('q', options.query);
	url.searchParams.set('maxResults', String(options.maxResults ?? 25));
	if (options.pageToken) url.searchParams.set('pageToken', options.pageToken);

	const res = await gmailFetch(token, url);
	return (await res.json()) as GmailThreadListResponse;
}

export async function getGmailThread(
	token: string,
	gmailThreadId: string,
	format: 'metadata' | 'full' = 'full'
): Promise<GmailThread> {
	const url = new URL(`${GMAIL_API}/threads/${encodeURIComponent(gmailThreadId)}`);
	url.searchParams.set('format', format);

	if (format === 'metadata') {
		for (const header of ['From', 'To', 'Subject', 'Date']) {
			url.searchParams.append('metadataHeaders', header);
		}
	}

	const res = await gmailFetch(token, url);
	return (await res.json()) as GmailThread;
}

export function mapGmailThreadToMailThread(
	userId: string,
	thread: GmailThread
): MailThreadIndexInput {
	const messages = thread.messages ?? [];
	const sortedMessages = [...messages].sort((a, b) => messageTimestamp(a) - messageTimestamp(b));
	const first = sortedMessages[0];
	const last = sortedMessages.at(-1);
	const from = parseAddress(headerValue(last, 'From') ?? '');
	const labelIds = unique(messages.flatMap((message) => message.labelIds ?? [])).sort((a, b) =>
		a.localeCompare(b)
	);

	return {
		userId,
		gmailThreadId: thread.id,
		historyId: thread.historyId ?? null,
		subject: normalizeSubject(headerValue(first, 'Subject') ?? headerValue(last, 'Subject') ?? ''),
		snippet: thread.snippet ?? last?.snippet ?? '',
		participants: collectParticipants(messages),
		fromEmail: from.email,
		fromName: from.name,
		toEmails: parseAddressList(headerValue(last, 'To') ?? '').map((address) => address.email),
		labelIds,
		lastMessageAt: getMessageDate(last),
		messageCount: messages.length,
		unread: labelIds.includes('UNREAD'),
		starred: labelIds.includes('STARRED')
	};
}

export function mapGmailThreadToThreadView(thread: GmailThread): MailThreadView {
	const messages = [...(thread.messages ?? [])].sort(
		(a, b) => messageTimestamp(a) - messageTimestamp(b)
	);
	const subject = normalizeSubject(headerValue(messages[0], 'Subject') ?? '(no subject)');

	return {
		gmailThreadId: thread.id,
		subject,
		messages: messages.map((message, index) => {
			const from = parseAddress(headerValue(message, 'From') ?? '');
			const body = extractBestMessageBody(message.payload);

			return {
				gmailMessageId: message.id ?? `${thread.id}:message:${index}`,
				fromEmail: from.email,
				fromName: from.name,
				toEmails: parseAddressList(headerValue(message, 'To') ?? '').map(
					(address) => address.email
				),
				date: getMessageViewDate(message),
				snippet: message.snippet ?? '',
				text: body.text
			};
		})
	};
}

export function extractBestMessageBody(payload: GmailPayload | undefined): {
	text: string | null;
	html: string | null;
} {
	if (!payload) return { text: null, html: null };
	if (isAttachmentPart(payload)) return { text: null, html: null };

	if (payload.mimeType === 'text/plain' && payload.body?.data) {
		return { text: decodeGmailData(payload.body.data), html: null };
	}

	if (payload.mimeType === 'text/html' && payload.body?.data) {
		return { text: null, html: decodeGmailData(payload.body.data) };
	}

	let text: string | null = null;
	let html: string | null = null;

	for (const part of payload.parts ?? []) {
		const extracted = extractBestMessageBody(part);
		text ??= extracted.text;
		html ??= extracted.html;
		if (text && html) break;
	}

	return { text, html };
}

export function normalizeGmailError(error: unknown): NormalizedGmailError {
	const status =
		typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 0;

	if (status === 401) {
		return {
			kind: 'needs_reconnect',
			message: 'Reconnect Google to continue reading Gmail.'
		};
	}

	if (status === 429) {
		return {
			kind: 'retryable',
			message: 'Gmail is rate limiting requests. Try again in a moment.'
		};
	}

	if (status === 403) {
		const reasons = gmailErrorReasons(error);
		if (reasons.some((reason) => GMAIL_RECONNECT_REASONS.has(reason))) {
			return {
				kind: 'needs_reconnect',
				message: 'Reconnect Google to continue reading Gmail.'
			};
		}

		if (reasons.some((reason) => RETRYABLE_GMAIL_403_REASONS.has(reason))) {
			return {
				kind: 'retryable',
				message: 'Gmail is rate limiting requests. Try again in a moment.'
			};
		}

		return {
			kind: 'unavailable',
			message: 'Gmail access is unavailable for this Google account.'
		};
	}

	return { kind: 'unavailable', message: 'Gmail is unavailable right now.' };
}

async function gmailFetch(token: string, url: URL): Promise<Response> {
	const res = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/json'
		}
	});

	if (!res.ok) {
		throw Object.assign(new Error(`Gmail request failed: ${res.status}`), {
			status: res.status,
			details: await responseDetails(res)
		});
	}

	return res;
}

function headerValue(message: GmailMessage | undefined, name: string): string | null {
	return payloadHeaderValue(message?.payload, name);
}

function payloadHeaderValue(payload: GmailPayload | undefined, name: string): string | null {
	return (
		payload?.headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ??
		null
	);
}

function normalizeSubject(subject: string): string {
	return subject.replace(/^((re|fw|fwd):\s*)+/i, '').trim() || '(no subject)';
}

function parseAddress(value: string): { email: string | null; name: string | null } {
	const trimmed = value.trim();
	const match = trimmed.match(/^(.*?)\s*<([^>]+)>$/);

	if (match) {
		return {
			email: match[2].trim(),
			name: normalizeAddressName(match[1])
		};
	}

	return { email: trimmed.includes('@') ? trimmed : null, name: null };
}

function parseAddressList(value: string): Array<{ email: string; name: string | null }> {
	return splitAddressList(value)
		.map((part) => parseAddress(part))
		.filter((address): address is { email: string; name: string | null } => Boolean(address.email));
}

function collectParticipants(
	messages: GmailMessage[]
): Array<{ email: string; name: string | null }> {
	const seen = new Map<string, { email: string; name: string | null }>();

	for (const message of messages) {
		for (const value of [headerValue(message, 'From'), headerValue(message, 'To')]) {
			for (const address of parseAddressList(value ?? '')) {
				seen.set(address.email, address);
			}
		}
	}

	return [...seen.values()];
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function decodeGmailData(data: string): string {
	return Buffer.from(data, 'base64url').toString('utf8');
}

function normalizeScopes(scopes: string[] | string | null | undefined): string[] {
	if (Array.isArray(scopes)) return scopes;
	if (typeof scopes === 'string') return scopes.split(/\s+/).filter(Boolean);
	return [];
}

function isGoogleTokenReconnectError(error: unknown): boolean {
	if (isMissingAccountError(error)) return false;

	const values = errorSignalValues(error);
	return values.some((value) => {
		const normalized = value.toUpperCase();
		return (
			BETTER_AUTH_RECONNECT_CODES.has(normalized) ||
			normalized.includes('FAILED_TO_GET_ACCESS_TOKEN') ||
			normalized.includes('FAILED TO GET A VALID ACCESS TOKEN') ||
			normalized.includes('FAILED_TO_REFRESH_ACCESS_TOKEN') ||
			normalized.includes('FAILED TO REFRESH ACCESS TOKEN') ||
			normalized.includes('REFRESH TOKEN') ||
			normalized.includes('INVALID_GRANT') ||
			normalized.includes('UNAUTHORIZED') ||
			normalized.includes('INSUFFICIENT') ||
			normalized.includes('SCOPE') ||
			normalized.includes('TOKEN EXPIRED')
		);
	});
}

function isMissingAccountError(error: unknown): boolean {
	return errorSignalValues(error).some((value) => {
		const normalized = value.toUpperCase();
		return normalized === 'ACCOUNT_NOT_FOUND' || normalized.includes('ACCOUNT NOT FOUND');
	});
}

function errorSignalValues(error: unknown): string[] {
	const values: string[] = [];

	if (typeof error === 'string') values.push(error);
	if (error instanceof Error) {
		values.push(error.name, error.message);
	}

	for (const key of [
		'code',
		'status',
		'statusCode',
		'error',
		'error_description',
		'errorDescription',
		'message'
	]) {
		const value = objectValue(error, key);
		if (typeof value === 'string' || typeof value === 'number') values.push(String(value));
	}

	return values.filter(Boolean);
}

function getMessageDate(message: GmailMessage | undefined): Date {
	return new Date(messageTimestamp(message));
}

function getMessageViewDate(message: GmailMessage | undefined): Date | null {
	const timestamp = validMessageTimestamp(message);
	return timestamp === null ? null : new Date(timestamp);
}

function messageTimestamp(message: GmailMessage | undefined): number {
	return validMessageTimestamp(message) ?? 0;
}

function validMessageTimestamp(message: GmailMessage | undefined): number | null {
	const internalDate = message?.internalDate?.trim();
	if (internalDate) {
		const timestamp = Number(internalDate);
		if (Number.isFinite(timestamp)) return timestamp;
	}

	const dateHeader = headerValue(message, 'Date');
	const dateTimestamp = dateHeader ? Date.parse(dateHeader) : NaN;
	if (Number.isFinite(dateTimestamp)) return dateTimestamp;

	return null;
}

function isAttachmentPart(payload: GmailPayload): boolean {
	if (payload.filename?.trim()) return true;

	const contentDisposition = payloadHeaderValue(payload, 'Content-Disposition');
	return contentDisposition?.trim().toLowerCase().startsWith('attachment') ?? false;
}

function gmailErrorReasons(error: unknown): string[] {
	const details = objectValue(error, 'details');
	const gmailError = objectValue(details, 'error') ?? objectValue(error, 'error');
	const errors = objectValue(gmailError, 'errors');
	const reasons: string[] = [];

	if (Array.isArray(errors)) {
		for (const item of errors) {
			const reason = objectValue(item, 'reason');
			if (typeof reason === 'string') reasons.push(reason);
		}
	}

	const reason = objectValue(gmailError, 'reason');
	if (typeof reason === 'string') reasons.push(reason);

	return reasons;
}

function objectValue(value: unknown, key: string): unknown {
	if (typeof value !== 'object' || value === null || !(key in value)) return null;
	return (value as Record<string, unknown>)[key];
}

async function responseDetails(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

function normalizeAddressName(value: string): string | null {
	const trimmed = value.trim().replace(/^"|"$/g, '').trim();
	return trimmed || null;
}

function splitAddressList(value: string): string[] {
	const addresses: string[] = [];
	let current = '';
	let inQuotes = false;
	let angleDepth = 0;

	for (const char of value) {
		if (char === '"') inQuotes = !inQuotes;
		if (!inQuotes && char === '<') angleDepth += 1;
		if (!inQuotes && char === '>' && angleDepth > 0) angleDepth -= 1;

		if (char === ',' && !inQuotes && angleDepth === 0) {
			addresses.push(current);
			current = '';
		} else {
			current += char;
		}
	}

	if (current) addresses.push(current);
	return addresses;
}
