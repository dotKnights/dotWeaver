# Gmail Mail V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v1 Gmail mail view: connect Google when needed, lazy-sync recent Inbox/Sent
threads, display a Gmail-like thread list, and fetch full thread content on demand.

**Architecture:** Keep Gmail tokens and Gmail API calls in server-only modules. Persist only a local
thread index in Prisma, expose type-safe remote functions for the UI, and use Runed's
`useIntersectionObserver` sentinel for infinite scroll. Thread bodies are fetched from Gmail only
when a conversation is opened.

**Tech Stack:** SvelteKit remote functions, Svelte 5 runes, Better Auth, Prisma/Postgres, Gmail REST
API, Runed, Vitest, Playwright, Bun.

---

## File Structure

- Modify: `package.json` and `bun.lock` - add `runed`.
- Modify: `prisma/schema.prisma` - add `MailSyncStatus`, `MailThread`, and `MailSyncState`.
- Create: `prisma/migrations/YYYYMMDDHHMMSS_add_gmail_mail_v1/migration.sql` - DB migration.
- Create: `src/lib/constants/mail.ts` - shared Gmail scope and product constants.
- Modify: `src/lib/server/auth.ts` - add Gmail readonly scope and encrypted OAuth token storage.
- Create: `src/lib/server/gmail.ts` - server-only Gmail API client, mapping, MIME parsing, and error
  normalization.
- Create: `src/lib/server/mail-service.ts` - Prisma-backed local index and idempotent page sync.
- Create: `src/lib/rfc/mail.remote.ts` - remote queries/commands used by Svelte.
- Create: `src/lib/schemas/mail.ts` - Zod schemas for remote arguments.
- Create: `src/routes/(app)/mail/+page.svelte` - Gmail-like mail UI with Runed sentinel.
- Modify: `src/routes/(app)/+layout.svelte` - add `Mail` navigation link.
- Create: `tests/unit/lib/server/gmail.test.ts` - Gmail mapping/error/MIME tests.
- Create: `tests/unit/lib/server/mail-service.test.ts` - sync/index service tests.
- Create: `tests/unit/lib/schemas/mail.test.ts` - schema tests.
- Create: `tests/e2e/mail.e2e.ts` - protected route/non-connected UI smoke test.

---

## Task 1: Add Runed and Gmail Data Model

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/YYYYMMDDHHMMSS_add_gmail_mail_v1/migration.sql`

- [ ] **Step 1: Install Runed**

Run:

```bash
bun add runed
```

Expected: `package.json` contains `runed` in `dependencies`, and `bun.lock` is updated.

- [ ] **Step 2: Add Prisma models**

In `prisma/schema.prisma`, add these relations to `model User`:

```prisma
  mailThreads   MailThread[]
  mailSyncState MailSyncState?
```

Then add these models near the existing app models:

```prisma
enum MailSyncStatus {
  idle
  syncing
  error
}

model MailThread {
  id            String   @id @default(cuid())
  userId        String
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  gmailThreadId String
  historyId     String?
  subject       String
  snippet       String
  participants  Json
  fromEmail     String?
  fromName      String?
  toEmails      Json
  labelIds      Json
  lastMessageAt DateTime
  messageCount  Int      @default(0)
  unread        Boolean  @default(false)
  starred       Boolean  @default(false)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([userId, gmailThreadId])
  @@index([userId, lastMessageAt])
  @@map("mail_thread")
}

