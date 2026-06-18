# Poke User Question Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-user Poke connector that notifies the user's phone when a run asks a question, then lets Poke answer through a dedicated dotWeaver MCP tool.

**Architecture:** Store one encrypted Poke API key per user, expose masked remote functions for the connectors page, and keep all Poke network behavior in a server-only service. Reuse the existing `RunInteraction` flow: the orchestrator creates the pending interaction, sends a best-effort Poke notification, and the new MCP tool parses a natural-language answer into the existing interaction answer schema.

**Tech Stack:** SvelteKit remote functions, Svelte 5 runes, Prisma/PostgreSQL, Vitest, MCP tools, native `fetch`, existing AES-GCM project secret encryption.

---

## File Structure

- Modify `prisma/schema.prisma`: add `User.pokeConfig` relation and `UserPokeConfig`.
- Create `prisma/migrations/20260618010000_add_user_poke_config/migration.sql`: create `user_poke_config`.
- Create `src/lib/server/poke-service.ts`: encrypted user Poke config + Poke API notification.
- Create `tests/unit/lib/server/poke-service.test.ts`: service tests.
- Create `src/lib/server/run-interaction-answer-parser.ts`: pure text-to-answer parser.
- Create `tests/unit/lib/server/run-interaction-answer-parser.test.ts`: parser tests.
- Modify `src/lib/server/run-interactions-service.ts`: answer pending run question by `runId` + text.
- Modify `tests/unit/lib/server/run-interactions-service.test.ts`: service helper tests.
- Modify `src/lib/server/mcp/tools.ts`: register `answer_pending_question`.
- Modify `tests/unit/lib/server/mcp/tools.test.ts`: MCP tool tests.
- Modify `src/lib/server/run-orchestrator.ts`: send best-effort Poke notification after pending interaction creation.
- Modify `tests/unit/lib/server/run-orchestrator.test.ts`: notification orchestration tests.
- Create `src/lib/rfc/poke.remote.ts`: masked query and commands for the connectors page.
- Modify `src/routes/(app)/settings/connectors/+page.svelte`: add Poke connector card.
- Modify `docs/mcp.md`: document the new MCP tool.

### Task 1: Prisma Model And Migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260618010000_add_user_poke_config/migration.sql`

- [ ] **Step 1: Add the Prisma model**

In `prisma/schema.prisma`, add the relation field to `model User` after `mailSyncState`:

```prisma
  pokeConfig     UserPokeConfig?
```

Add the model after `model Account`:

```prisma
model UserPokeConfig {
  userId          String   @id
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  apiKeyEncrypted String
  enabled         Boolean  @default(true)
  lastNotifiedAt  DateTime?
  lastError       String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@map("user_poke_config")
}
```

- [ ] **Step 2: Create the SQL migration**

Create `prisma/migrations/20260618010000_add_user_poke_config/migration.sql`:

```sql
CREATE TABLE "user_poke_config" (
    "userId" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastNotifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_poke_config_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "user_poke_config"
ADD CONSTRAINT "user_poke_config_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "user"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Verify Prisma schema parses**

Run:

```bash
bunx prisma validate
```

Expected: `The schema at prisma/schema.prisma is valid`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260618010000_add_user_poke_config/migration.sql
git commit -m "feat(poke): add user poke config model"
```

### Task 2: Poke Server Service

**Files:**
- Create: `src/lib/server/poke-service.ts`
- Test: `tests/unit/lib/server/poke-service.test.ts`

- [ ] **Step 1: Write failing service tests**

