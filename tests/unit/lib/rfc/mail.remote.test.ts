import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	requireHeaders: vi.fn(),
	getGoogleAccessToken: vi.fn(),
	getGmailThread: vi.fn(),
	listGmailThreadsPage: vi.fn(),
	mapGmailThreadToMailThread: vi.fn(),
	normalizeGmailError: vi.fn(),
	mailThreadFindMany: vi.fn(),
	mailThreadUpsert: vi.fn(),
	mailSyncStateFindUnique: vi.fn(),
	mailSyncStateUpsert: vi.fn(),
	mailSyncStateUpdateMany: vi.fn(),
	listMailThreadsRefresh: vi.fn()
}));

function remoteCommand<T extends (...args: never[]) => unknown>(handler: T): T {
	const wrapped = vi.fn(handler) as unknown as T & { __: { type: 'command' } };
	wrapped.__ = { type: 'command' };
	return wrapped;
}

function remoteQuery<T extends (...args: never[]) => unknown>(
	handler: T
): (() => { refresh: () => Promise<void> }) & { __: { type: 'query' }; serverHandler: T } {
	const wrapped = vi.fn(() => ({
		refresh: mocks.listMailThreadsRefresh
	})) as unknown as (() => { refresh: () => Promise<void> }) & {
		__: { type: 'query' };
		serverHandler: T;
	};
	wrapped.__ = { type: 'query' };
	wrapped.serverHandler = handler;
	return wrapped;
}

vi.mock('$app/server', () => ({
	command: vi.fn((schemaOrHandler, maybeHandler) => remoteCommand(maybeHandler ?? schemaOrHandler)),
	query: vi.fn((schemaOrHandler, maybeHandler) => remoteQuery(maybeHandler ?? schemaOrHandler)),
	getRequestEvent: mocks.getRequestEvent
}));

vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));

vi.mock('$lib/server/utils', () => ({ requireHeaders: mocks.requireHeaders }));
vi.mock('$lib/server/gmail', () => ({
	getGoogleAccessToken: mocks.getGoogleAccessToken,
	getGmailThread: mocks.getGmailThread,
	listGmailThreadsPage: mocks.listGmailThreadsPage,
	mapGmailThreadToMailThread: mocks.mapGmailThreadToMailThread,
	normalizeGmailError: mocks.normalizeGmailError
}));
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		mailThread: {
			findMany: mocks.mailThreadFindMany,
			upsert: mocks.mailThreadUpsert
		},
		mailSyncState: {
			findUnique: mocks.mailSyncStateFindUnique,
			upsert: mocks.mailSyncStateUpsert,
			updateMany: mocks.mailSyncStateUpdateMany
		}
	}
}));

import { listMailThreads, syncNextMailPage } from '$lib/rfc/mail.remote';

const listMailThreadsServer = listMailThreads as typeof listMailThreads & {
	serverHandler: () => ReturnType<typeof listMailThreads>;
};

describe('mail.remote', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.requireHeaders.mockReturnValue(new Headers());
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'user1' } } });
		mocks.getGoogleAccessToken.mockResolvedValue({
			connected: true,
			needsReconnect: false,
			accessToken: 'google-token'
		});
	});

	it('does not report more mail when an empty completed sync exists', async () => {
		mocks.mailThreadFindMany.mockResolvedValue([]);
		mocks.mailSyncStateFindUnique.mockResolvedValue({
			nextPageToken: null,
			status: 'idle',
			error: null
		});

		const result = await listMailThreadsServer.serverHandler();

		expect(result).toMatchObject({
			connected: true,
			needsReconnect: false,
			threads: [],
			hasMore: false,
			syncing: false,
			error: null
		});
	});

	it('maps retryable sync failures to a 503 and does not refresh', async () => {
		const gmailError = Object.assign(new Error('Gmail request failed: 429'), { status: 429 });
		mocks.mailSyncStateUpsert.mockResolvedValue({
			userId: 'user1',
			query: 'newer_than:30d',
			nextPageToken: null,
			status: 'idle'
		});
		mocks.listGmailThreadsPage.mockRejectedValue(gmailError);
		mocks.normalizeGmailError.mockReturnValue({
			kind: 'retryable',
			message: 'Gmail is rate limiting requests.'
		});
		mocks.mailSyncStateUpdateMany.mockResolvedValue({ count: 1 });

		await expect(syncNextMailPage()).rejects.toMatchObject({
			status: 503,
			message: 'Gmail is rate limiting requests.'
		});

		expect(mocks.listMailThreadsRefresh).not.toHaveBeenCalled();
	});

	it('rethrows unbranded structural sync errors without mapping them', async () => {
		const internalError = {
			kind: 'retryable',
			message: 'internal details'
		};
		mocks.mailSyncStateUpsert.mockResolvedValue({
			userId: 'user1',
			query: 'newer_than:30d',
			nextPageToken: null,
			status: 'idle'
		});
		mocks.listGmailThreadsPage.mockResolvedValue({
			threads: [{ id: 'gmail-thread-1' }]
		});
		mocks.getGmailThread.mockResolvedValue({
			id: 'gmail-thread-1',
			messages: [{ id: 'message-1', threadId: 'gmail-thread-1' }]
		});
		mocks.mapGmailThreadToMailThread.mockReturnValue({
			userId: 'user1',
			gmailThreadId: 'gmail-thread-1',
			historyId: '11',
			subject: 'Subject',
			snippet: 'Snippet',
			participants: [],
			fromEmail: null,
			fromName: null,
			toEmails: [],
			labelIds: ['INBOX'],
			lastMessageAt: new Date('2026-06-13T10:00:00Z'),
			messageCount: 1,
			unread: false,
			starred: false
		});
		mocks.mailThreadUpsert.mockRejectedValue(internalError);
		mocks.mailSyncStateUpdateMany.mockResolvedValue({ count: 1 });

		await expect(syncNextMailPage()).rejects.toBe(internalError);

		expect(mocks.listMailThreadsRefresh).not.toHaveBeenCalled();
	});

	it('returns sync counts without exposing the gmail page cursor', async () => {
		mocks.mailSyncStateUpsert.mockResolvedValue({
			userId: 'user1',
			query: 'newer_than:30d',
			nextPageToken: null,
			status: 'idle'
		});
		mocks.listGmailThreadsPage.mockResolvedValue({
			threads: [],
			nextPageToken: 'secret-page-token'
		});
		mocks.mailSyncStateUpdateMany.mockResolvedValue({ count: 1 });

		const result = await syncNextMailPage();

		expect(result).toEqual({
			connected: true,
			needsReconnect: false,
			synced: 0,
			hasMore: true
		});
		expect(mocks.listMailThreadsRefresh).toHaveBeenCalledTimes(1);
	});
});