model MailSyncState {
  id            String         @id @default(cuid())
  userId        String         @unique
  user          User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  query         String
  windowDays    Int            @default(90)
  nextPageToken String?
  lastHistoryId String?
  lastSyncedAt  DateTime?
  status        MailSyncStatus @default(idle)
  error         String?
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt

  @@map("mail_sync_state")
}
```

- [ ] **Step 3: Generate migration**

Run:

```bash
bunx prisma migrate dev --name add_gmail_mail_v1
```

Expected: Prisma creates `prisma/migrations/<timestamp>_add_gmail_mail_v1/migration.sql` and
regenerates the client.

- [ ] **Step 4: Verify Prisma types**

Run:

```bash
bun run check
```

Expected: PASS. If it fails because generated Prisma client is stale, run:

```bash
bunx prisma generate
bun run check
```

- [ ] **Step 5: Commit**

Run:

```bash
git add package.json bun.lock prisma/schema.prisma prisma/migrations
git commit -m "feat(mail): add gmail mail data model"
```

Expected: commit succeeds.

---

## Task 2: Configure Google Gmail Scope

**Files:**

- Modify: `src/lib/server/auth.ts`
- Create: `src/lib/constants/mail.ts`
- Modify: `.env.example`
- Test: `bun run check`

- [ ] **Step 1: Create shared Gmail constants**

Create `src/lib/constants/mail.ts`:

```ts
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const MAIL_WINDOW_DAYS = 90;
export const DEFAULT_MAIL_QUERY = `newer_than:${MAIL_WINDOW_DAYS}d (in:inbox OR in:sent)`;
```

- [ ] **Step 2: Update Better Auth Google provider**

In `src/lib/server/auth.ts`, import the Gmail scope:

```ts
import { GMAIL_READONLY_SCOPE } from '$lib/constants/mail';
```

Update the `google` provider:

```ts
google: {
  clientId: env.GOOGLE_CLIENT_ID!,
  clientSecret: env.GOOGLE_CLIENT_SECRET!,
  scope: ['openid', 'email', 'profile', GMAIL_READONLY_SCOPE],
  accessType: 'offline',
  prompt: 'consent'
}
```

Update the `account` block to encrypt OAuth tokens:

```ts
account: {
  enabled: true,
  encryptOAuthTokens: true,
  accountLinking: {
    enabled: true,
    trustedProviders: ['github', 'google']
  }
}
```

- [ ] **Step 3: Document Google environment variables**

In `.env.example`, add Google variables after GitHub variables:

```env
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
bun run check
```

Expected: PASS. If `accessType`, `prompt`, or `encryptOAuthTokens` fail typecheck, inspect
`node_modules/better-auth/dist` and use the exact option names supported by `better-auth@1.6.11`
without changing the product behavior.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/lib/constants/mail.ts src/lib/server/auth.ts .env.example
git commit -m "feat(auth): request gmail readonly scope"
```

Expected: commit succeeds.

---

## Task 3: Implement Gmail Server Client with Tests

**Files:**

- Create: `src/lib/server/gmail.ts`
- Test: `tests/unit/lib/server/gmail.test.ts`

- [ ] **Step 1: Write failing Gmail unit tests**

Create `tests/unit/lib/server/gmail.test.ts`:

```ts
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
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/gmail.test.ts
```

Expected: FAIL because `$lib/server/gmail` does not exist.

- [ ] **Step 3: Implement Gmail server module**

Create `src/lib/server/gmail.ts`:

```ts
import { auth } from '$lib/server/auth';
import { GMAIL_READONLY_SCOPE } from '$lib/constants/mail';

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

export async function getGoogleAccessToken(headers: Headers): Promise<GoogleTokenState> {
	try {
		const res = await auth.api.getAccessToken({ body: { providerId: 'google' }, headers });
		const scopes = res?.scopes ?? [];
		if (!res?.accessToken)
			return { connected: false, needsReconnect: false, accessToken: null, scopes: [] };
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
	const last = [...messages]
		.sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0))
		.at(-1);
	const first = messages[0];
	const subject = normalizeSubject(
		headerValue(first, 'Subject') ?? headerValue(last, 'Subject') ?? '(no subject)'
	);
	const from = parseAddress(headerValue(last, 'From') ?? '');
	const labels = unique(messages.flatMap((message) => message.labelIds ?? []));

	return {
		userId,
		gmailThreadId: thread.id,
		historyId: thread.historyId ?? null,
		subject,
		snippet: thread.snippet ?? last?.snippet ?? '',
		participants: collectParticipants(messages),
		fromEmail: from.email,
		fromName: from.name,
		toEmails: parseAddressList(headerValue(last, 'To') ?? '')
			.map((address) => address.email)
			.filter(Boolean),
		labelIds: labels,
		lastMessageAt: new Date(Number(last?.internalDate ?? Date.now())),
		messageCount: messages.length,
		unread: labels.includes('UNREAD'),
		starred: labels.includes('STARRED')
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
	const parts = payload.parts ?? [];
	const text = parts.map(extractBestMessageBody).find((part) => part.text)?.text ?? null;
	const html = parts.map(extractBestMessageBody).find((part) => part.html)?.html ?? null;
	return { text, html };
}

export function normalizeGmailError(error: unknown): NormalizedGmailError {
	const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 0;
	if (status === 401) {
		return { kind: 'needs_reconnect', message: 'Reconnect Google to continue reading Gmail.' };
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
		headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
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
	return subject.replace(/^(re|fw|fwd):\s*/i, '').trim() || '(no subject)';
}

function parseAddress(value: string): { email: string | null; name: string | null } {
	const match = value.match(/^(.*?)\s*<([^>]+)>$/);
	if (match) return { name: match[1].replace(/^"|"$/g, '').trim() || null, email: match[2].trim() };
	const trimmed = value.trim();
	return { name: null, email: trimmed.includes('@') ? trimmed : null };
}

function parseAddressList(value: string): Array<{ email: string; name: string | null }> {
	return value
		.split(',')
		.map((part) => parseAddress(part))
		.filter((address): address is { email: string; name: string | null } => Boolean(address.email));
}

function collectParticipants(
	messages: GmailMessage[]
): Array<{ email: string; name: string | null }> {
	const seen = new Map<string, { email: string; name: string | null }>();
	for (const message of messages) {
		for (const value of [headerValue(message, 'From'), headerValue(message, 'To')]) {
			for (const address of parseAddressList(value ?? '')) seen.set(address.email, address);
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
```

