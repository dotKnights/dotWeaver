import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	requireHeaders: vi.fn(),
	getGoogleAccessToken: vi.fn(),
	getGmailThread: vi.fn(),
	normalizeGmailError: vi.fn(),
	getMailSyncState: vi.fn(),
	listIndexedMailThreads: vi.fn(),
	syncNextMailPageForUser: vi.fn(),
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
	normalizeGmailError: mocks.normalizeGmailError
}));
vi.mock('$lib/server/mail-service', () => ({
	getMailSyncState: mocks.getMailSyncState,
	listIndexedMailThreads: mocks.listIndexedMailThreads,
	syncNextMailPage: mocks.syncNextMailPageForUser
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
		mocks.listIndexedMailThreads.mockResolvedValue([]);
		mocks.getMailSyncState.mockResolvedValue({ nextPageToken: null, status: 'idle', error: null });

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
		mocks.syncNextMailPageForUser.mockRejectedValue({
			kind: 'retryable',
			message: 'Gmail is rate limiting requests.'
		});

		await expect(syncNextMailPage()).rejects.toMatchObject({
			status: 503,
			message: 'Gmail is rate limiting requests.'
		});

		expect(mocks.listMailThreadsRefresh).not.toHaveBeenCalled();
	});

	it('returns sync counts without exposing the gmail page cursor', async () => {
		mocks.syncNextMailPageForUser.mockResolvedValue({
			synced: 3,
			hasMore: true,
			nextPageToken: 'secret-page-token'
		});

		const result = await syncNextMailPage();

		expect(result).toEqual({
			connected: true,
			needsReconnect: false,
			synced: 3,
			hasMore: true
		});
		expect(mocks.listMailThreadsRefresh).toHaveBeenCalledTimes(1);
	});
});
