import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		mailThread: {
			findMany: vi.fn(),
			upsert: vi.fn()
		},
		mailSyncState: {
			upsert: vi.fn(),
			updateMany: vi.fn(),
			update: vi.fn(),
			findUnique: vi.fn()
		}
	}
}));

vi.mock('$lib/server/gmail', () => ({
	listGmailThreadsPage: vi.fn(),
	getGmailThread: vi.fn(),
	mapGmailThreadToMailThread: vi.fn(),
	normalizeGmailError: vi.fn()
}));

import { DEFAULT_MAIL_QUERY, MAIL_WINDOW_DAYS } from '$lib/constants/mail';
import {
	getGmailThread,
	listGmailThreadsPage,
	mapGmailThreadToMailThread,
	normalizeGmailError
} from '$lib/server/gmail';
import {
	getMailSyncState,
	listIndexedMailThreads,
	syncNextMailPage
} from '$lib/server/mail-service';
import { prisma } from '$lib/server/prisma';

describe('mail-service', () => {
	beforeEach(() => vi.clearAllMocks());

	it('lists indexed threads newest first for one user', async () => {
		vi.mocked(prisma.mailThread.findMany).mockResolvedValueOnce([{ id: 'thread-row' }] as never);

		await expect(listIndexedMailThreads('user-1')).resolves.toEqual([{ id: 'thread-row' }]);
		expect(prisma.mailThread.findMany).toHaveBeenCalledWith({
			where: { userId: 'user-1' },
			orderBy: { lastMessageAt: 'desc' },
			take: 50
		});
	});

	it('gets the mail sync state for one user', async () => {
		vi.mocked(prisma.mailSyncState.findUnique).mockResolvedValueOnce({
			userId: 'user-1',
			query: DEFAULT_MAIL_QUERY,
			nextPageToken: null,
			status: 'idle'
		} as never);

		await expect(getMailSyncState('user-1')).resolves.toEqual({
			userId: 'user-1',
			query: DEFAULT_MAIL_QUERY,
			nextPageToken: null,
			status: 'idle'
		});
		expect(prisma.mailSyncState.findUnique).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
	});

	it('syncs one Gmail page and upserts each thread', async () => {
		const gmailThread = {
			id: 'gmail-thread-1',
			messages: [{ id: 'message-1', threadId: 'gmail-thread-1' }]
		};

		vi.mocked(prisma.mailSyncState.upsert).mockResolvedValueOnce({
			userId: 'user-1',
			query: DEFAULT_MAIL_QUERY,
			nextPageToken: 'page-1',
			status: 'idle'
		} as never);
		vi.mocked(prisma.mailSyncState.updateMany).mockResolvedValueOnce({ count: 1 } as never);
		vi.mocked(listGmailThreadsPage).mockResolvedValueOnce({
			threads: [{ id: 'gmail-thread-1' }],
			nextPageToken: 'page-2'
		});
		vi.mocked(getGmailThread).mockResolvedValueOnce(gmailThread);
		vi.mocked(mapGmailThreadToMailThread).mockReturnValueOnce({
			userId: 'user-1',
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

		await expect(syncNextMailPage('user-1', 'token')).resolves.toEqual({
			synced: 1,
			hasMore: true,
			nextPageToken: 'page-2'
		});

		expect(prisma.mailSyncState.upsert).toHaveBeenCalledWith({
			where: { userId: 'user-1' },
			create: {
				userId: 'user-1',
				query: DEFAULT_MAIL_QUERY,
				windowDays: MAIL_WINDOW_DAYS,
				status: 'syncing'
			},
			update: { status: 'syncing', error: null }
		});
		expect(listGmailThreadsPage).toHaveBeenCalledWith('token', {
			query: DEFAULT_MAIL_QUERY,
			pageToken: 'page-1',
			maxResults: 25
		});
		expect(getGmailThread).toHaveBeenCalledWith('token', 'gmail-thread-1', 'metadata');
		expect(mapGmailThreadToMailThread).toHaveBeenCalledWith('user-1', gmailThread);
		expect(prisma.mailThread.upsert).toHaveBeenCalledWith({
			where: { userId_gmailThreadId: { userId: 'user-1', gmailThreadId: 'gmail-thread-1' } },
			create: expect.objectContaining({ userId: 'user-1', gmailThreadId: 'gmail-thread-1' }),
			update: {
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
			}
		});
		expect(prisma.mailSyncState.updateMany).toHaveBeenCalledWith({
			where: { userId: 'user-1', nextPageToken: 'page-1' },
			data: expect.objectContaining({ nextPageToken: 'page-2', status: 'idle', error: null })
		});
		expect(prisma.mailSyncState.update).not.toHaveBeenCalled();
	});

	it('marks sync state as error and rethrows normalized Gmail errors', async () => {
		const gmailError = Object.assign(new Error('Gmail request failed: 429'), { status: 429 });
		vi.mocked(prisma.mailSyncState.upsert).mockResolvedValueOnce({
			userId: 'user-1',
			query: DEFAULT_MAIL_QUERY,
			nextPageToken: 'page-1',
			status: 'idle'
		} as never);
		vi.mocked(listGmailThreadsPage).mockRejectedValueOnce(gmailError);
		vi.mocked(normalizeGmailError).mockReturnValueOnce({
			kind: 'retryable',
			message: 'Gmail is rate limiting requests. Try again in a moment.'
		});

		await expect(syncNextMailPage('user-1', 'token')).rejects.toMatchObject({
			message: 'Gmail is rate limiting requests. Try again in a moment.',
			kind: 'retryable'
		});

		expect(normalizeGmailError).toHaveBeenCalledWith(gmailError);
		expect(prisma.mailSyncState.update).toHaveBeenCalledWith({
			where: { userId: 'user-1' },
			data: {
				status: 'error',
				error: 'Gmail is rate limiting requests. Try again in a moment.'
			}
		});
		expect(prisma.mailThread.upsert).not.toHaveBeenCalled();
	});

	it('marks internal sync failures without normalizing them as Gmail errors', async () => {
		const internalError = new Error('database write failed');
		vi.mocked(prisma.mailSyncState.upsert).mockResolvedValueOnce({
			userId: 'user-1',
			query: DEFAULT_MAIL_QUERY,
			nextPageToken: 'page-1',
			status: 'idle'
		} as never);
		vi.mocked(listGmailThreadsPage).mockResolvedValueOnce({
			threads: [{ id: 'gmail-thread-1' }]
		});
		vi.mocked(getGmailThread).mockResolvedValueOnce({
			id: 'gmail-thread-1',
			messages: [{ id: 'message-1', threadId: 'gmail-thread-1' }]
		});
		vi.mocked(mapGmailThreadToMailThread).mockReturnValueOnce({
			userId: 'user-1',
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
		vi.mocked(prisma.mailThread.upsert).mockRejectedValueOnce(internalError as never);

		await expect(syncNextMailPage('user-1', 'token')).rejects.toBe(internalError);

		expect(normalizeGmailError).not.toHaveBeenCalled();
		expect(prisma.mailSyncState.update).toHaveBeenCalledWith({
			where: { userId: 'user-1' },
			data: { status: 'error', error: 'Unable to sync mail right now.' }
		});
	});

	it('skips Gmail threads with no messages before mapping or persisting', async () => {
		vi.mocked(prisma.mailSyncState.upsert).mockResolvedValueOnce({
			userId: 'user-1',
			query: DEFAULT_MAIL_QUERY,
			nextPageToken: null,
			status: 'idle'
		} as never);
		vi.mocked(listGmailThreadsPage).mockResolvedValueOnce({
			threads: [{ id: 'empty-thread' }]
		});
		vi.mocked(getGmailThread).mockResolvedValueOnce({ id: 'empty-thread', messages: [] });
		vi.mocked(prisma.mailSyncState.updateMany).mockResolvedValueOnce({ count: 1 } as never);

		await expect(syncNextMailPage('user-1', 'token')).resolves.toEqual({
			synced: 0,
			hasMore: false,
			nextPageToken: null
		});

		expect(mapGmailThreadToMailThread).not.toHaveBeenCalled();
		expect(prisma.mailThread.upsert).not.toHaveBeenCalled();
		expect(prisma.mailSyncState.updateMany).toHaveBeenCalledWith({
			where: { userId: 'user-1', nextPageToken: null },
			data: expect.objectContaining({ nextPageToken: null, status: 'idle', error: null })
		});
	});

	it('does not fall back to overwriting sync state when final compare-and-set is stale', async () => {
		vi.mocked(prisma.mailSyncState.upsert).mockResolvedValueOnce({
			userId: 'user-1',
			query: DEFAULT_MAIL_QUERY,
			nextPageToken: 'page-1',
			status: 'idle'
		} as never);
		vi.mocked(listGmailThreadsPage).mockResolvedValueOnce({
			threads: [],
			nextPageToken: 'page-2'
		});
		vi.mocked(prisma.mailSyncState.updateMany).mockResolvedValueOnce({ count: 0 } as never);

		await expect(syncNextMailPage('user-1', 'token')).resolves.toEqual({
			synced: 0,
			hasMore: true,
			nextPageToken: 'page-2'
		});

		expect(prisma.mailSyncState.updateMany).toHaveBeenCalledWith({
			where: { userId: 'user-1', nextPageToken: 'page-1' },
			data: expect.objectContaining({ nextPageToken: 'page-2', status: 'idle', error: null })
		});
		expect(prisma.mailSyncState.update).not.toHaveBeenCalled();
	});
});