- [ ] **Step 4: Run tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/gmail.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/lib/server/gmail.ts tests/unit/lib/server/gmail.test.ts
git commit -m "feat(mail): add gmail api client"
```

Expected: commit succeeds.

---

## Task 4: Implement Mail Index Service

**Files:**

- Create: `src/lib/server/mail-service.ts`
- Test: `tests/unit/lib/server/mail-service.test.ts`

- [ ] **Step 1: Write failing service tests**

Create `tests/unit/lib/server/mail-service.test.ts`:

```ts
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
	mapGmailThreadToMailThread: vi.fn()
}));

import { prisma } from '$lib/server/prisma';
import {
	getGmailThread,
	listGmailThreadsPage,
	mapGmailThreadToMailThread
} from '$lib/server/gmail';
import {
	DEFAULT_MAIL_QUERY,
	listIndexedMailThreads,
	syncNextMailPage
} from '$lib/server/mail-service';

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
		vi.mocked(getGmailThread).mockResolvedValueOnce({ id: 'gmail-thread-1', messages: [] });
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
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/mail-service.test.ts
```

Expected: FAIL because `$lib/server/mail-service` does not exist.

- [ ] **Step 3: Implement mail service**

Create `src/lib/server/mail-service.ts`:

```ts
import { DEFAULT_MAIL_QUERY, MAIL_WINDOW_DAYS } from '$lib/constants/mail';
import { prisma } from '$lib/server/prisma';
import {
	getGmailThread,
	listGmailThreadsPage,
	mapGmailThreadToMailThread,
	normalizeGmailError
} from '$lib/server/gmail';

const PAGE_SIZE = 25;

export function listIndexedMailThreads(userId: string) {
	return prisma.mailThread.findMany({
		where: { userId },
		orderBy: { lastMessageAt: 'desc' },
		take: 50
	});
}

export async function syncNextMailPage(userId: string, accessToken: string) {
	const state = await prisma.mailSyncState.upsert({
		where: { userId },
		create: {
			userId,
			query: DEFAULT_MAIL_QUERY,
			windowDays: MAIL_WINDOW_DAYS,
			status: 'syncing'
		},
		update: { status: 'syncing', error: null }
	});

	try {
		const page = await listGmailThreadsPage(accessToken, {
			query: state.query || DEFAULT_MAIL_QUERY,
			pageToken: state.nextPageToken,
			maxResults: PAGE_SIZE
		});

		let synced = 0;
		for (const threadRef of page.threads ?? []) {
			const gmailThread = await getGmailThread(accessToken, threadRef.id, 'metadata');
			const mapped = mapGmailThreadToMailThread(userId, gmailThread);
			await prisma.mailThread.upsert({
				where: { userId_gmailThreadId: { userId, gmailThreadId: mapped.gmailThreadId } },
				create: mapped,
				update: {
					historyId: mapped.historyId,
					subject: mapped.subject,
					snippet: mapped.snippet,
					participants: mapped.participants,
					fromEmail: mapped.fromEmail,
					fromName: mapped.fromName,
					toEmails: mapped.toEmails,
					labelIds: mapped.labelIds,
					lastMessageAt: mapped.lastMessageAt,
					messageCount: mapped.messageCount,
					unread: mapped.unread,
					starred: mapped.starred
				}
			});
			synced += 1;
		}

		await prisma.mailSyncState.update({
			where: { userId },
			data: {
				nextPageToken: page.nextPageToken ?? null,
				lastSyncedAt: new Date(),
				status: 'idle',
				error: null
			}
		});

		return {
			synced,
			hasMore: Boolean(page.nextPageToken),
			nextPageToken: page.nextPageToken ?? null
		};
	} catch (error) {
		const normalized = normalizeGmailError(error);
		await prisma.mailSyncState.update({
			where: { userId },
			data: { status: 'error', error: normalized.message }
		});
		throw Object.assign(new Error(normalized.message), { kind: normalized.kind });
	}
}