Create `tests/unit/lib/server/poke-service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	upsert: vi.fn(),
	updateMany: vi.fn(),
	deleteMany: vi.fn(),
	privateEnv: { PROJECT_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') }
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.privateEnv }));
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		userPokeConfig: {
			findUnique: mocks.findUnique,
			upsert: mocks.upsert,
			updateMany: mocks.updateMany,
			deleteMany: mocks.deleteMany
		}
	}
}));

import {
	deleteUserPokeConfig,
	getUserPokeConfig,
	PokeConfigError,
	sendPokeQuestionNotification,
	upsertUserPokeApiKey
} from '$lib/server/poke-service';
import { decryptProjectSecretValue } from '$lib/server/project-agent-config-encryption';

const request = {
	questions: [
		{
			header: 'Layout',
			question: 'Which layout?',
			multiSelect: false,
			options: [
				{ label: 'Compact', description: 'Dense view' },
				{ label: 'Split', description: 'Two panels' }
			]
		}
	]
};

describe('poke-service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns a masked disconnected state when no config exists', async () => {
		mocks.findUnique.mockResolvedValue(null);

		await expect(getUserPokeConfig('u1')).resolves.toEqual({
			connected: false,
			enabled: false,
			lastNotifiedAt: null,
			lastError: null
		});
	});

	it('upserts an encrypted api key and returns masked connected state', async () => {
		mocks.upsert.mockImplementation(async ({ create }) => ({
			userId: create.userId,
			apiKeyEncrypted: create.apiKeyEncrypted,
			enabled: true,
			lastNotifiedAt: null,
			lastError: null
		}));

		const result = await upsertUserPokeApiKey('u1', ' pk_live ');
		const encrypted = mocks.upsert.mock.calls[0][0].create.apiKeyEncrypted;

		expect(decryptProjectSecretValue(encrypted)).toBe('pk_live');
		expect(result).toEqual({
			connected: true,
			enabled: true,
			lastNotifiedAt: null,
			lastError: null
		});
		expect(JSON.stringify(result)).not.toContain('pk_live');
	});

	it('rejects an empty api key', async () => {
		await expect(upsertUserPokeApiKey('u1', '   ')).rejects.toBeInstanceOf(PokeConfigError);
		expect(mocks.upsert).not.toHaveBeenCalled();
	});

	it('deletes a user config', async () => {
		mocks.deleteMany.mockResolvedValue({ count: 1 });

		await expect(deleteUserPokeConfig('u1')).resolves.toEqual({
			connected: false,
			enabled: false,
			lastNotifiedAt: null,
			lastError: null
		});
		expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
	});

	it('sends a Poke notification with the bearer api key and marks success', async () => {
		const now = new Date('2026-06-18T10:00:00.000Z');
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { encryptProjectSecretValue } = await import(
			'$lib/server/project-agent-config-encryption'
		);
		mocks.findUnique.mockResolvedValue({
			userId: 'u1',
			apiKeyEncrypted: encryptProjectSecretValue('poke-key'),
			enabled: true
		});
		mocks.updateMany.mockResolvedValue({ count: 1 });
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ success: true })
		});

		const result = await sendPokeQuestionNotification({
			userId: 'u1',
			runId: 'r1',
			interactionId: 'i1',
			projectLabel: 'acme/repo',
			request,
			fetchImpl
		});

		expect(result).toEqual({ sent: true });
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://poke.com/api/v1/inbound/api-message',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({ Authorization: 'Bearer poke-key' })
			})
		);
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body).message).toContain(
			'answer_pending_question'
		);
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { userId: 'u1' },
			data: { lastNotifiedAt: now, lastError: null }
		});
		vi.useRealTimers();
	});

	it('stores the last notification error and does not throw on Poke failure', async () => {
		const { encryptProjectSecretValue } = await import(
			'$lib/server/project-agent-config-encryption'
		);
		mocks.findUnique.mockResolvedValue({
			userId: 'u1',
			apiKeyEncrypted: encryptProjectSecretValue('poke-key'),
			enabled: true
		});
		mocks.updateMany.mockResolvedValue({ count: 1 });
		const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, text: vi.fn() });

		const result = await sendPokeQuestionNotification({
			userId: 'u1',
			runId: 'r1',
			interactionId: 'i1',
			projectLabel: 'acme/repo',
			request,
			fetchImpl
		});

		expect(result).toEqual({ sent: false, error: 'Poke API returned 401' });
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { userId: 'u1' },
			data: { lastError: 'Poke API returned 401' }
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/poke-service.test.ts
```

Expected: FAIL because `src/lib/server/poke-service.ts` does not exist.

- [ ] **Step 3: Implement the service**

Create `src/lib/server/poke-service.ts`:

```ts
import { prisma } from '$lib/server/prisma';
import {
	decryptProjectSecretValue,
	encryptProjectSecretValue
} from '$lib/server/project-agent-config-encryption';
import { askUserQuestionRequestSchema } from '$lib/schemas/run-interactions';

const POKE_API_MESSAGE_URL = 'https://poke.com/api/v1/inbound/api-message';

type FetchLike = typeof fetch;

export interface UserPokeConnector {
	connected: boolean;
	enabled: boolean;
	lastNotifiedAt: Date | null;
	lastError: string | null;
}

export class PokeConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PokeConfigError';
	}
}

function masked(row: {
	enabled: boolean;
	lastNotifiedAt: Date | null;
	lastError: string | null;
} | null): UserPokeConnector {
	if (!row) {
		return { connected: false, enabled: false, lastNotifiedAt: null, lastError: null };
	}
	return {
		connected: true,
		enabled: row.enabled,
		lastNotifiedAt: row.lastNotifiedAt,
		lastError: row.lastError
	};
}

function shortError(message: string): string {
	return message.trim().slice(0, 300) || 'Poke notification failed';
}

export async function getUserPokeConfig(userId: string): Promise<UserPokeConnector> {
	const row = await prisma.userPokeConfig.findUnique({
		where: { userId },
		select: { enabled: true, lastNotifiedAt: true, lastError: true }
	});
	return masked(row);
}

export async function upsertUserPokeApiKey(
	userId: string,
	apiKeyInput: string
): Promise<UserPokeConnector> {
	const apiKey = apiKeyInput.trim();
	if (!apiKey) throw new PokeConfigError('Poke API key is required');
	const row = await prisma.userPokeConfig.upsert({
		where: { userId },
		create: {
			userId,
			apiKeyEncrypted: encryptProjectSecretValue(apiKey),
			enabled: true,
			lastError: null
		},
		update: {
			apiKeyEncrypted: encryptProjectSecretValue(apiKey),
			enabled: true,
			lastError: null
		},
		select: { enabled: true, lastNotifiedAt: true, lastError: true }
	});
	return masked(row);
}

export async function setUserPokeEnabled(
	userId: string,
	enabled: boolean
): Promise<UserPokeConnector> {
	const result = await prisma.userPokeConfig.updateMany({
		where: { userId },
		data: { enabled }
	});
	if (result.count === 0) throw new PokeConfigError('Poke is not connected');
	return await getUserPokeConfig(userId);
}

export async function deleteUserPokeConfig(userId: string): Promise<UserPokeConnector> {
	await prisma.userPokeConfig.deleteMany({ where: { userId } });
	return { connected: false, enabled: false, lastNotifiedAt: null, lastError: null };
}

export function buildPokeQuestionMessage(input: {
	runId: string;
	interactionId: string;
	projectLabel: string;
	request: unknown;
}): string {
	const request = askUserQuestionRequestSchema.parse(input.request);
	const questionBlocks = request.questions.map((question, index) => {
		const options = question.options
			.map((option) => `- ${option.label}: ${option.description}`)
			.join('\n');
		return [`Question ${index + 1}: ${question.question}`, `Header: ${question.header}`, 'Options:', options].join(
			'\n'
		);
	});
	return [
		'dotWeaver needs your input to continue a run.',
		'',
		`Run ID: ${input.runId}`,
		`Interaction ID: ${input.interactionId}`,
		`Project: ${input.projectLabel}`,
		'',
		...questionBlocks,
		'',
		'Reply by calling the dotWeaver MCP tool answer_pending_question with:',
		`- runId: ${input.runId}`,
		'- message: your natural-language answer'
	].join('\n');
}

async function pokeResponseError(response: Response): Promise<string | null> {
	if (!response.ok) return `Poke API returned ${response.status}`;
	try {
		const body = (await response.json()) as { success?: unknown; message?: unknown; error?: unknown };
		if (body?.success === false) {
			return shortError(String(body.message ?? body.error ?? 'Poke API returned success=false'));
		}
	} catch {
		return null;
	}
	return null;
}

export async function sendPokeQuestionNotification(input: {
	userId: string;
	runId: string;
	interactionId: string;
	projectLabel: string;
	request: unknown;
	fetchImpl?: FetchLike;
}): Promise<{ sent: true } | { sent: false; skipped: 'not_configured' | 'disabled' } | { sent: false; error: string }> {
	const row = await prisma.userPokeConfig.findUnique({
		where: { userId: input.userId },
		select: { apiKeyEncrypted: true, enabled: true }
	});
	if (!row) return { sent: false, skipped: 'not_configured' };
	if (!row.enabled) return { sent: false, skipped: 'disabled' };

	const fetchImpl = input.fetchImpl ?? fetch;
	const message = buildPokeQuestionMessage(input);
	try {
		const response = await fetchImpl(POKE_API_MESSAGE_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${decryptProjectSecretValue(row.apiKeyEncrypted)}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ message })
		});
		const error = await pokeResponseError(response);
		if (error) {
			await prisma.userPokeConfig.updateMany({
				where: { userId: input.userId },
				data: { lastError: error }
			});
			return { sent: false, error };
		}
		await prisma.userPokeConfig.updateMany({
			where: { userId: input.userId },
			data: { lastNotifiedAt: new Date(), lastError: null }
		});
		return { sent: true };
	} catch (error) {
		const message = shortError(error instanceof Error ? error.message : String(error));
		await prisma.userPokeConfig.updateMany({
			where: { userId: input.userId },
			data: { lastError: message }
		});
		return { sent: false, error: message };
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/poke-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/poke-service.ts tests/unit/lib/server/poke-service.test.ts
git commit -m "feat(poke): add user poke service"
```

### Task 3: Natural-Language Interaction Answer Parser

**Files:**
- Create: `src/lib/server/run-interaction-answer-parser.ts`
- Test: `tests/unit/lib/server/run-interaction-answer-parser.test.ts`

- [ ] **Step 1: Write failing parser tests**

Create `tests/unit/lib/server/run-interaction-answer-parser.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OTHER_OPTION_VALUE } from '$lib/schemas/run-interactions';
import { parsePokeTextAnswer } from '$lib/server/run-interaction-answer-parser';

const request = {
	questions: [
		{
			header: 'Layout',
			question: 'Which layout?',
			multiSelect: false,
			options: [
				{ label: 'Compact', description: 'Dense view' },
				{ label: 'Split', description: 'Two panels' }
			]
		}
	]
};

describe('parsePokeTextAnswer', () => {
	it('matches a single-choice option ignoring case and punctuation', () => {
		expect(parsePokeTextAnswer(request, 'compact!')).toMatchObject({
			answers: { 'Which layout?': { selected: ['Compact'] } },
			response: 'compact!'
		});
	});

	it('falls back to Other with the original text when no option matches', () => {
		expect(parsePokeTextAnswer(request, 'Use the mobile layout')).toMatchObject({
			answers: {
				'Which layout?': { selected: [OTHER_OPTION_VALUE], otherText: 'Use the mobile layout' }
			}
		});
	});

	it('parses multiple questions from Question/Header lines', () => {
		const multiRequest = {
			questions: [
				...request.questions,
				{
					header: 'Tone',
					question: 'Which tone?',
					multiSelect: false,
					options: [
						{ label: 'Calm', description: 'Quiet copy' },
						{ label: 'Bold', description: 'Punchy copy' }
					]
				}
			]
		};

		expect(
			parsePokeTextAnswer(multiRequest, 'Layout: Split\nTone: Bold')
		).toMatchObject({
			answers: {
				'Which layout?': { selected: ['Split'] },
				'Which tone?': { selected: ['Bold'] }
			}
		});
	});

	it('selects every mentioned option for multi-select questions', () => {
		const multiSelectRequest = {
			questions: [
				{
					header: 'Channels',
					question: 'Which channels?',
					multiSelect: true,
					options: [
						{ label: 'Email', description: 'Email updates' },
						{ label: 'SMS', description: 'Text messages' },
						{ label: 'Push', description: 'Push notifications' }
					]
				}
			]
		};

		expect(parsePokeTextAnswer(multiSelectRequest, 'Email and push')).toMatchObject({
			answers: { 'Which channels?': { selected: ['Email', 'Push'] } }
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/run-interaction-answer-parser.test.ts
```

