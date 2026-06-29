import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { requireHeaders } from '$lib/server/utils';
import { getMailThreadSchema } from '$lib/schemas/mail';
import {
	getGoogleAccessToken,
	getGmailThread,
	mapGmailThreadToThreadView,
	normalizeGmailError
} from '$lib/server/integrations/gmail/client';
import {
	INDEXED_THREAD_LIMIT,
	getMailSyncState,
	isNormalizedGmailSyncError,
	listIndexedMailThreads,
	syncNextMailPage as syncNextMailPageForUser
} from '$lib/server/integrations/gmail/service';

export const getMailConnectionStatus = query(async () => {
	const headers = requireHeaders();
	const token = await getGoogleAccessToken(headers);
	return {
		connected: token.connected,
		needsReconnect: token.needsReconnect
	};
});

export const listMailThreads = query(async () => {
	const headers = requireHeaders();
	const token = await getGoogleAccessToken(headers);
	if (!token.connected || token.needsReconnect) {
		return {
			connected: token.connected,
			needsReconnect: token.needsReconnect,
			threads: [],
			hasMore: false,
			syncing: false,
			error: null
		};
	}

	const { locals } = getRequestEvent();
	const userId = locals.user?.id;
	if (!userId) error(401, 'Not authenticated');

	const [threads, syncState] = await Promise.all([
		listIndexedMailThreads(userId),
		getMailSyncState(userId)
	]);
	const indexLimitReached = threads.length >= INDEXED_THREAD_LIMIT;
	return {
		connected: true,
		needsReconnect: false,
		threads,
		hasMore:
			!indexLimitReached &&
			(syncState ? syncState.status === 'error' || Boolean(syncState.nextPageToken) : true),
		syncing: syncState?.status === 'syncing',
		error: syncState?.error ?? null
	};
});

export const syncNextMailPage = command(async () => {
	const headers = requireHeaders();
	const token = await getGoogleAccessToken(headers);
	if (!token.connected) return { connected: false, needsReconnect: false, synced: 0 };
	if (token.needsReconnect || !token.accessToken) {
		return { connected: true, needsReconnect: true, synced: 0 };
	}

	const { locals } = getRequestEvent();
	const userId = locals.user?.id;
	if (!userId) error(401, 'Not authenticated');

	let result: Awaited<ReturnType<typeof syncNextMailPageForUser>>;
	try {
		result = await syncNextMailPageForUser(userId, token.accessToken);
	} catch (e) {
		if (isNormalizedGmailSyncError(e)) {
			error(e.kind === 'needs_reconnect' ? 400 : 503, e.message);
		}
		throw e;
	}
	await listMailThreads().refresh();
	return {
		connected: true,
		needsReconnect: false,
		synced: result.synced,
		hasMore: result.hasMore
	};
});

export const getMailThread = query(getMailThreadSchema, async ({ gmailThreadId }) => {
	const headers = requireHeaders();
	const token = await getGoogleAccessToken(headers);
	if (!token.connected) error(400, 'Connect Google to read Gmail.');
	if (token.needsReconnect || !token.accessToken) error(400, 'Reconnect Google to read Gmail.');
	try {
		const thread = await getGmailThread(token.accessToken, gmailThreadId, 'full');
		return mapGmailThreadToThreadView(thread);
	} catch (e) {
		const normalized = normalizeGmailError(e);
		error(normalized.kind === 'needs_reconnect' ? 400 : 503, normalized.message);
	}
});