export function getMailSyncState(userId: string) {
	return prisma.mailSyncState.findUnique({ where: { userId } });
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/mail-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/lib/server/mail-service.ts tests/unit/lib/server/mail-service.test.ts
git commit -m "feat(mail): add local thread index service"
```

Expected: commit succeeds.

---

## Task 5: Add Mail Schemas and Remote Functions

**Files:**

- Create: `src/lib/schemas/mail.ts`
- Create: `src/lib/rfc/mail.remote.ts`
- Test: `tests/unit/lib/schemas/mail.test.ts`

- [ ] **Step 1: Write schema tests**

Create `tests/unit/lib/schemas/mail.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getMailThreadSchema } from '$lib/schemas/mail';

describe('getMailThreadSchema', () => {
	it('accepts a gmail thread id', () => {
		expect(getMailThreadSchema.safeParse({ gmailThreadId: '18fabc123' }).success).toBe(true);
	});

	it('rejects empty thread id', () => {
		expect(getMailThreadSchema.safeParse({ gmailThreadId: '' }).success).toBe(false);
	});
});
```

- [ ] **Step 2: Create mail schema**

Create `src/lib/schemas/mail.ts`:

```ts
import { z } from 'zod';

export const getMailThreadSchema = z.object({
	gmailThreadId: z.string().min(1)
});
```

- [ ] **Step 3: Run schema tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/schemas/mail.test.ts
```

Expected: PASS.

- [ ] **Step 4: Implement remote functions**

Create `src/lib/rfc/mail.remote.ts`:

```ts
import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { requireHeaders } from '$lib/server/utils';
import { getMailThreadSchema } from '$lib/schemas/mail';
import { getGoogleAccessToken, getGmailThread, normalizeGmailError } from '$lib/server/gmail';
import {
	getMailSyncState,
	listIndexedMailThreads,
	syncNextMailPage as syncNextMailPageForUser
} from '$lib/server/mail-service';

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
	return {
		connected: true,
		needsReconnect: false,
		threads,
		hasMore: Boolean(syncState?.nextPageToken) || threads.length === 0,
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

	const result = await syncNextMailPageForUser(userId, token.accessToken);
	await listMailThreads().refresh();
	return { connected: true, needsReconnect: false, ...result };
});

export const getMailThread = query(getMailThreadSchema, async ({ gmailThreadId }) => {
	const headers = requireHeaders();
	const token = await getGoogleAccessToken(headers);
	if (!token.connected) error(400, 'Connect Google to read Gmail.');
	if (token.needsReconnect || !token.accessToken) error(400, 'Reconnect Google to read Gmail.');
	try {
		return await getGmailThread(token.accessToken, gmailThreadId, 'full');
	} catch (e) {
		const normalized = normalizeGmailError(e);
		error(normalized.kind === 'needs_reconnect' ? 400 : 503, normalized.message);
	}
});
```

- [ ] **Step 5: Run typecheck**

Run:

```bash
bun run check
```

