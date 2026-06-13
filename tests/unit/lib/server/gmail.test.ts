import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GMAIL_READONLY_SCOPE } from '$lib/constants/mail';

const { getAccessToken } = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock('$lib/server/auth', () => ({ auth: { api: { getAccessToken } } }));

import {
	getGoogleAccessToken,
	mapGmailThreadToMailThread,
	normalizeGmailError,
	extractBestMessageBody,
	type GmailThread
} from '$lib/server/gmail';

const gmailThread: GmailThread = {
	id: 'thread-1',
	historyId: '101',
	snippet: 'Latest reply snippet',
	messages: [
		{
			id: 'msg-1',
			threadId: 'thread-1',
			labelIds: ['INBOX', 'UNREAD'],
			snippet: 'First',
			internalDate: '1781300000000',
			payload: {
				headers: [
					{ name: 'From', value: 'Marie Example <marie@example.com>' },
					{ name: 'To', value: 'You <you@example.com>' },
					{ name: 'Subject', value: 'Project kickoff' },
					{ name: 'Date', value: 'Fri, 12 Jun 2026 10:00:00 +0000' }
				]
			}
		},
		{
			id: 'msg-2',
			threadId: 'thread-1',
			labelIds: ['SENT'],
			snippet: 'Second',
			internalDate: '1781350000000',
			payload: {
				headers: [
					{ name: 'From', value: 'You <you@example.com>' },
					{ name: 'To', value: 'Marie Example <marie@example.com>' },
					{ name: 'Subject', value: 'Re: Project kickoff' },
					{ name: 'Date', value: 'Fri, 12 Jun 2026 12:00:00 +0000' }
				]
			}
		}
	]
};

describe('getGoogleAccessToken', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns a connected token when gmail scope is present', async () => {
		getAccessToken.mockResolvedValueOnce({
			accessToken: 'ya29.token',
			scopes: ['openid', GMAIL_READONLY_SCOPE]
		});

		await expect(getGoogleAccessToken(new Headers())).resolves.toEqual({
			connected: true,
			needsReconnect: false,
			accessToken: 'ya29.token',
			scopes: ['openid', GMAIL_READONLY_SCOPE]
		});
	});

	it('returns needsReconnect when gmail scope is missing', async () => {
		getAccessToken.mockResolvedValueOnce({ accessToken: 'ya29.token', scopes: ['openid'] });

		await expect(getGoogleAccessToken(new Headers())).resolves.toEqual({
			connected: true,
			needsReconnect: true,
			accessToken: null,
			scopes: ['openid']
		});
	});

	it('returns disconnected when better-auth throws', async () => {
		getAccessToken.mockRejectedValueOnce(new Error('Account not found'));

		await expect(getGoogleAccessToken(new Headers())).resolves.toEqual({
			connected: false,
			needsReconnect: false,
			accessToken: null,
			scopes: []
		});
	});
});

describe('mapGmailThreadToMailThread', () => {
	it('maps gmail metadata into a local index row', () => {
		expect(mapGmailThreadToMailThread('user-1', gmailThread)).toEqual({
			userId: 'user-1',
			gmailThreadId: 'thread-1',
			historyId: '101',
			subject: 'Project kickoff',
			snippet: 'Latest reply snippet',
			participants: [
				{ email: 'marie@example.com', name: 'Marie Example' },
				{ email: 'you@example.com', name: 'You' }
			],
			fromEmail: 'you@example.com',
			fromName: 'You',
			toEmails: ['marie@example.com'],
			labelIds: ['INBOX', 'SENT', 'UNREAD'],
			lastMessageAt: new Date(1781350000000),
			messageCount: 2,
			unread: true,
			starred: false
		});
	});
});

describe('extractBestMessageBody', () => {
	it('decodes text/plain body data from a Gmail message payload', () => {
		const data = Buffer.from('Hello from Gmail').toString('base64url');

		expect(
			extractBestMessageBody({
				mimeType: 'text/plain',
				body: { data },
				headers: []
			})
		).toEqual({ html: null, text: 'Hello from Gmail' });
	});
});

describe('normalizeGmailError', () => {
	it('maps 401 to reconnect', () => {
		expect(normalizeGmailError({ status: 401 })).toEqual({
			kind: 'needs_reconnect',
			message: 'Reconnect Google to continue reading Gmail.'
		});
	});

	it('maps quota errors to retryable', () => {
		expect(normalizeGmailError({ status: 429 })).toEqual({
			kind: 'retryable',
			message: 'Gmail is rate limiting requests. Try again in a moment.'
		});
	});
});