Expected: FAIL because `src/lib/server/run-interaction-answer-parser.ts` does not exist.

- [ ] **Step 3: Implement the parser**

Create `src/lib/server/run-interaction-answer-parser.ts`:

```ts
import {
	askUserQuestionRequestSchema,
	OTHER_OPTION_VALUE,
	type AnswerRunInteractionInput
} from '$lib/schemas/run-interactions';

type ParsedAnswer = Pick<AnswerRunInteractionInput, 'answers' | 'response' | 'annotations'>;
type Question = ReturnType<typeof askUserQuestionRequestSchema.parse>['questions'][number];

function normalize(value: string): string {
	return value
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

function containsLabel(text: string, label: string): boolean {
	const normalizedText = normalize(text);
	const normalizedLabel = normalize(label);
	if (!normalizedText || !normalizedLabel) return false;
	return (
		normalizedText === normalizedLabel ||
		normalizedText.startsWith(`${normalizedLabel} `) ||
		normalizedText.includes(` ${normalizedLabel} `) ||
		normalizedText.endsWith(` ${normalizedLabel}`)
	);
}

function parseLineAnswers(message: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const rawLine of message.split('\n')) {
		const [rawKey, ...rest] = rawLine.split(':');
		const value = rest.join(':').trim();
		if (!rawKey || !value) continue;
		out.set(normalize(rawKey), value);
	}
	return out;
}

function textForQuestion(question: Question, message: string, lineAnswers: Map<string, string>): string {
	return (
		lineAnswers.get(normalize(question.question)) ??
		lineAnswers.get(normalize(question.header)) ??
		message
	);
}

function selectedForQuestion(question: Question, text: string): { selected: string[]; otherText?: string } {
	const matches = question.options
		.filter((option) => containsLabel(text, option.label))
		.map((option) => option.label);

	if (question.multiSelect && matches.length > 0) return { selected: matches };
	if (!question.multiSelect && matches.length === 1) return { selected: [matches[0]] };

	return { selected: [OTHER_OPTION_VALUE], otherText: text };
}

export function parsePokeTextAnswer(requestInput: unknown, messageInput: string): ParsedAnswer {
	const message = messageInput.trim();
	if (!message) throw new Error('A message is required');
	const request = askUserQuestionRequestSchema.parse(requestInput);
	const lineAnswers = parseLineAnswers(message);
	const answers: AnswerRunInteractionInput['answers'] = {};

	for (const question of request.questions) {
		const text = textForQuestion(question, message, lineAnswers).trim();
		answers[question.question] = selectedForQuestion(question, text);
	}

	return {
		answers,
		response: message,
		annotations: { source: { channel: 'poke', parser: 'text' } }
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/run-interaction-answer-parser.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/run-interaction-answer-parser.ts tests/unit/lib/server/run-interaction-answer-parser.test.ts
git commit -m "feat(poke): parse text answers for interactions"
```

### Task 4: Run Interaction Text Answer Helper

**Files:**
- Modify: `src/lib/server/run-interactions-service.ts`
- Modify: `tests/unit/lib/server/run-interactions-service.test.ts`

- [ ] **Step 1: Extend the Prisma mock and write failing tests**

In `tests/unit/lib/server/run-interactions-service.test.ts`, extend the mock:

```ts
prisma: {
	$transaction: vi.fn(),
	run: {
		findFirst: vi.fn()
	},
	runInteraction: {
		findFirst: vi.fn(),
		update: vi.fn(),
		findUnique: vi.fn(),
		updateMany: vi.fn()
	}
}
```

Add imports:

```ts
	answerPendingRunQuestionTextForOrg,
```

Add this mock constant near other mock constants:

```ts
const runFindFirstMock = prisma.run.findFirst as unknown as Mock;
```

Add tests before the existing wait tests:

```ts
it('answers the current pending run interaction from free text', async () => {
	runFindFirstMock.mockResolvedValue({
		id: 'r1',
		projectId: 'p1',
		status: 'awaiting_input',
		interactions: [{ id: 'i1', request }]
	});
	runInteractionFindFirstMock.mockResolvedValue({
		id: 'i1',
		status: RUN_INTERACTION_STATUS.PENDING,
		request,
		run: { id: 'r1', projectId: 'p1', status: 'awaiting_input' }
	});
	const response = {
		answers: { 'Which layout?': 'Compact' },
		response: 'Compact',
		annotations: { source: { channel: 'poke', parser: 'text' } }
	};
	const updated = { id: 'i1', response, run: { id: 'r1', projectId: 'p1' } };
	mockAnswerTransaction(updated);

	await expect(
		answerPendingRunQuestionTextForOrg('org1', { runId: 'r1', message: 'Compact' })
	).resolves.toEqual({ interaction: updated, response, runId: 'r1', projectId: 'p1' });

	expect(runFindFirstMock).toHaveBeenCalledWith({
		where: { id: 'r1', organizationId: 'org1' },
		select: {
			id: true,
			projectId: true,
			interactions: {
				where: { status: RUN_INTERACTION_STATUS.PENDING },
				orderBy: { createdAt: 'desc' },
				take: 1,
				select: { id: true, request: true }
			}
		}
	});
});

it('returns null when text-answering a run outside the organization', async () => {
	runFindFirstMock.mockResolvedValue(null);

	await expect(
		answerPendingRunQuestionTextForOrg('org1', { runId: 'missing', message: 'Compact' })
	).resolves.toBeNull();
});

it('rejects text-answering when the run has no pending question', async () => {
	runFindFirstMock.mockResolvedValue({
		id: 'r1',
		projectId: 'p1',
		interactions: []
	});

	await expect(
		answerPendingRunQuestionTextForOrg('org1', { runId: 'r1', message: 'Compact' })
	).rejects.toBeInstanceOf(RunInteractionAnswerError);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/run-interactions-service.test.ts
```

Expected: FAIL because `answerPendingRunQuestionTextForOrg` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/lib/server/run-interactions-service.ts`, add the import:

```ts
import { parsePokeTextAnswer } from '$lib/server/run-interaction-answer-parser';
```

Add this function after `answerPendingRunInteractionForOrg`:

```ts
export async function answerPendingRunQuestionTextForOrg(
	organizationId: string,
	input: { runId: string; message: string }
) {
	const run = await prisma.run.findFirst({
		where: { id: input.runId, organizationId },
		select: {
			id: true,
			projectId: true,
			interactions: {
				where: { status: RUN_INTERACTION_STATUS.PENDING },
				orderBy: { createdAt: 'desc' },
				take: 1,
				select: { id: true, request: true }
			}
		}
	});
	if (!run) return null;
	const interaction = run.interactions[0];
	if (!interaction) throw new RunInteractionAnswerError('No pending question for this run');

	return await answerPendingRunInteractionForOrg(organizationId, {
		interactionId: interaction.id,
		...parsePokeTextAnswer(interaction.request, input.message)
	});
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/run-interactions-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/run-interactions-service.ts tests/unit/lib/server/run-interactions-service.test.ts
git commit -m "feat(poke): answer pending run questions from text"
```

### Task 5: MCP Tool `answer_pending_question`

**Files:**
- Modify: `src/lib/server/mcp/tools.ts`
- Modify: `tests/unit/lib/server/mcp/tools.test.ts`
- Modify: `docs/mcp.md`

- [ ] **Step 1: Write failing MCP tests**

In `tests/unit/lib/server/mcp/tools.test.ts`, add to the hoisted mock:

```ts
vi.mock('$lib/server/run-interactions-service', () => ({
	answerPendingRunQuestionTextForOrg: vi.fn(),
	RunInteractionAnswerError: class RunInteractionAnswerError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'RunInteractionAnswerError';
		}
	}
}));
```

Add imports:

```ts
import {
	answerPendingRunQuestionTextForOrg,
	RunInteractionAnswerError
} from '$lib/server/run-interactions-service';
```

Add a typed mock:

```ts
const mockedAnswerPendingRunQuestionTextForOrg = vi.mocked(
	answerPendingRunQuestionTextForOrg
) as Mock<(orgId: string, input: Record<string, unknown>) => Promise<unknown | null>>;
```

Update the tool registration expectation from 12 to 13 and include `answer_pending_question`:

```ts
expect(Object.keys(s.tools).sort()).toEqual([
	'answer_pending_question',
	'approve_run',
	'cancel_run',
	'get_project',
	'get_run',
	'get_run_diff',
	'import_github_project',
	'list_projects',
	'list_runs',
	'list_teams',
	'reply_to_run',
	'start_run',
	'stream_run_events'
]);
```

Add tests:

```ts
it('answer_pending_question resolves org and answers a pending interaction from text', async () => {
	const s = fakeServer();
	registerTools(s, { userId: 'u1' });
	mockedResolveOrgContext.mockResolvedValue('org1');
	mockedAnswerPendingRunQuestionTextForOrg.mockResolvedValue({ runId: 'r1', projectId: 'p1' });

	const res = await s.tools.answer_pending_question({
		runId: 'r1',
		message: 'Use Compact',
		team: 'core'
	});

	expect(resolveOrgContext).toHaveBeenCalledWith('u1', 'core');
	expect(answerPendingRunQuestionTextForOrg).toHaveBeenCalledWith('org1', {
		runId: 'r1',
		message: 'Use Compact'
	});
	expect(JSON.parse(res.content[0].text)).toEqual({ answered: true });
	expect(res.isError).toBeFalsy();
});

