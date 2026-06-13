import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GMAIL_READONLY_SCOPE } from '$lib/constants/mail';

const { getAccessToken } = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock('$lib/server/auth', () => ({ auth: { api: { getAccessToken } } }));

import {
	getGmailThread,
	getGoogleAccessToken,
	listGmailThreadsPage,
	mapGmailThreadToMailThread,
	mapGmailThreadToThreadView,
	normalizeGmailError,
	extractBestMessageBody,
	type GmailThread
} from '$lib/server/gmail';

afterEach(() => vi.unstubAllGlobals());

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

	it('returns disconnected when better-auth throws an account-not-found error', async () => {
		getAccessToken.mockRejectedValueOnce(
			Object.assign(new Error('Account not found'), {
				status: 'BAD_REQUEST',
				code: 'ACCOUNT_NOT_FOUND'
			})
		);

		await expect(getGoogleAccessToken(new Headers())).resolves.toEqual({
			connected: false,
			needsReconnect: false,
			accessToken: null,
			scopes: []
		});
	});

	it.each([
		Object.assign(new Error('Failed to get a valid access token'), {
			status: 'BAD_REQUEST',
			code: 'FAILED_TO_GET_ACCESS_TOKEN'
		}),
		Object.assign(new Error('refresh token expired'), {
			status: 'UNAUTHORIZED',
			code: 'invalid_grant'
		})
	])('returns needsReconnect when better-auth throws a token error', async (error) => {
		getAccessToken.mockRejectedValueOnce(error);

		await expect(getGoogleAccessToken(new Headers())).resolves.toEqual({
			connected: true,
			needsReconnect: true,
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

	it('uses a valid Date header when internalDate is missing or malformed', () => {
		const thread: GmailThread = {
			id: 'thread-2',
			historyId: '102',
			messages: [
				{
					id: 'msg-latest',
					threadId: 'thread-2',
					labelIds: ['SENT'],
					internalDate: 'not-a-number',
					payload: {
						headers: [
							{ name: 'From', value: 'You <you@example.com>' },
							{ name: 'To', value: 'Marie Example <marie@example.com>' },
							{ name: 'Subject', value: 'Re: Timeline' },
							{ name: 'Date', value: 'Sat, 13 Jun 2026 10:15:00 +0000' }
						]
					}
				},
				{
					id: 'msg-older',
					threadId: 'thread-2',
					labelIds: ['INBOX'],
					internalDate: '1000',
					payload: {
						headers: [
							{ name: 'From', value: 'Marie Example <marie@example.com>' },
							{ name: 'To', value: 'You <you@example.com>' },
							{ name: 'Subject', value: 'Timeline' },
							{ name: 'Date', value: 'Fri, 12 Jun 2026 10:00:00 +0000' }
						]
					}
				}
			]
		};

		expect(mapGmailThreadToMailThread('user-1', thread)).toMatchObject({
			subject: 'Timeline',
			fromEmail: 'you@example.com',
			fromName: 'You',
			toEmails: ['marie@example.com'],
			lastMessageAt: new Date('Sat, 13 Jun 2026 10:15:00 +0000')
		});
	});

	it('falls back to epoch when no message has a valid timestamp', () => {
		const thread: GmailThread = {
			id: 'thread-3',
			historyId: '103',
			messages: [
				{
					id: 'msg-invalid',
					threadId: 'thread-3',
					internalDate: 'not-a-number',
					payload: {
						headers: [
							{ name: 'From', value: 'Marie Example <marie@example.com>' },
							{ name: 'To', value: 'You <you@example.com>' },
							{ name: 'Subject', value: 'Fallback timestamp' },
							{ name: 'Date', value: 'not a date' }
						]
					}
				},
				{
					id: 'msg-missing',
					threadId: 'thread-3',
					payload: {
						headers: [
							{ name: 'From', value: 'You <you@example.com>' },
							{ name: 'To', value: 'Marie Example <marie@example.com>' },
							{ name: 'Subject', value: 'Re: Fallback timestamp' }
						]
					}
				}
			]
		};
		let mapped: ReturnType<typeof mapGmailThreadToMailThread> | undefined;

		expect(() => {
			mapped = mapGmailThreadToMailThread('user-1', thread);
		}).not.toThrow();
		expect(mapped).toMatchObject({
			lastMessageAt: new Date(0),
			fromEmail: 'you@example.com',
			toEmails: ['marie@example.com']
		});
	});
});

describe('mapGmailThreadToThreadView', () => {
	it('returns messages ordered for UI display', () => {
		const view = mapGmailThreadToThreadView(gmailThread);
		expect(view.gmailThreadId).toBe('thread-1');
		expect(view.subject).toBe('Project kickoff');
		expect(view.messages).toHaveLength(2);
		expect(view.messages[0]).toMatchObject({
			gmailMessageId: 'msg-1',
			fromEmail: 'marie@example.com',
			fromName: 'Marie Example'
		});
	});

	it('uses stable fallback ids for messages missing gmail ids', () => {
		const thread = {
			id: 'thread-missing-ids',
			messages: [
				{
					threadId: 'thread-missing-ids',
					internalDate: '2000',
					payload: { headers: [{ name: 'Subject', value: 'Missing ids' }] }
				},
				{
					threadId: 'thread-missing-ids',
					internalDate: '1000',
					payload: { headers: [{ name: 'Subject', value: 'Missing ids' }] }
				}
			]
		} as GmailThread;

		expect(
			mapGmailThreadToThreadView(thread).messages.map((message) => message.gmailMessageId)
		).toEqual(['thread-missing-ids:message:0', 'thread-missing-ids:message:1']);
	});

	it('returns null message dates when gmail metadata has no valid date', () => {
		const thread: GmailThread = {
			id: 'thread-invalid-date',
			messages: [
				{
					id: 'msg-invalid-date',
					threadId: 'thread-invalid-date',
					internalDate: 'not-a-number',
					payload: {
						headers: [
							{ name: 'Subject', value: 'Invalid date' },
							{ name: 'Date', value: 'not a date' }
						]
					}
				}
			]
		};

		expect(mapGmailThreadToThreadView(thread).messages[0]?.date).toBeNull();
	});

	it('maps plain text body without exposing html', () => {
		const textData = Buffer.from('Plain body for UI').toString('base64url');
		const htmlData = Buffer.from('<p>HTML body for later</p>').toString('base64url');
		const thread: GmailThread = {
			id: 'thread-body',
			messages: [
				{
					id: 'msg-body',
					threadId: 'thread-body',
					internalDate: '1781300000000',
					payload: {
						mimeType: 'multipart/alternative',
						headers: [{ name: 'Subject', value: 'Body mapping' }],
						parts: [
							{ mimeType: 'text/html', body: { data: htmlData }, headers: [] },
							{ mimeType: 'text/plain', body: { data: textData }, headers: [] }
						]
					}
				}
			]
		};

		const message = mapGmailThreadToThreadView(thread).messages[0];
		expect(message).toMatchObject({ text: 'Plain body for UI' });
		expect(message).not.toHaveProperty('html');
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

	it('extracts text and html bodies from nested multipart payloads', () => {
		const textData = Buffer.from('Nested plain body').toString('base64url');
		const htmlData = Buffer.from('<p>Nested html body</p>').toString('base64url');

		expect(
			extractBestMessageBody({
				mimeType: 'multipart/mixed',
				headers: [],
				parts: [
					{
						mimeType: 'multipart/alternative',
						headers: [],
						parts: [
							{ mimeType: 'text/html', body: { data: htmlData }, headers: [] },
							{ mimeType: 'text/plain', body: { data: textData }, headers: [] }
						]
					}
				]
			})
		).toEqual({ html: '<p>Nested html body</p>', text: 'Nested plain body' });
	});

	it('skips attachments that appear before the message body', () => {
		const namedAttachmentData = Buffer.from('Named attachment').toString('base64url');
		const dispositionAttachmentData = Buffer.from('Disposition attachment').toString('base64url');
		const bodyData = Buffer.from('Actual body').toString('base64url');

		expect(
			extractBestMessageBody({
				mimeType: 'multipart/mixed',
				headers: [],
				parts: [
					{
						mimeType: 'text/plain',
						filename: 'notes.txt',
						body: { data: namedAttachmentData },
						headers: []
					},
					{
						mimeType: 'text/plain',
						body: { data: dispositionAttachmentData },
						headers: [{ name: 'Content-Disposition', value: 'attachment; filename=notes.txt' }]
					},
					{
						mimeType: 'text/plain',
						body: { data: bodyData },
						headers: [{ name: 'Content-Disposition', value: 'inline' }]
					}
				]
			})
		).toEqual({ html: null, text: 'Actual body' });
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

	it('maps Gmail 403 rate limit reasons to retryable', () => {
		expect(
			normalizeGmailError({
				status: 403,
				details: { error: { errors: [{ reason: 'rateLimitExceeded' }] } }
			})
		).toEqual({
			kind: 'retryable',
			message: 'Gmail is rate limiting requests. Try again in a moment.'
		});
	});

	it('maps Gmail 403 insufficientPermissions to reconnect', () => {
		expect(
			normalizeGmailError({
				status: 403,
				details: { error: { errors: [{ reason: 'insufficientPermissions' }] } }
			})
		).toEqual({
			kind: 'needs_reconnect',
			message: 'Reconnect Google to continue reading Gmail.'
		});
	});

	it('maps Gmail 403 domainPolicy reasons to unavailable', () => {
		expect(
			normalizeGmailError({
				status: 403,
				details: { error: { errors: [{ reason: 'domainPolicy' }] } }
			})
		).toEqual({
			kind: 'unavailable',
			message: 'Gmail access is unavailable for this Google account.'
		});
	});
});

describe('listGmailThreadsPage', () => {
	it('requests a Gmail threads page with query params', async () => {
		const body = { threads: [{ id: 'thread-1' }], nextPageToken: 'next' };
		const fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetch);

		await expect(
			listGmailThreadsPage('token', {
				query: 'newer_than:90d (in:inbox OR in:sent)',
				maxResults: 10,
				pageToken: 'page-2'
			})
		).resolves.toEqual(body);
		const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
		expect(`${url.origin}${url.pathname}`).toBe(
			'https://gmail.googleapis.com/gmail/v1/users/me/threads'
		);
		expect(url.searchParams.get('q')).toBe('newer_than:90d (in:inbox OR in:sent)');
		expect(url.searchParams.get('maxResults')).toBe('10');
		expect(url.searchParams.get('pageToken')).toBe('page-2');
		expect(init.headers).toEqual({
			Authorization: 'Bearer token',
			Accept: 'application/json'
		});
	});

	it('attaches Gmail error details to failed requests', async () => {
		const details = {
			error: {
				code: 403,
				message: 'Forbidden',
				errors: [{ reason: 'domainPolicy' }]
			}
		};
		const fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(details), {
				status: 403,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetch);

		await expect(listGmailThreadsPage('token', { query: 'in:inbox' })).rejects.toMatchObject({
			status: 403,
			details
		});
	});
});

describe('getGmailThread', () => {
	it('requests metadata headers for metadata format', async () => {
		const body: GmailThread = { id: 'thread-1', historyId: '101', messages: [] };
		const fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetch);

		await expect(getGmailThread('token', 'thread-1', 'metadata')).resolves.toEqual(body);
		const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
		expect(`${url.origin}${url.pathname}`).toBe(
			'https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1'
		);
		expect(url.searchParams.get('format')).toBe('metadata');
		expect(url.searchParams.getAll('metadataHeaders')).toEqual(['From', 'To', 'Subject', 'Date']);
		expect(init.headers).toEqual({
			Authorization: 'Bearer token',
			Accept: 'application/json'
		});
	});
});