Expected: PASS. If `threads` contains Prisma `JsonValue` values that do not serialize cleanly for
remote functions, map each thread to a plain object with JSON fields cast to arrays before returning.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/lib/schemas/mail.ts src/lib/rfc/mail.remote.ts tests/unit/lib/schemas/mail.test.ts
git commit -m "feat(mail): expose gmail remote functions"
```

Expected: commit succeeds.

---

## Task 6: Build the `/mail` UI with Runed Infinite Scroll

**Files:**

- Create: `src/routes/(app)/mail/+page.svelte`
- Modify: `src/routes/(app)/+layout.svelte`

- [ ] **Step 1: Add navigation link**

In `src/routes/(app)/+layout.svelte`, add a Mail nav link after Projects:

```svelte
<a href="/mail" class="text-sm font-medium hover:underline">Mail</a>
```

- [ ] **Step 2: Create Mail page**

Create `src/routes/(app)/mail/+page.svelte`:

```svelte
<script lang="ts">
	import { authClient } from '$lib/auth-client';
	import { GMAIL_READONLY_SCOPE } from '$lib/constants/mail';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { getMailThread, listMailThreads, syncNextMailPage } from '$lib/rfc/mail.remote';
	import { useIntersectionObserver } from 'runed';

	const threads = listMailThreads();

	let scrollRoot = $state<HTMLElement | null>(null);
	let sentinel = $state<HTMLElement | null>(null);
	let selectedThreadId = $state<string | null>(null);
	let loadingNextPage = $state(false);
	let syncError = $state<string | null>(null);

	const selectedThread = $derived(
		selectedThreadId ? getMailThread({ gmailThreadId: selectedThreadId }) : null
	);

	const observer = useIntersectionObserver(
		() => sentinel,
		async (entries) => {
			const entry = entries[0];
			if (!entry?.isIntersecting) return;
			if (!threads.current?.connected || threads.current.needsReconnect) return;
			if (!threads.current.hasMore || loadingNextPage) return;

			observer.pause();
			loadingNextPage = true;
			syncError = null;
			try {
				await syncNextMailPage();
			} catch (e) {
				syncError = e instanceof Error ? e.message : 'Could not load more mail.';
			} finally {
				loadingNextPage = false;
				if (threads.current?.hasMore) observer.resume();
			}
		},
		{ root: () => scrollRoot, rootMargin: '320px' }
	);

	async function connectGoogle() {
		await authClient.linkSocial({
			provider: 'google',
			callbackURL: '/mail',
			scopes: [GMAIL_READONLY_SCOPE]
		});
	}

	async function retrySync() {
		loadingNextPage = true;
		syncError = null;
		try {
			await syncNextMailPage();
		} catch (e) {
			syncError = e instanceof Error ? e.message : 'Could not sync Gmail.';
		} finally {
			loadingNextPage = false;
		}
	}
</script>