it('answer_pending_question maps null and interaction errors to tool errors', async () => {
	const s = fakeServer();
	registerTools(s, { userId: 'u1' });
	mockedResolveOrgContext.mockResolvedValue('org1');
	mockedAnswerPendingRunQuestionTextForOrg.mockResolvedValueOnce(null);

	const missing = await s.tools.answer_pending_question({ runId: 'missing', message: 'Compact' });

	mockedAnswerPendingRunQuestionTextForOrg.mockRejectedValueOnce(
		new RunInteractionAnswerError('No pending question for this run')
	);
	const noQuestion = await s.tools.answer_pending_question({ runId: 'r1', message: 'Compact' });

	expect(missing.isError).toBe(true);
	expect(missing.content[0].text).toBe('Run not found');
	expect(noQuestion.isError).toBe(true);
	expect(noQuestion.content[0].text).toBe('No pending question for this run');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/mcp/tools.test.ts
```

Expected: FAIL because the tool is not registered.

- [ ] **Step 3: Register the MCP tool**

In `src/lib/server/mcp/tools.ts`, add to the imports:

```ts
import {
	answerPendingRunQuestionTextForOrg,
	RunInteractionAnswerError
} from '$lib/server/run-interactions-service';
```

Extend `mapWriteError`:

```ts
		e instanceof RunInteractionAnswerError
```

Add this tool before `reply_to_run`:

```ts
mcpServer.tool(
	'answer_pending_question',
	'Answer the current pending user question for a run using a natural-language message.',
	{ runId: z.string().min(1), message: z.string().trim().min(1), team },
	async (args: { runId: string; message: string; team?: string }): Promise<ToolResult> => {
		try {
			const organizationId = await resolveOrgContext(ctx.userId, args.team);
			const result = await answerPendingRunQuestionTextForOrg(organizationId, {
				runId: args.runId,
				message: args.message
			});
			return result ? ok({ answered: true }) : fail('Run not found');
		} catch (e) {
			return mapOrgError(e) ?? mapWriteError(e) ?? fail('Failed to answer pending question');
		}
	}
);
```

- [ ] **Step 4: Update `docs/mcp.md`**

In the tools table, add:

```markdown
| `answer_pending_question` | `{ runId, message, team? }` | Répond à la question utilisateur pending d'un run avec une réponse en texte libre. | `{ answered: true }` |
```

Update the manual checklist count from `12 outils` to `13 outils` and add
`answer_pending_question` to the listed names.

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/mcp/tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/mcp/tools.ts tests/unit/lib/server/mcp/tools.test.ts docs/mcp.md
git commit -m "feat(mcp): answer pending questions from poke"
```

### Task 6: Orchestrator Poke Notification Hook

**Files:**
- Modify: `src/lib/server/run-orchestrator.ts`
- Modify: `tests/unit/lib/server/run-orchestrator.test.ts`

- [ ] **Step 1: Write failing orchestrator tests**

In `tests/unit/lib/server/run-orchestrator.test.ts`, add `sendPokeQuestionNotification` to `mocks`.

Add mock module:

```ts
vi.mock('$lib/server/poke-service', () => ({
	sendPokeQuestionNotification: mocks.sendPokeQuestionNotification
}));
```

In `beforeEach`, add:

```ts
mocks.sendPokeQuestionNotification.mockResolvedValue({ sent: true });
```

In `setupRun`, ensure `project` has owner and name:

```ts
project: {
	id: 'p1',
	owner: 'acme',
	name: 'repo',
	cloneUrl: 'https://github.com/acme/repo.git',
	defaultBranch: 'main'
}
```

Add this test near the existing interaction test:

```ts
it('sends a best-effort Poke notification after creating a pending interaction', async () => {
	setupRun();
	mocks.createPendingRunInteraction.mockResolvedValue({ id: 'i1' });
	const answer = deferred<SerializedAskUserQuestionResponse>();
	mocks.waitForRunInteractionAnswer.mockReturnValue(answer.promise);
	const sendControlMessage = vi.fn<RunContainerControl['sendControlMessage']>();
	sendControlMessage.mockResolvedValue(undefined);

	mocks.runContainer.mockImplementation(
		async (_args: string[], onLine: RunContainerLineHandler) => {
			await onLine(JSON.stringify(interactionRequest), { sendControlMessage });
			answer.resolve({ answers: { 'Which layout?': 'Compact' } });
			return { exitCode: 0, timedOut: false };
		}
	);

	await executeRun(runId);

	expect(mocks.sendPokeQuestionNotification).toHaveBeenCalledWith({
		userId: 'u1',
		runId,
		interactionId: 'i1',
		projectLabel: 'acme/repo',
		request
	});
});
```

Add the failure-is-best-effort test:

```ts
it('does not fail the run when Poke notification fails', async () => {
	setupRun();
	mocks.createPendingRunInteraction.mockResolvedValue({ id: 'i1' });
	mocks.sendPokeQuestionNotification.mockRejectedValue(new Error('poke down'));
	mocks.waitForRunInteractionAnswer.mockResolvedValue({
		answers: { 'Which layout?': 'Compact' }
	});
	const sendControlMessage = vi.fn<RunContainerControl['sendControlMessage']>();
	sendControlMessage.mockResolvedValue(undefined);

	mocks.runContainer.mockImplementation(
		async (_args: string[], onLine: RunContainerLineHandler) => {
			await onLine(JSON.stringify(interactionRequest), { sendControlMessage });
			return { exitCode: 0, timedOut: false };
		}
	);

	await executeRun(runId);

	expectTransition(['running'], 'awaiting_review');
	expect(mocks.runUpdateMany).not.toHaveBeenCalledWith(
		expect.objectContaining({ data: expect.objectContaining({ error: 'poke down' }) })
	);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/run-orchestrator.test.ts
```

Expected: FAIL because the orchestrator does not call Poke.

- [ ] **Step 3: Implement the hook**

In `src/lib/server/run-orchestrator.ts`, add:

```ts
import { sendPokeQuestionNotification } from '$lib/server/poke-service';
```

Inside the `if (isInteractionRequest(msg))` block, after `createPendingRunInteraction` resolves and before appending the event, add:

```ts
pending.push(
	sendPokeQuestionNotification({
		userId: run.createdById,
		runId,
		interactionId: interaction.id,
		projectLabel: `${project.owner}/${project.name}`,
		request: msg.request
	}).then(
		() => {},
		() => {}
	)
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/run-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/run-orchestrator.ts tests/unit/lib/server/run-orchestrator.test.ts
git commit -m "feat(poke): notify users about pending questions"
```

### Task 7: Poke Remote Functions

**Files:**
- Create: `src/lib/rfc/poke.remote.ts`

- [ ] **Step 1: Create the remote functions**

Create `src/lib/rfc/poke.remote.ts`:

```ts
import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import {
	deleteUserPokeConfig,
	getUserPokeConfig,
	PokeConfigError,
	setUserPokeEnabled,
	upsertUserPokeApiKey
} from '$lib/server/poke-service';

function requireUserId(): string {
	const { locals } = getRequestEvent();
	const userId = locals.user?.id;
	if (!userId) error(401, 'Not authenticated');
	return userId;
}

function mapPokeError(e: unknown): never {
	if (e instanceof PokeConfigError) error(400, e.message);
	throw e;
}

export const getPokeConnector = query(async () => {
	return await getUserPokeConfig(requireUserId());
});

export const savePokeApiKey = command(
	z.object({ apiKey: z.string().trim().min(1) }),
	async ({ apiKey }) => {
		try {
			const result = await upsertUserPokeApiKey(requireUserId(), apiKey);
			await getPokeConnector().refresh();
			return result;
		} catch (e) {
			mapPokeError(e);
		}
	}
);

export const setPokeEnabled = command(z.object({ enabled: z.boolean() }), async ({ enabled }) => {
	try {
		const result = await setUserPokeEnabled(requireUserId(), enabled);
		await getPokeConnector().refresh();
		return result;
	} catch (e) {
		mapPokeError(e);
	}
});

export const deletePokeConnector = command(async () => {
	const result = await deleteUserPokeConfig(requireUserId());
	await getPokeConnector().refresh();
	return result;
});
```

- [ ] **Step 2: Type-check the remote functions**

Run:

```bash
bun run check
```

Expected: no errors referencing `poke.remote.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/rfc/poke.remote.ts
git commit -m "feat(poke): add connector remote functions"
```

### Task 8: Connectors Page UI

**Files:**
- Modify: `src/routes/(app)/settings/connectors/+page.svelte`

- [ ] **Step 1: Add imports and state**

In `src/routes/(app)/settings/connectors/+page.svelte`, update imports:

```svelte
import { Bell, ExternalLink, GitBranch, KeyRound, Mail, Trash2 } from '@lucide/svelte';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import {
	deletePokeConnector,
	getPokeConnector,
	savePokeApiKey,
	setPokeEnabled
} from '$lib/rfc/poke.remote';
```

Add state after `const connectors = listConnectors();`:

```svelte
const poke = getPokeConnector();
let pokeApiKey = $state('');
let pokePending = $state(false);
let pokeError = $state<string | null>(null);
```

- [ ] **Step 2: Add Poke action handlers**

Add these functions in the `<script>` block:

```svelte
async function savePoke() {
	const apiKey = pokeApiKey.trim();
	if (!apiKey) return;
	pokePending = true;
	pokeError = null;
	try {
		await savePokeApiKey({ apiKey });
		pokeApiKey = '';
		await poke.refresh();
	} catch (e) {
		pokeError = e instanceof Error ? e.message : 'Échec de la sauvegarde Poke.';
	} finally {
		pokePending = false;
	}
}

async function togglePoke(enabled: boolean) {
	pokePending = true;
	pokeError = null;
	try {
		await setPokeEnabled({ enabled });
		await poke.refresh();
	} catch (e) {
		pokeError = e instanceof Error ? e.message : 'Échec de la mise à jour Poke.';
	} finally {
		pokePending = false;
	}
}

async function removePoke() {
	pokePending = true;
	pokeError = null;
	try {
		await deletePokeConnector();
		pokeApiKey = '';
		await poke.refresh();
	} catch (e) {
		pokeError = e instanceof Error ? e.message : 'Échec de la suppression Poke.';
	} finally {
		pokePending = false;
	}
}
```

- [ ] **Step 3: Add the Poke card markup**

After the Google connector card, add:

```svelte
{#if poke.current}
	<ConnectorCard
		name="Poke"
		status={poke.current.connected ? 'connected' : 'disconnected'}
		description="Envoie les questions de l'agent sur votre téléphone."
	>
		{#snippet icon()}<Bell class="size-5" />{/snippet}
		{#snippet actions()}
			<div class="grid w-full gap-3">
				{#if pokeError}
					<Alert.Root variant="destructive">
						<Alert.Description>{pokeError}</Alert.Description>
					</Alert.Root>
				{/if}
				{#if poke.current.lastError}
					<Alert.Root variant="destructive">
						<Alert.Description>Dernière notification Poke: {poke.current.lastError}</Alert.Description>
					</Alert.Root>
				{/if}

				<div class="grid gap-2">
					<Label for="poke-api-key">Clé API Poke</Label>
					<div class="flex flex-col gap-2 sm:flex-row">
						<Input
							id="poke-api-key"
							type="password"
							bind:value={pokeApiKey}
							placeholder={poke.current.connected ? 'Remplacer la clé' : 'pk_...'}
							autocomplete="off"
						/>
						<Button onclick={savePoke} disabled={pokePending || !pokeApiKey.trim()}>
							<KeyRound class="size-4" />
							{poke.current.connected ? 'Remplacer' : 'Connecter'}
						</Button>
					</div>
				</div>

				{#if poke.current.connected}
					<label class="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={poke.current.enabled}
							disabled={pokePending}
							onchange={(event) => togglePoke(event.currentTarget.checked)}
						/>
						Notifications Poke actives
					</label>
					<div class="flex flex-wrap items-center gap-2">
						<Button variant="outline" onclick={removePoke} disabled={pokePending}>
							<Trash2 class="size-4" />
							Supprimer
						</Button>
						{#if poke.current.lastNotifiedAt}
							<span class="text-xs text-muted-foreground">
								Dernier envoi: {new Date(poke.current.lastNotifiedAt).toLocaleString()}
							</span>
						{/if}
					</div>
				{/if}
			</div>
		{/snippet}
	</ConnectorCard>
{/if}
```

- [ ] **Step 4: Run the Svelte autofixer**

Use `mcp__svelte__svelte-autofixer` on the full updated `+page.svelte` file with `desired_svelte_version: 5`. Apply every fix it suggests, then run the autofixer again until it returns no issues.

- [ ] **Step 5: Verify the page**

Run:

```bash
bun run check
```

Expected: no Svelte or TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add 'src/routes/(app)/settings/connectors/+page.svelte'
git commit -m "feat(poke): add connector settings UI"
```

### Task 9: Full Verification

**Files:**
- All changed files.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
bun run test:unit -- --run \
	tests/unit/lib/server/poke-service.test.ts \
	tests/unit/lib/server/run-interaction-answer-parser.test.ts \
	tests/unit/lib/server/run-interactions-service.test.ts \
	tests/unit/lib/server/mcp/tools.test.ts \
	tests/unit/lib/server/run-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full unit suite**

Run:

```bash
bun run test:unit -- --run
```

Expected: PASS.

- [ ] **Step 3: Run Svelte/type check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 4: Manual smoke test**

Run:

```bash
bun run dev
```

Open `/settings/connectors`, save a test Poke key, toggle it off and on, then delete it. With a real Poke key, start a run that asks a question and verify Poke receives a message containing `runId`, `interactionId`, question/options, and `answer_pending_question`.

- [ ] **Step 5: Final commit if verification caused cleanup**

If verification required edits:

```bash
git add <changed-files>
git commit -m "fix(poke): complete connector verification fixes"
```

## Self-Review

- **Spec coverage:** user-scoped encrypted key (Tasks 1, 2, 7, 8), Poke notification on `ask_user_question` (Tasks 2, 6), dedicated MCP answer tool (Tasks 3, 4, 5), natural-language parsing with fallback `Autre` (Task 3), UI connector card (Task 8), docs/tests (Tasks 5, 9).
- **No placeholders:** every task names concrete files, commands, expected outcomes, and code blocks for the implementation work.
- **Type consistency:** service names are consistent across tasks: `sendPokeQuestionNotification`, `parsePokeTextAnswer`, `answerPendingRunQuestionTextForOrg`, `answer_pending_question`, `getPokeConnector`, `savePokeApiKey`, `setPokeEnabled`, `deletePokeConnector`.
- **Known integration risk:** the exact Poke inbound body shape is based on Poke's API-message endpoint accepting JSON message payloads. If manual smoke shows a required body field differs, update only `sendPokeQuestionNotification` and keep its tests aligned with the real payload.
