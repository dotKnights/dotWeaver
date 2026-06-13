import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		mailThread: {
			findMany: vi.fn(),
			upsert: vi.fn()
		},
		mailSyncState: {
			upsert: vi.fn(),
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

import { DEFAULT_MAIL_QUERY } from '$lib/constants/mail';
import {
	getGmailThread,
	listGmailThreadsPage,
	mapGmailThreadToMailThread
} from '$lib/server/gmail';
import { listIndexedMailThreads, syncNextMailPage } from '$lib/server/mail-service';
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

	it('syncs one Gmail page and upserts each thread', async () => {
		vi.mocked(prisma.mailSyncState.upsert).mockResolvedValueOnce({
			userId: 'user-1',
			query: DEFAULT_MAIL_QUERY,
			nextPageToken: 'page-1',
			status: 'idle'
		} as never);
		vi.mocked(listGmailThreadsPage).mockResolvedValueOnce({
			threads: [{ id: 'gmail-thread-1' }],
			nextPageToken: 'page-2'
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

		await expect(syncNextMailPage('user-1', 'token')).resolves.toEqual({
			synced: 1,
			hasMore: true,
			nextPageToken: 'page-2'
		});

		expect(prisma.mailThread.upsert).toHaveBeenCalledWith({
			where: { userId_gmailThreadId: { userId: 'user-1', gmailThreadId: 'gmail-thread-1' } },
			create: expect.objectContaining({ userId: 'user-1', gmailThreadId: 'gmail-thread-1' }),
			update: expect.objectContaining({ subject: 'Subject', snippet: 'Snippet' })
		});
		expect(prisma.mailSyncState.update).toHaveBeenCalledWith({
			where: { userId: 'user-1' },
			data: expect.objectContaining({ nextPageToken: 'page-2', status: 'idle', error: null })
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

		await expect(syncNextMailPage('user-1', 'token')).resolves.toEqual({
			synced: 0,
			hasMore: false,
			nextPageToken: null
		});

		expect(mapGmailThreadToMailThread).not.toHaveBeenCalled();
		expect(prisma.mailThread.upsert).not.toHaveBeenCalled();
		expect(prisma.mailSyncState.update).toHaveBeenCalledWith({
			where: { userId: 'user-1' },
			data: expect.objectContaining({ nextPageToken: null, status: 'idle', error: null })
		});
	});
});