<div class="mx-auto flex h-[calc(100vh-57px)] max-w-6xl flex-col p-6">
	<div class="mb-4 flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-semibold">Mail</h1>
			<p class="text-sm text-muted-foreground">
				Inbox and sent conversations from the last 90 days.
			</p>
		</div>
		<Button variant="outline" onclick={retrySync} disabled={loadingNextPage}>
			{loadingNextPage ? 'Syncing...' : 'Sync'}
		</Button>
	</div>

	{#if threads.error}
		<Card.Root>
			<Card.Content class="p-4 text-sm text-destructive">
				Could not load mail: {threads.error.message}
			</Card.Content>
		</Card.Root>
	{:else if !threads.current}
		<p class="text-sm text-muted-foreground">Loading mail...</p>
	{:else if !threads.current.connected || threads.current.needsReconnect}
		<Card.Root class="max-w-xl">
			<Card.Header>
				<Card.Title>Connect Google</Card.Title>
				<Card.Description>
					dotWeaver needs read-only Gmail access to show your conversations.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<Button onclick={connectGoogle}>Connect Google</Button>
			</Card.Content>
		</Card.Root>
	{:else}
		<div class="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
			<section bind:this={scrollRoot} class="min-h-0 overflow-y-auto rounded-md border">
				{#if threads.current.threads.length === 0 && !loadingNextPage}
					<div class="p-4">
						<p class="text-sm text-muted-foreground">No indexed conversations yet.</p>
						<Button class="mt-3" onclick={retrySync}>Load Gmail conversations</Button>
					</div>
				{:else}
					<ul class="divide-y">
						{#each threads.current.threads as thread (thread.gmailThreadId)}
							<li>
								<button
									class="block w-full px-4 py-3 text-left hover:bg-accent"
									class:bg-accent={selectedThreadId === thread.gmailThreadId}
									onclick={() => (selectedThreadId = thread.gmailThreadId)}
								>
									<div class="flex items-center justify-between gap-3">
										<span class:font-semibold={thread.unread}>{thread.subject}</span>
										<span class="shrink-0 text-xs text-muted-foreground">
											{new Date(thread.lastMessageAt).toLocaleDateString()}
										</span>
									</div>
									<p class="mt-1 line-clamp-2 text-sm text-muted-foreground">{thread.snippet}</p>
								</button>
							</li>
						{/each}
					</ul>
				{/if}

				<div bind:this={sentinel} class="p-4 text-center text-sm text-muted-foreground">
					{#if loadingNextPage}
						Loading more...
					{:else if syncError ?? threads.current.error}
						<button class="underline underline-offset-4" onclick={retrySync}
							>Retry Gmail sync</button
						>
					{:else if !threads.current.hasMore}
						End of list
					{:else}
						Scroll for more
					{/if}
				</div>
			</section>

			<section class="min-h-0 overflow-y-auto rounded-md border p-4">
				{#if !selectedThread}
					<p class="text-sm text-muted-foreground">Select a conversation to read it.</p>
				{:else if selectedThread.error}
					<p class="text-sm text-destructive">{selectedThread.error.message}</p>
				{:else if selectedThread.current}
					<h2 class="text-xl font-semibold">
						{selectedThread.current.messages?.[0]?.payload?.headers?.find(
							(h) => h.name === 'Subject'
						)?.value ?? 'Conversation'}
					</h2>
					<pre class="mt-4 text-sm whitespace-pre-wrap">{JSON.stringify(
							selectedThread.current,
							null,
							2
						)}</pre>
				{:else}
					<p class="text-sm text-muted-foreground">Loading conversation...</p>
				{/if}
			</section>
		</div>
	{/if}
</div>
```

- [ ] **Step 3: Run Svelte autofixer**

Call the Svelte MCP `svelte-autofixer` on `Mail +page.svelte`. Apply every suggestion. Repeat until no
issues or suggestions remain.

- [ ] **Step 4: Run typecheck**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add 'src/routes/(app)/mail/+page.svelte' 'src/routes/(app)/+layout.svelte'
git commit -m "feat(mail): add gmail mail page"
```

Expected: commit succeeds.

---

## Task 7: Polish Thread Detail Rendering

**Files:**

- Modify: `src/lib/server/gmail.ts`
- Modify: `src/lib/rfc/mail.remote.ts`
- Modify: `src/routes/(app)/mail/+page.svelte`
- Test: `tests/unit/lib/server/gmail.test.ts`

- [ ] **Step 1: Add message view mapping test**

Append to `tests/unit/lib/server/gmail.test.ts`:

```ts
import { mapGmailThreadToThreadView } from '$lib/server/gmail';

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
});
```

- [ ] **Step 2: Implement thread view mapper**

Add these types and function to `src/lib/server/gmail.ts`:

```ts
export type MailMessageView = {
	gmailMessageId: string;
	fromEmail: string | null;
	fromName: string | null;
	toEmails: string[];
	date: Date;
	snippet: string;
	text: string | null;
	html: string | null;
};

export type MailThreadView = {
	gmailThreadId: string;
	subject: string;
	messages: MailMessageView[];
};

export function mapGmailThreadToThreadView(thread: GmailThread): MailThreadView {
	const messages = [...(thread.messages ?? [])].sort(
		(a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0)
	);
	const subject = normalizeSubject(headerValue(messages[0], 'Subject') ?? '(no subject)');
	return {
		gmailThreadId: thread.id,
		subject,
		messages: messages.map((message) => {
			const from = parseAddress(headerValue(message, 'From') ?? '');
			const body = extractBestMessageBody(message.payload);
			return {
				gmailMessageId: message.id,
				fromEmail: from.email,
				fromName: from.name,
				toEmails: parseAddressList(headerValue(message, 'To') ?? '').map(
					(address) => address.email
				),
				date: new Date(Number(message.internalDate ?? Date.now())),
				snippet: message.snippet ?? '',
				text: body.text,
				html: body.html
			};
		})
	};
}
```

- [ ] **Step 3: Use view mapper in remote function**

In `src/lib/rfc/mail.remote.ts`, import and use the mapper:

```ts
import {
	getGoogleAccessToken,
	getGmailThread,
	mapGmailThreadToThreadView,
	normalizeGmailError
} from '$lib/server/gmail';
```

Change the success return in `getMailThread`:

```ts
const thread = await getGmailThread(token.accessToken, gmailThreadId, 'full');
return mapGmailThreadToThreadView(thread);
```

- [ ] **Step 4: Render messages instead of JSON**

In `src/routes/(app)/mail/+page.svelte`, replace the selected thread success block with:

```svelte
{:else if selectedThread.current}
  <h2 class="text-xl font-semibold">{selectedThread.current.subject}</h2>
  <div class="mt-4 space-y-3">
    {#each selectedThread.current.messages as message (message.gmailMessageId)}
      <article class="rounded-md border p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="font-medium">{message.fromName ?? message.fromEmail ?? 'Unknown sender'}</p>
            <p class="text-xs text-muted-foreground">{message.toEmails.join(', ')}</p>
          </div>
          <time class="text-xs text-muted-foreground">{new Date(message.date).toLocaleString()}</time>
        </div>
        <p class="mt-3 whitespace-pre-wrap text-sm">{message.text ?? message.snippet}</p>
      </article>
    {/each}
  </div>
```

- [ ] **Step 5: Run tests and Svelte autofixer**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/gmail.test.ts
```

Expected: PASS.

Call Svelte MCP `svelte-autofixer` on `src/routes/(app)/mail/+page.svelte`; apply suggestions until
clean.

- [ ] **Step 6: Run typecheck**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/lib/server/gmail.ts src/lib/rfc/mail.remote.ts 'src/routes/(app)/mail/+page.svelte' tests/unit/lib/server/gmail.test.ts
git commit -m "feat(mail): render gmail thread messages"
```

Expected: commit succeeds.

---

## Task 8: Add E2E Smoke Coverage

**Files:**

- Create: `tests/e2e/mail.e2e.ts`

- [ ] **Step 1: Write e2e smoke test**

Create `tests/e2e/mail.e2e.ts`:

```ts
import { test, expect } from '@playwright/test';
import { registerUser, uniqueEmail } from './helpers';

test('mail route asks a logged-in user to connect Google when Gmail is not linked', async ({
	page
}) => {
	await registerUser(page, uniqueEmail());
	await page.goto('/mail');
	await expect(page.getByRole('heading', { name: 'Mail' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Connect Google' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Connect Google' })).toBeVisible();
});
```

- [ ] **Step 2: Run e2e smoke test**

Run:

```bash
bun run test:e2e -- tests/e2e/mail.e2e.ts
```

Expected: PASS. If the app server is not running automatically in Playwright, use the existing
Playwright config behavior and run the same command again after dependencies are ready.

- [ ] **Step 3: Commit**

Run:

```bash
git add tests/e2e/mail.e2e.ts
git commit -m "test(mail): cover gmail connect prompt"
```

Expected: commit succeeds.

---

## Task 9: Final Verification and Documentation Pass

**Files:**

- Modify if needed: files changed in Tasks 1-8

- [ ] **Step 1: Run unit tests**

Run:

```bash
bun run test:unit -- --run
```

Expected: PASS.

- [ ] **Step 2: Run SvelteKit check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 3: Run lint**

Run:

```bash
bun run lint
```

Expected: PASS.

- [ ] **Step 4: Run targeted e2e**

Run:

```bash
bun run test:e2e -- tests/e2e/mail.e2e.ts
```

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git status --short
git diff --stat origin/main...HEAD
```

Expected: only Gmail mail v1 files and docs are changed.

- [ ] **Step 6: Commit any final fixes**

If verification required fixes, run:

```bash
git add .
git commit -m "fix(mail): finalize gmail mail v1"
```

Expected: commit succeeds. If no fixes were needed, skip this commit.

---

## Self-Review

- Spec coverage: covered Google linking, Gmail readonly scope, hybrid local index, Inbox + Sent
  90-day query, lazy sync, thread detail on demand, error states, and tests.
- Red-flag scan: no unfinished-instruction markers remain.
- Type consistency: `gmailThreadId`, `MailThread`, `MailSyncState`, `syncNextMailPage`, and
  `getMailThread` names are consistent across tasks.
- Known implementation checkpoint: `GMAIL_READONLY_SCOPE` lives in `src/lib/constants/mail.ts` so
  browser code never imports `$lib/server`.
