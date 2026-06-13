import { Buffer } from 'node:buffer';
import { GMAIL_READONLY_SCOPE } from '$lib/constants/mail';
import { auth } from '$lib/server/auth';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

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
	id: string;
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
	} catch {
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
	const sortedMessages = [...messages].sort(
		(a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0)
	);
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

export function extractBestMessageBody(payload: GmailPayload | undefined): {
	text: string | null;
	html: string | null;
} {
	if (!payload) return { text: null, html: null };

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

	if (status === 403 || status === 429) {
		return {
			kind: 'retryable',
			message: 'Gmail is rate limiting requests. Try again in a moment.'
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
		throw Object.assign(new Error(`Gmail request failed: ${res.status}`), { status: res.status });
	}

	return res;
}

function headerValue(message: GmailMessage | undefined, name: string): string | null {
	return (
		message?.payload?.headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())
			?.value ?? null
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

function getMessageDate(message: GmailMessage | undefined): Date {
	const internalDate = Number(message?.internalDate);
	if (Number.isFinite(internalDate) && internalDate > 0) return new Date(internalDate);

	const dateHeader = headerValue(message, 'Date');
	const date = dateHeader ? new Date(dateHeader) : null;
	if (date && !Number.isNaN(date.getTime())) return date;

	return new Date(0);
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
