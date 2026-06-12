# Interactive Agent Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one active structured user-input block per agent run, resume the same running container after a complete answer, and show the current Claude todo list in the run UI.

**Architecture:** The runner intercepts Claude Code `AskUserQuestion` in `canUseTool`, emits a dotWeaver control message, and waits for the host to answer over stdin. The host persists a `RunInteraction`, moves the run to `awaiting_input`, polls DB for the web user's answer, sends it back to the container, then resumes `running`. Todo display is a pure projection from the latest `TodoWrite` tool call in persisted events.

**Tech Stack:** TypeScript, SvelteKit remote functions, Svelte 5 runes, Prisma/PostgreSQL, Docker child process orchestration, Vitest, Tailwind/shadcn-svelte components.

---

## File Structure

- Modify: `prisma/schema.prisma`  
  Adds `awaiting_input`, `RunInteractionKind`, `RunInteractionStatus`, `RunInteraction`, and `Run.interactions`.
- Create: `prisma/migrations/20260612000000_add_run_interactions/migration.sql`  
  Adds SQL enum/table/index changes, including a partial unique index for one pending interaction per run.
- Modify: `src/lib/server/run-state.ts` and `src/lib/server/run-state.test.ts`  
  Adds legal transitions for `awaiting_input`.
- Modify: `src/lib/server/run-recovery.ts` and `src/lib/server/run-recovery.test.ts`  
  Treats `awaiting_input` as orphaned on worker restart.
- Create: `src/lib/schemas/run-interactions.ts` and `src/lib/schemas/run-interactions.test.ts`  
  Defines request/answer schemas and pure validation/serialization for AskUserQuestion.
- Create: `src/lib/server/run-interactions-service.ts` and `src/lib/server/run-interactions-service.test.ts`  
  Owns DB lifecycle for pending/answered/canceled interactions and runner polling.
- Modify: `src/lib/server/runs-service.ts` and `src/lib/server/runs-service.test.ts`  
  Includes active interaction in run details.
- Modify: `src/lib/rfc/runs.remote.ts`  
  Adds `answerRunInteraction`.
- Modify: `src/lib/server/docker.ts` and `src/lib/server/docker.test.ts`  
  Keeps Docker stdin open and exposes `sendControlMessage`.
- Modify: `docker/runner/entrypoint.mjs`  
  Implements JSON-lines stdin wait for `AskUserQuestion`.
- Modify: `src/lib/server/run-orchestrator.ts`  
  Handles `interaction_request`, status transitions, polling, and response send.
- Modify/Create tests around orchestrator behavior in `src/lib/server/run-orchestrator.test.ts`.
- Create: `src/lib/components/runs/todos.ts` and `src/lib/components/runs/todos.test.ts`  
  Extracts current todo state from events.
- Create: `src/lib/components/runs/AskUserQuestionCard.svelte`  
  Renders the single active interaction block and answer form.
- Create: `src/lib/components/runs/CurrentTodos.svelte`  
  Renders the current todo list panel.
- Modify: `src/lib/components/runs/run-event-display.ts` and test  
  Hides or normalizes internal `interaction_request` events.
- Modify: `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`  
  Wires status, active interaction, answer command, current todos, and SSE refresh.

---

### Task 1: Prisma Model, Run State, And Recovery

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260612000000_add_run_interactions/migration.sql`
- Modify: `src/lib/server/run-state.ts`
- Modify: `src/lib/server/run-state.test.ts`
- Modify: `src/lib/server/run-recovery.ts`
- Modify: `src/lib/server/run-recovery.test.ts`

- [ ] **Step 1: Write failing run-state tests**

Add this test to `src/lib/server/run-state.test.ts`:

```ts
it('allows awaiting_input pause and resume from running', () => {
	expect(canTransition('running', 'awaiting_input')).toBe(true);
	expect(canTransition('awaiting_input', 'running')).toBe(true);
	expect(canTransition('awaiting_input', 'canceled')).toBe(true);
	expect(canTransition('awaiting_input', 'timed_out')).toBe(true);
	expect(canTransition('awaiting_input', 'failed')).toBe(true);
	expect(canTransition('awaiting_input', 'completed')).toBe(false);
});
```

Update the recovery test expectation in `src/lib/server/run-recovery.test.ts`:

```ts
expect([...ORPHAN_STATUSES].sort()).toEqual([
	'awaiting_input',
	'preparing',
	'pushing',
	'running'
]);
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
bun run test:unit -- --run src/lib/server/run-state.test.ts src/lib/server/run-recovery.test.ts
```

Expected: FAIL because `awaiting_input` is not in the Prisma `RunStatus` type and transitions are not defined.

- [ ] **Step 3: Update Prisma schema**

In `prisma/schema.prisma`, change `RunStatus` to:

```prisma
enum RunStatus {
  queued
  preparing
  running
  awaiting_input
  awaiting_review
  pushing
  completed
  failed
  canceled
  timed_out
}
```

Add these enums after `RunEventType`:

```prisma
enum RunInteractionKind {
  ask_user_question
}

enum RunInteractionStatus {
  pending
  answered
  canceled
}
```

Add this relation field to `model Run`:

```prisma
  interactions    RunInteraction[]
```

Add this model after `RunEvent`:

```prisma
model RunInteraction {
  id         String               @id @default(cuid())
  runId      String
  run        Run                  @relation(fields: [runId], references: [id], onDelete: Cascade)
  kind       RunInteractionKind
  status     RunInteractionStatus @default(pending)
  toolUseId  String
  request    Json
  response   Json?
  createdAt  DateTime             @default(now())
  answeredAt DateTime?

  @@index([runId, status])
  @@map("run_interaction")
}
```

- [ ] **Step 4: Create migration SQL**

Create `prisma/migrations/20260612000000_add_run_interactions/migration.sql` with:

```sql
ALTER TYPE "RunStatus" ADD VALUE 'awaiting_input';

CREATE TYPE "RunInteractionKind" AS ENUM ('ask_user_question');
CREATE TYPE "RunInteractionStatus" AS ENUM ('pending', 'answered', 'canceled');

CREATE TABLE "run_interaction" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" "RunInteractionKind" NOT NULL,
    "status" "RunInteractionStatus" NOT NULL DEFAULT 'pending',
    "toolUseId" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "run_interaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "run_interaction_runId_status_idx" ON "run_interaction"("runId", "status");

CREATE UNIQUE INDEX "run_interaction_one_pending_per_run"
ON "run_interaction"("runId")
WHERE "status" = 'pending';

ALTER TABLE "run_interaction"
ADD CONSTRAINT "run_interaction_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "run"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 5: Generate Prisma client**

Run:

```bash
bunx prisma generate
```

Expected: exit 0 and generated client includes `awaiting_input`, `RunInteractionKind`, and `RunInteractionStatus`.

- [ ] **Step 6: Update run transitions**

Replace the `TRANSITIONS` object in `src/lib/server/run-state.ts` with:

```ts
const TRANSITIONS: Record<RunStatus, RunStatus[]> = {
	queued: ['preparing', 'failed', 'canceled'],
	preparing: ['running', 'failed', 'canceled'],
	running: ['awaiting_input', 'awaiting_review', 'failed', 'canceled', 'timed_out'],
	awaiting_input: ['running', 'failed', 'canceled', 'timed_out'],
	awaiting_review: ['pushing', 'completed', 'canceled'],
	pushing: ['completed', 'failed'],
	completed: [],
	failed: [],
	canceled: [],
	timed_out: []
};
```

Replace `ORPHAN_STATUSES` in `src/lib/server/run-recovery.ts` with:

```ts
export const ORPHAN_STATUSES: RunStatus[] = ['preparing', 'running', 'awaiting_input', 'pushing'];
```

- [ ] **Step 7: Run tests**

Run:

```bash
bun run test:unit -- --run src/lib/server/run-state.test.ts src/lib/server/run-recovery.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260612000000_add_run_interactions/migration.sql src/lib/server/run-state.ts src/lib/server/run-state.test.ts src/lib/server/run-recovery.ts src/lib/server/run-recovery.test.ts
git commit -m "feat(runs): add awaiting input state"
```

---

### Task 2: Pure AskUserQuestion Validation

**Files:**
- Create: `src/lib/schemas/run-interactions.ts`
- Create: `src/lib/schemas/run-interactions.test.ts`

- [ ] **Step 1: Write failing schema tests**

Create `src/lib/schemas/run-interactions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
	OTHER_OPTION_VALUE,
	answerRunInteractionSchema,
	validateAskUserQuestionResponse
} from './run-interactions';

const request = {
	questions: [
		{
			question: 'Which layout?',
			header: 'Layout',
			multiSelect: false,
			options: [
				{ label: 'Compact', description: 'Dense inspector' },
				{ label: 'Split', description: 'Events and side panel' }
			]
		},
		{
			question: 'Which panels?',
			header: 'Panels',
			multiSelect: true,
			options: [
				{ label: 'Todos', description: 'Show current todo state' },
				{ label: 'Diff', description: 'Show diff summary' }
			]
		}
	]
};

describe('answerRunInteractionSchema', () => {
	it('accepts selected answers keyed by question text', () => {
		expect(
			answerRunInteractionSchema.safeParse({
				interactionId: 'i1',
				answers: {
					'Which layout?': { selected: ['Compact'] },
					'Which panels?': { selected: ['Todos', 'Diff'] }
				}
			}).success
		).toBe(true);
	});
});

describe('validateAskUserQuestionResponse', () => {
	it('serializes complete answers into Claude AskUserQuestion output shape', () => {
		const result = validateAskUserQuestionResponse(request, {
			'Which layout?': { selected: ['Compact'] },
			'Which panels?': { selected: ['Todos', 'Diff'] }
		});

		expect(result).toEqual({
			answers: {
				'Which layout?': 'Compact',
				'Which panels?': 'Todos, Diff'
			}
		});
	});

	it('requires every question to be answered', () => {
		expect(() =>
			validateAskUserQuestionResponse(request, {
				'Which layout?': { selected: ['Compact'] }
			})
		).toThrow(/Which panels/);
	});

	it('requires otherText when the Other option is selected', () => {
		expect(() =>
			validateAskUserQuestionResponse(request, {
				'Which layout?': { selected: [OTHER_OPTION_VALUE] },
				'Which panels?': { selected: ['Todos'] }
			})
		).toThrow(/Other/);
	});

	it('uses otherText as the serialized answer', () => {
		const result = validateAskUserQuestionResponse(request, {
			'Which layout?': { selected: [OTHER_OPTION_VALUE], otherText: 'A bottom drawer' },
			'Which panels?': { selected: ['Todos'] }
		});

		expect(result.answers['Which layout?']).toBe('A bottom drawer');
	});

	it('rejects multiple selections for a single-choice question', () => {
		expect(() =>
			validateAskUserQuestionResponse(request, {
				'Which layout?': { selected: ['Compact', 'Split'] },
				'Which panels?': { selected: ['Todos'] }
			})
		).toThrow(/single choice/);
	});
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
bun run test:unit -- --run src/lib/schemas/run-interactions.test.ts
```

Expected: FAIL because `src/lib/schemas/run-interactions.ts` does not exist.

- [ ] **Step 3: Implement schema helpers**

Create `src/lib/schemas/run-interactions.ts`:

```ts
import { z } from 'zod';

export const OTHER_OPTION_VALUE = '__other__';

const askUserOptionSchema = z
	.object({
		label: z.string().min(1),
		description: z.string().min(1),
		preview: z.string().optional()
	})
	.passthrough();

const askUserQuestionItemSchema = z
	.object({
		question: z.string().min(1),
		header: z.string().min(1),
		options: z.array(askUserOptionSchema).min(2).max(4),
		multiSelect: z.boolean()
	})
	.passthrough();

export const askUserQuestionRequestSchema = z
	.object({
		questions: z.array(askUserQuestionItemSchema).min(1).max(4)
	})
	.passthrough();

export type AskUserQuestionRequest = z.infer<typeof askUserQuestionRequestSchema>;

export const questionAnswerSchema = z.object({
	selected: z.array(z.string().min(1)).min(1),
	otherText: z.string().optional()
});

export const answerRunInteractionSchema = z.object({
	interactionId: z.string().min(1),
	answers: z.record(z.string().min(1), questionAnswerSchema),
	response: z.string().optional(),
	annotations: z.record(z.string(), z.record(z.string(), z.unknown())).optional()
});

export type AnswerRunInteractionInput = z.infer<typeof answerRunInteractionSchema>;

export interface SerializedAskUserQuestionResponse {
	answers: Record<string, string>;
	response?: string;
	annotations?: Record<string, unknown>;
}

function requireOtherText(question: string, otherText: string | undefined): string {
	const trimmed = otherText?.trim() ?? '';
	if (!trimmed) throw new Error(`Other answer is required for "${question}"`);
	return trimmed;
}

export function validateAskUserQuestionResponse(
	requestInput: unknown,
	answersInput: AnswerRunInteractionInput['answers'],
	response?: string,
	annotations?: AnswerRunInteractionInput['annotations']
): SerializedAskUserQuestionResponse {
	const request = askUserQuestionRequestSchema.parse(requestInput);
	const out: Record<string, string> = {};

	for (const question of request.questions) {
		const answer = answersInput[question.question];
		if (!answer) throw new Error(`Answer required for "${question.question}"`);

		if (!question.multiSelect && answer.selected.length !== 1) {
			throw new Error(`"${question.question}" is a single choice question`);
		}

		const validLabels = new Set(question.options.map((option) => option.label));
		const values: string[] = [];

		for (const selected of answer.selected) {
			if (selected === OTHER_OPTION_VALUE) {
				values.push(requireOtherText(question.question, answer.otherText));
			} else if (validLabels.has(selected)) {
				values.push(selected);
			} else {
				throw new Error(`Invalid answer "${selected}" for "${question.question}"`);
			}
		}

		out[question.question] = values.join(', ');
	}

	return {
		answers: out,
		...(response?.trim() ? { response: response.trim() } : {}),
		...(annotations ? { annotations } : {})
	};
}
```

- [ ] **Step 4: Run test and verify pass**

Run:

```bash
bun run test:unit -- --run src/lib/schemas/run-interactions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schemas/run-interactions.ts src/lib/schemas/run-interactions.test.ts
git commit -m "feat(runs): validate run interaction answers"
```

---

### Task 3: Run Interaction Server Service And Remote Command

**Files:**
- Create: `src/lib/server/run-interactions-service.ts`
- Create: `src/lib/server/run-interactions-service.test.ts`
- Modify: `src/lib/server/runs-service.ts`
- Modify: `src/lib/server/runs-service.test.ts`
- Modify: `src/lib/rfc/runs.remote.ts`

- [ ] **Step 1: Write service tests**

Create `src/lib/server/run-interactions-service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		$transaction: vi.fn((fn) =>
			fn({
				runInteraction: {
					findFirst: vi.fn(),
					create: vi.fn()
				}
			})
		),
		runInteraction: {
			findFirst: vi.fn(),
			update: vi.fn(),
			findUnique: vi.fn(),
			updateMany: vi.fn()
		}
	}
}));

import { prisma } from '$lib/server/prisma';
import {
	createPendingRunInteraction,
	answerPendingRunInteractionForOrg,
	waitForRunInteractionAnswer,
	PendingRunInteractionError
} from './run-interactions-service';

const request = {
	questions: [
		{
			question: 'Which layout?',
			header: 'Layout',
			multiSelect: false,
			options: [
				{ label: 'Compact', description: 'Dense' },
				{ label: 'Split', description: 'Panel' }
			]
		}
	]
};

describe('run-interactions-service', () => {
	beforeEach(() => vi.clearAllMocks());

	it('creates a pending interaction scoped to a run', async () => {
		const create = vi.fn().mockResolvedValue({ id: 'i1' });
		(prisma.$transaction as any).mockImplementationOnce((fn: any) =>
			fn({
				runInteraction: {
					findFirst: vi.fn().mockResolvedValue(null),
					create
				}
			})
		);

		await createPendingRunInteraction({ runId: 'r1', toolUseId: 'toolu_1', request });

		expect(create).toHaveBeenCalledWith({
			data: {
				runId: 'r1',
				kind: 'ask_user_question',
				status: 'pending',
				toolUseId: 'toolu_1',
				request
			}
		});
	});

	it('rejects creating a second pending interaction for the same run', async () => {
		(prisma.$transaction as any).mockImplementationOnce((fn: any) =>
			fn({
				runInteraction: {
					findFirst: vi.fn().mockResolvedValue({ id: 'existing' }),
					create: vi.fn()
				}
			})
		);

		await expect(
			createPendingRunInteraction({ runId: 'r1', toolUseId: 'toolu_2', request })
		).rejects.toBeInstanceOf(PendingRunInteractionError);
	});

	it('answers a pending interaction and serializes answers for Claude', async () => {
		(prisma.runInteraction.findFirst as any).mockResolvedValue({
			id: 'i1',
			status: 'pending',
			request,
			run: { id: 'r1', status: 'awaiting_input', organizationId: 'org1' }
		});
		(prisma.runInteraction.update as any).mockResolvedValue({
			id: 'i1',
			response: { answers: { 'Which layout?': 'Compact' } }
		});

		const result = await answerPendingRunInteractionForOrg('org1', {
			interactionId: 'i1',
			answers: { 'Which layout?': { selected: ['Compact'] } }
		});

		expect(result?.response).toEqual({ answers: { 'Which layout?': 'Compact' } });
		expect(prisma.runInteraction.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: 'i1' },
				data: expect.objectContaining({ status: 'answered' })
			})
		);
	});

	it('waits until an interaction becomes answered', async () => {
		(prisma.runInteraction.findUnique as any)
			.mockResolvedValueOnce({
				status: 'pending',
				response: null,
				run: { status: 'awaiting_input' }
			})
			.mockResolvedValueOnce({
				status: 'answered',
				response: { answers: { q: 'a' } },
				run: { status: 'running' }
			});

		await expect(
			waitForRunInteractionAnswer('i1', { pollMs: 0, signal: new AbortController().signal })
		).resolves.toEqual({ answers: { q: 'a' } });
	});
});
```

- [ ] **Step 2: Run service test and verify failure**

Run:

```bash
bun run test:unit -- --run src/lib/server/run-interactions-service.test.ts
```

Expected: FAIL because the service file does not exist.

- [ ] **Step 3: Implement service**

Create `src/lib/server/run-interactions-service.ts`:

```ts
import type { Prisma } from '@prisma/client';
import { prisma } from '$lib/server/prisma';
import {
	answerRunInteractionSchema,
	askUserQuestionRequestSchema,
	validateAskUserQuestionResponse,
	type AnswerRunInteractionInput,
	type SerializedAskUserQuestionResponse
} from '$lib/schemas/run-interactions';

export class PendingRunInteractionError extends Error {
	constructor(runId: string) {
		super(`Run ${runId} already has a pending interaction`);
		this.name = 'PendingRunInteractionError';
	}
}

export class RunInteractionAnswerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RunInteractionAnswerError';
	}
}

export async function createPendingRunInteraction(args: {
	runId: string;
	toolUseId: string;
	request: unknown;
}) {
	const request = askUserQuestionRequestSchema.parse(args.request);
	return prisma.$transaction(async (tx) => {
		const existing = await tx.runInteraction.findFirst({
			where: { runId: args.runId, status: 'pending' },
			select: { id: true }
		});
		if (existing) throw new PendingRunInteractionError(args.runId);

		return tx.runInteraction.create({
			data: {
				runId: args.runId,
				kind: 'ask_user_question',
				status: 'pending',
				toolUseId: args.toolUseId,
				request: request as Prisma.InputJsonValue
			}
		});
	});
}

export async function answerPendingRunInteractionForOrg(
	organizationId: string,
	input: AnswerRunInteractionInput
) {
	const parsed = answerRunInteractionSchema.parse(input);
	const interaction = await prisma.runInteraction.findFirst({
		where: { id: parsed.interactionId, run: { organizationId } },
		include: { run: { select: { id: true, projectId: true, status: true, organizationId: true } } }
	});

	if (!interaction) return null;
	if (interaction.status !== 'pending') {
		throw new RunInteractionAnswerError('Interaction has already been answered');
	}
	if (interaction.run.status !== 'awaiting_input') {
		throw new RunInteractionAnswerError(`Run is not awaiting input (status: ${interaction.run.status})`);
	}

	const response = validateAskUserQuestionResponse(
		interaction.request,
		parsed.answers,
		parsed.response,
		parsed.annotations
	);

	const updated = await prisma.runInteraction.update({
		where: { id: interaction.id },
		data: {
			status: 'answered',
			response: response as Prisma.InputJsonValue,
			answeredAt: new Date()
		},
		include: { run: { select: { id: true, projectId: true } } }
	});

	return { interaction: updated, response, runId: updated.run.id, projectId: updated.run.projectId };
}

export async function cancelPendingRunInteractions(runId: string) {
	await prisma.runInteraction.updateMany({
		where: { runId, status: 'pending' },
		data: { status: 'canceled' }
	});
}

export async function waitForRunInteractionAnswer(
	interactionId: string,
	opts: { signal?: AbortSignal; pollMs?: number } = {}
): Promise<SerializedAskUserQuestionResponse> {
	const pollMs = opts.pollMs ?? 1000;

	while (!opts.signal?.aborted) {
		const interaction = await prisma.runInteraction.findUnique({
			where: { id: interactionId },
			select: {
				status: true,
				response: true,
				run: { select: { status: true } }
			}
		});

		if (!interaction) throw new RunInteractionAnswerError('Interaction not found');
		if (interaction.status === 'answered' && interaction.response) {
			return interaction.response as unknown as SerializedAskUserQuestionResponse;
		}
		if (interaction.status === 'canceled') {
			throw new RunInteractionAnswerError('Interaction was canceled');
		}
		if (['failed', 'canceled', 'timed_out'].includes(interaction.run.status)) {
			throw new RunInteractionAnswerError(`Run ended while waiting for input (${interaction.run.status})`);
		}

		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}

	throw new RunInteractionAnswerError('Interaction wait aborted');
}
```

- [ ] **Step 4: Update run service detail include**

In `src/lib/server/runs-service.ts`, change `getRunForOrg` include to:

```ts
include: {
	events: { orderBy: { seq: 'asc' } },
	interactions: {
		where: { status: 'pending' },
		orderBy: { createdAt: 'desc' },
		take: 1
	}
}
```

Update the matching expectation in `src/lib/server/runs-service.test.ts`.

- [ ] **Step 5: Add remote command**

In `src/lib/rfc/runs.remote.ts`, import:

```ts
import { answerRunInteractionSchema } from '$lib/schemas/run-interactions';
import {
	answerPendingRunInteractionForOrg,
	RunInteractionAnswerError
} from '$lib/server/run-interactions-service';
```

Add this command after `cancelRun`:

```ts
export const answerRunInteraction = command(answerRunInteractionSchema, async (input) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);

	try {
		const result = await answerPendingRunInteractionForOrg(organizationId, input);
		if (!result) error(404, 'Interaction not found');
		await getRun(result.runId).refresh();
		await listRuns(result.projectId).refresh();
		return { answered: true };
	} catch (e) {
		if (e instanceof RunInteractionAnswerError) error(400, e.message);
		throw e;
	}
});
```

- [ ] **Step 6: Run tests**

Run:

```bash
bun run test:unit -- --run src/lib/schemas/run-interactions.test.ts src/lib/server/run-interactions-service.test.ts src/lib/server/runs-service.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/schemas/run-interactions.ts src/lib/schemas/run-interactions.test.ts src/lib/server/run-interactions-service.ts src/lib/server/run-interactions-service.test.ts src/lib/server/runs-service.ts src/lib/server/runs-service.test.ts src/lib/rfc/runs.remote.ts
git commit -m "feat(runs): persist and answer run interactions"
```

---

### Task 4: Docker Control Channel

**Files:**
- Modify: `src/lib/server/docker.ts`
- Modify: `src/lib/server/docker.test.ts`

- [ ] **Step 1: Write failing Docker tests**

Add to `buildRunArgs` tests in `src/lib/server/docker.test.ts`:

Update the imports at the top of the file:

```ts
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
```

```ts
it('keeps stdin open for host-to-container control messages', () => {
	const args = buildRunArgs({ image: 'img', name: 'n', workspacePath: '/w', env: {} });
	expect(args).toContain('-i');
});
```

Add a test for `sendControlMessage`:

```ts
it('writes JSON control messages to docker stdin', async () => {
	const child = new EventEmitter() as any;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.stdin = { write: vi.fn() };
	spawn.mockReturnValueOnce(child);

	const { runContainer } = await import('./docker');
	const done = runContainer(['run', 'img'], (_line, control) => {
		control.sendControlMessage({ type: 'interaction_response', toolUseId: 't1' });
	});

	child.stdout.write('{"type":"interaction_request"}\n');
	await new Promise((resolve) => setImmediate(resolve));
	child.emit('close', 0);
	await done;

	expect(child.stdin.write).toHaveBeenCalledWith(
		'{"type":"interaction_response","toolUseId":"t1"}\n'
	);
});
```

- [ ] **Step 2: Run Docker tests and verify failure**

Run:

```bash
bun run test:unit -- --run src/lib/server/docker.test.ts
```

Expected: FAIL because `-i` and `sendControlMessage` are not implemented.

- [ ] **Step 3: Update `buildRunArgs`**

In `src/lib/server/docker.ts`, add `'-i'` immediately after `'run'`:

```ts
const args = [
	'run',
	'-i',
	'--rm',
	'--name',
	spec.name,
```

- [ ] **Step 4: Update `runContainer` signature**

In `src/lib/server/docker.ts`, add these types:

```ts
export interface RunContainerControl {
	sendControlMessage(message: unknown): void;
}

export type RunContainerLineHandler = (
	line: string,
	control: RunContainerControl
) => void | Promise<void>;
```

Change the function signature to:

```ts
export function runContainer(
	args: string[],
	onLine: RunContainerLineHandler,
	options: RunContainerOptions = {},
	onStderr?: (line: string) => void
): Promise<RunContainerResult> {
```

Inside `runContainer`, after spawning the child, add:

```ts
const pending: Promise<void>[] = [];
const control: RunContainerControl = {
	sendControlMessage(message: unknown) {
		child.stdin.write(`${JSON.stringify(message)}\n`);
	}
};
```

Replace `out.on('line', onLine);` with:

```ts
out.on('line', (line) => {
	pending.push(Promise.resolve(onLine(line, control)));
});
```

In the `child.on('close')` handler, wait before resolving:

```ts
child.on('close', async (code) => {
	if (timer) clearTimeout(timer);
	await Promise.allSettled(pending);
	resolve({ exitCode: code ?? -1, timedOut });
});
```

- [ ] **Step 5: Run Docker tests**

Run:

```bash
bun run test:unit -- --run src/lib/server/docker.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/docker.ts src/lib/server/docker.test.ts
git commit -m "feat(runner): add docker stdin control channel"
```

---

### Task 5: Runner Entrypoint AskUserQuestion Intercept

**Files:**
- Modify: `docker/runner/entrypoint.mjs`

- [ ] **Step 1: Add stdin response queue helpers**

In `docker/runner/entrypoint.mjs`, add imports:

```js
import { createInterface } from 'node:readline';
```

Add this code after `emit(obj)`:

```js
const pendingInteractionResolvers = new Map();
const inputLines = createInterface({ input: process.stdin });

inputLines.on('line', (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message?.type !== 'interaction_response' || !message.toolUseId) return;
	const resolver = pendingInteractionResolvers.get(message.toolUseId);
	if (!resolver) return;
	pendingInteractionResolvers.delete(message.toolUseId);
	resolver(message.response);
});

function waitForInteractionResponse(toolUseId, signal) {
	return new Promise((resolve, reject) => {
		const abort = () => {
			pendingInteractionResolvers.delete(toolUseId);
			reject(new Error(`Interaction ${toolUseId} aborted`));
		};
		if (signal?.aborted) return abort();
		pendingInteractionResolvers.set(toolUseId, resolve);
		signal?.addEventListener('abort', abort, { once: true });
	});
}
```

- [ ] **Step 2: Replace `canUseTool`**

Replace the current `canUseTool` option:

```js
canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
```

with:

```js
canUseTool: async (name, input, context) => {
	if (name !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };

	const toolUseId = context?.toolUseID;
	if (!toolUseId) {
		return {
			behavior: 'deny',
			message: 'AskUserQuestion could not be correlated to a tool use id',
			interrupt: true
		};
	}

	emit({
		type: 'interaction_request',
		kind: 'ask_user_question',
		toolUseId,
		request: input
	});

	const response = await waitForInteractionResponse(toolUseId, context?.signal);
	return {
		behavior: 'allow',
		updatedInput: {
			...input,
			answers: response?.answers ?? {},
			...(response?.response ? { response: response.response } : {}),
			...(response?.annotations ? { annotations: response.annotations } : {})
		}
	};
},
```

- [ ] **Step 3: Build runner image locally**

Run:

```bash
bun run runner:build-image
```

Expected: Docker image builds successfully.

- [ ] **Step 4: Commit**

```bash
git add docker/runner/entrypoint.mjs
git commit -m "feat(runner): intercept structured user questions"
```

---

### Task 6: Orchestrator Interaction Flow

**Files:**
- Modify: `src/lib/server/run-orchestrator.ts`
- Create/Modify: `src/lib/server/run-orchestrator.test.ts`

- [ ] **Step 1: Write orchestrator test with mocked dependencies**

Create `src/lib/server/run-orchestrator.test.ts` with a focused mocked test:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		run: {
			findUnique: vi.fn(),
			updateMany: vi.fn()
		}
	}
}));
vi.mock('$lib/server/workspace', () => ({
	ensureMirror: vi.fn(),
	createRunCheckout: vi.fn(),
	getHeadSha: vi.fn()
}));
vi.mock('$lib/server/docker', () => ({
	buildRunArgs: vi.fn(() => ['run', 'img']),
	runContainer: vi.fn()
}));
vi.mock('$lib/server/run-events', () => ({
	appendRunEvent: vi.fn()
}));
vi.mock('$lib/server/github-git', () => ({
	authedCloneUrl: vi.fn((url) => url),
	getGithubTokenForUser: vi.fn(),
	makeGitAuth: vi.fn()
}));
vi.mock('$lib/server/workspace-paths', () => ({
	containerName: vi.fn((id) => `dwrun-${id}`)
}));
vi.mock('$lib/server/run-interactions-service', () => ({
	createPendingRunInteraction: vi.fn(),
	waitForRunInteractionAnswer: vi.fn()
}));

import { prisma } from '$lib/server/prisma';
import { createRunCheckout, ensureMirror, getHeadSha } from '$lib/server/workspace';
import { runContainer } from '$lib/server/docker';
import { appendRunEvent } from '$lib/server/run-events';
import {
	createPendingRunInteraction,
	waitForRunInteractionAnswer
} from '$lib/server/run-interactions-service';
import { executeRun } from './run-orchestrator';

describe('executeRun interactions', () => {
	beforeEach(() => vi.clearAllMocks());

	it('pauses on interaction_request, waits for answer, sends response, and resumes', async () => {
		(prisma.run.findUnique as any).mockResolvedValue({
			id: 'r1',
			projectId: 'p1',
			createdById: 'u1',
			prompt: 'do it',
			model: null,
			sessionId: null,
			timeoutAt: new Date(Date.now() + 60_000),
			project: { id: 'p1', cloneUrl: 'https://github.com/a/b.git', defaultBranch: 'main' }
		});
		(prisma.run.updateMany as any).mockResolvedValue({ count: 1 });
		(ensureMirror as any).mockResolvedValue('/mirror');
		(createRunCheckout as any).mockResolvedValue({ checkoutPath: '/checkout', baseSha: 'base' });
		(getHeadSha as any).mockResolvedValue('head');
		(createPendingRunInteraction as any).mockResolvedValue({ id: 'i1' });
		(waitForRunInteractionAnswer as any).mockResolvedValue({ answers: { q: 'a' } });

		const sent: unknown[] = [];
		(runContainer as any).mockImplementation(async (_args: string[], onLine: any) => {
			await onLine(
				JSON.stringify({
					type: 'interaction_request',
					kind: 'ask_user_question',
					toolUseId: 'toolu_1',
					request: { questions: [] }
				}),
				{ sendControlMessage: (msg: unknown) => sent.push(msg) }
			);
			return { exitCode: 0, timedOut: false };
		});

		await executeRun('r1');

		expect(createPendingRunInteraction).toHaveBeenCalledWith({
			runId: 'r1',
			toolUseId: 'toolu_1',
			request: { questions: [] }
		});
		expect(sent).toEqual([
			{
				type: 'interaction_response',
				toolUseId: 'toolu_1',
				response: { answers: { q: 'a' } }
			}
		]);
		expect(appendRunEvent).toHaveBeenCalledWith(
			'r1',
			0,
			expect.objectContaining({ type: 'interaction_request', interactionId: 'i1' })
		);
		expect(prisma.run.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: 'awaiting_input' }) })
		);
		expect(prisma.run.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: 'running' }) })
		);
	});
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
bun run test:unit -- --run src/lib/server/run-orchestrator.test.ts
```

Expected: FAIL because `executeRun` does not handle `interaction_request`.

- [ ] **Step 3: Implement interaction handling**

In `src/lib/server/run-orchestrator.ts`, import:

```ts
import {
	createPendingRunInteraction,
	waitForRunInteractionAnswer,
	cancelPendingRunInteractions
} from '$lib/server/run-interactions-service';
import type { RunContainerControl } from '$lib/server/docker';
```

Add this helper above `executeRun`:

```ts
function isInteractionRequest(message: SdkMessage): message is SdkMessage & {
	type: 'interaction_request';
	kind: 'ask_user_question';
	toolUseId: string;
	request: unknown;
} {
	return (
		message.type === 'interaction_request' &&
		message.kind === 'ask_user_question' &&
		typeof message.toolUseId === 'string'
	);
}
```

Inside `executeRun`, create an abort controller before `runContainer`:

```ts
const interactionAbort = new AbortController();
```

Replace the current `runContainer` line handler with an async handler:

```ts
async (line, control: RunContainerControl) => {
	let msg: SdkMessage;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}

	if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
		sessionId = (msg as { session_id?: string }).session_id;
	}

	if (isInteractionRequest(msg)) {
		const interaction = await createPendingRunInteraction({
			runId,
			toolUseId: msg.toolUseId,
			request: msg.request
		});
		pending.push(
			appendRunEvent(runId, seq++, {
				...msg,
				interactionId: interaction.id
			}).catch(() => {})
		);
		await transition(runId, 'running', { status: 'awaiting_input' });
		const response = await waitForRunInteractionAnswer(interaction.id, {
			signal: interactionAbort.signal
		});
		control.sendControlMessage({
			type: 'interaction_response',
			toolUseId: msg.toolUseId,
			response
		});
		await transition(runId, 'awaiting_input', { status: 'running' });
		return;
	}

	pending.push(appendRunEvent(runId, seq++, msg).catch(() => {}));
}
```

After `runContainer` returns and before timeout/status handling, abort any outstanding wait:

```ts
interactionAbort.abort();
```

In timeout and non-zero exit branches, call:

```ts
await cancelPendingRunInteractions(runId);
```

In the outer catch transition, include `awaiting_input`:

```ts
await transition(runId, ['queued', 'preparing', 'running', 'awaiting_input'], {
	status: 'failed',
	error: String((err as Error)?.message ?? err),
	finishedAt: new Date()
});
```

- [ ] **Step 4: Run orchestrator test**

Run:

```bash
bun run test:unit -- --run src/lib/server/run-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run related server tests**

Run:

```bash
bun run test:unit -- --run src/lib/server/docker.test.ts src/lib/server/run-interactions-service.test.ts src/lib/server/run-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/run-orchestrator.ts src/lib/server/run-orchestrator.test.ts
git commit -m "feat(runner): pause runs for user input"
```

---

### Task 7: Todo Projection And Event Normalization

**Files:**
- Create: `src/lib/components/runs/todos.ts`
- Create: `src/lib/components/runs/todos.test.ts`
- Modify: `src/lib/components/runs/run-event-display.ts`
- Modify: `src/lib/components/runs/run-event-display.test.ts`

- [ ] **Step 1: Write todo projection tests**

Create `src/lib/components/runs/todos.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractCurrentTodos } from './todos';

describe('extractCurrentTodos', () => {
	it('returns the latest TodoWrite list from assistant tool_use events', () => {
		const events = [
			{
				payload: {
					type: 'assistant',
					message: {
						content: [
							{
								type: 'tool_use',
								name: 'TodoWrite',
								input: {
									todos: [
										{ content: 'Old task', status: 'pending', activeForm: 'Working old task' }
									]
								}
							}
						]
					}
				}
			},
			{
				payload: {
					type: 'assistant',
					message: {
						content: [
							{
								type: 'tool_use',
								name: 'TodoWrite',
								input: {
									todos: [
										{ content: 'Current', status: 'in_progress', activeForm: 'Doing current' },
										{ content: 'Done', status: 'completed', activeForm: 'Did done' }
									]
								}
							}
						]
					}
				}
			}
		];

		expect(extractCurrentTodos(events)).toEqual([
			{ content: 'Current', status: 'in_progress', activeForm: 'Doing current' },
			{ content: 'Done', status: 'completed', activeForm: 'Did done' }
		]);
	});

	it('returns an empty list when no TodoWrite exists', () => {
		expect(extractCurrentTodos([{ payload: { type: 'assistant', message: { content: [] } } }])).toEqual([]);
	});
});
```

- [ ] **Step 2: Add run-event test for internal interaction events**

Add this to `src/lib/components/runs/run-event-display.test.ts`:

```ts
it('hides internal interaction_request events', () => {
	expect(normalizeEvent({ type: 'interaction_request', interactionId: 'i1' })).toEqual([
		{ kind: 'hidden' }
	]);
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
bun run test:unit -- --run src/lib/components/runs/todos.test.ts src/lib/components/runs/run-event-display.test.ts
```

Expected: FAIL because `todos.ts` does not exist and interaction events are raw.

- [ ] **Step 4: Implement todo projection**

Create `src/lib/components/runs/todos.ts`:

```ts
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
	content: string;
	status: TodoStatus;
	activeForm: string;
}

interface AnyObj {
	[k: string]: unknown;
}

function asObj(value: unknown): AnyObj {
	return value && typeof value === 'object' ? (value as AnyObj) : {};
}

function normalizeTodo(value: unknown): TodoItem | null {
	const todo = asObj(value);
	const status = todo.status;
	if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null;
	if (typeof todo.content !== 'string') return null;
	return {
		content: todo.content,
		status,
		activeForm: typeof todo.activeForm === 'string' ? todo.activeForm : todo.content
	};
}

export function extractCurrentTodos(events: Array<{ payload: unknown }>): TodoItem[] {
	let current: TodoItem[] = [];

	for (const event of events) {
		const payload = asObj(event.payload);
		if (payload.type !== 'assistant') continue;
		const content = asObj(payload.message).content;
		if (!Array.isArray(content)) continue;

		for (const item of content) {
			const block = asObj(item);
			if (block.type !== 'tool_use' || block.name !== 'TodoWrite') continue;
			const todos = asObj(block.input).todos;
			if (!Array.isArray(todos)) continue;
			current = todos.flatMap((todo) => {
				const normalized = normalizeTodo(todo);
				return normalized ? [normalized] : [];
			});
		}
	}

	return current;
}
```

- [ ] **Step 5: Hide interaction_request in normalizer**

In `src/lib/components/runs/run-event-display.ts`, before the final `return [{ kind: 'raw', ... }]`, add:

```ts
if (type === 'interaction_request') return [{ kind: 'hidden' }];
```

- [ ] **Step 6: Run tests**

Run:

```bash
bun run test:unit -- --run src/lib/components/runs/todos.test.ts src/lib/components/runs/run-event-display.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/components/runs/todos.ts src/lib/components/runs/todos.test.ts src/lib/components/runs/run-event-display.ts src/lib/components/runs/run-event-display.test.ts
git commit -m "feat(runs): derive current todo list"
```

---

### Task 8: Svelte Interaction And Todo Components

**Files:**
- Create: `src/lib/components/runs/AskUserQuestionCard.svelte`
- Create: `src/lib/components/runs/CurrentTodos.svelte`

- [ ] **Step 1: Create `CurrentTodos.svelte`**

Create `src/lib/components/runs/CurrentTodos.svelte`:

```svelte
<script lang="ts">
	import { Circle, CircleCheck, LoaderCircle } from '@lucide/svelte';
	import type { TodoItem, TodoStatus } from './todos';

	let { todos }: { todos: TodoItem[] } = $props();

	const ordered = $derived(
		[...todos].sort((a, b) => {
			const rank: Record<TodoStatus, number> = { in_progress: 0, pending: 1, completed: 2 };
			return rank[a.status] - rank[b.status];
		})
	);
</script>

<aside class="rounded-md border bg-card p-3">
	<h2 class="mb-2 text-sm font-medium">Plan actuel</h2>
	{#if ordered.length === 0}
		<p class="text-sm text-muted-foreground">Aucune todo active.</p>
	{:else}
		<ul class="space-y-2">
			{#each ordered as todo, index (`${todo.status}-${todo.content}-${index}`)}
				<li class="flex gap-2 text-sm">
					{#if todo.status === 'completed'}
						<CircleCheck class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
					{:else if todo.status === 'in_progress'}
						<LoaderCircle class="mt-0.5 h-4 w-4 shrink-0 text-primary" />
					{:else}
						<Circle class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
					{/if}
					<span class={todo.status === 'completed' ? 'text-muted-foreground line-through' : ''}>
						{todo.activeForm || todo.content}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</aside>
```

- [ ] **Step 2: Create `AskUserQuestionCard.svelte`**

Create `src/lib/components/runs/AskUserQuestionCard.svelte`:

```svelte
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { OTHER_OPTION_VALUE } from '$lib/schemas/run-interactions';

	type QuestionOption = { label: string; description: string; preview?: string };
	type Question = {
		question: string;
		header: string;
		options: QuestionOption[];
		multiSelect: boolean;
	};
	type Interaction = {
		id: string;
		request: { questions: Question[] };
	};
	type DraftAnswer = { selected: string[]; otherText: string };

	let {
		interaction,
		busy = false,
		error = null,
		onsubmit
	}: {
		interaction: Interaction;
		busy?: boolean;
		error?: string | null;
		onsubmit: (answers: Record<string, { selected: string[]; otherText?: string }>) => void;
	} = $props();

	let answers = $state<Record<string, DraftAnswer>>({});
	let currentInteractionId = $state('');

	$effect(() => {
		if (currentInteractionId === interaction.id) return;
		currentInteractionId = interaction.id;
		const next: Record<string, DraftAnswer> = {};
		for (const question of interaction.request.questions) {
			next[question.question] = { selected: [], otherText: '' };
		}
		answers = next;
	});

	function toggle(question: Question, value: string) {
		const current = answers[question.question] ?? { selected: [], otherText: '' };
		if (question.multiSelect) {
			const selected = current.selected.includes(value)
				? current.selected.filter((item) => item !== value)
				: [...current.selected, value];
			answers = { ...answers, [question.question]: { ...current, selected } };
		} else {
			answers = { ...answers, [question.question]: { ...current, selected: [value] } };
		}
	}

	function setOtherText(question: Question, otherText: string) {
		const current = answers[question.question] ?? { selected: [], otherText: '' };
		answers = { ...answers, [question.question]: { ...current, otherText } };
	}

	function isComplete(question: Question) {
		const answer = answers[question.question];
		if (!answer || answer.selected.length === 0) return false;
		if (!question.multiSelect && answer.selected.length !== 1) return false;
		if (answer.selected.includes(OTHER_OPTION_VALUE) && answer.otherText.trim().length === 0) {
			return false;
		}
		return true;
	}

	const complete = $derived(interaction.request.questions.every(isComplete));

	function submit() {
		if (!complete || busy) return;
		const payload: Record<string, { selected: string[]; otherText?: string }> = {};
		for (const [question, answer] of Object.entries(answers)) {
			payload[question] = {
				selected: answer.selected,
				...(answer.otherText.trim() ? { otherText: answer.otherText.trim() } : {})
			};
		}
		onsubmit(payload);
	}
</script>

<section class="rounded-md border border-primary/30 bg-card p-4 shadow-sm">
	<div class="mb-4">
		<p class="text-xs font-medium tracking-wide text-primary uppercase">Question de l'IA</p>
		<h2 class="text-base font-semibold">Reponse requise pour continuer le run</h2>
	</div>

	<div class="space-y-4">
		{#each interaction.request.questions as question (question.question)}
			{@const answer = answers[question.question] ?? { selected: [], otherText: '' }}
			<div class="space-y-2">
				<div>
					<p class="text-xs font-medium text-muted-foreground">{question.header}</p>
					<p class="text-sm font-medium">{question.question}</p>
				</div>

				<div class="grid gap-2">
					{#each [...question.options, { label: OTHER_OPTION_VALUE, description: 'Reponse libre' }] as option (option.label)}
						<label
							class={[
								'flex cursor-pointer gap-2 rounded-md border p-2 text-sm transition-colors',
								answer.selected.includes(option.label) && 'border-primary bg-primary/5'
							]}
						>
							<input
								type={question.multiSelect ? 'checkbox' : 'radio'}
								name={question.question}
								checked={answer.selected.includes(option.label)}
								onchange={() => toggle(question, option.label)}
							/>
							<span>
								<span class="block font-medium">
									{option.label === OTHER_OPTION_VALUE ? 'Autre' : option.label}
								</span>
								<span class="block text-xs text-muted-foreground">{option.description}</span>
							</span>
						</label>
					{/each}
				</div>

				{#if answer.selected.includes(OTHER_OPTION_VALUE)}
					<textarea
						class="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
						aria-label="Precise ta reponse"
						value={answer.otherText}
						oninput={(event) => setOtherText(question, event.currentTarget.value)}
					></textarea>
				{/if}
			</div>
		{/each}
	</div>

	{#if error}
		<p class="mt-3 text-sm text-destructive">{error}</p>
	{/if}

	<div class="mt-4 flex justify-end">
		<Button onclick={submit} disabled={!complete || busy}>
			{busy ? 'Reprise...' : 'Repondre et reprendre'}
		</Button>
	</div>
</section>
```

- [ ] **Step 3: Run Svelte autofixer**

Run `mcp__svelte.svelte_autofixer` on both component contents with:

- `filename: "CurrentTodos.svelte"`, `desired_svelte_version: 5`
- `filename: "AskUserQuestionCard.svelte"`, `desired_svelte_version: 5`

Expected: no issues or suggestions. If it returns fixes, apply them and run the autofixer again until it returns clean.

- [ ] **Step 4: Run Svelte check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/runs/AskUserQuestionCard.svelte src/lib/components/runs/CurrentTodos.svelte
git commit -m "feat(runs): render run input and todos"
```

---

### Task 9: Wire Run Page

**Files:**
- Modify: `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`

- [ ] **Step 1: Update imports**

Add:

```ts
import AskUserQuestionCard from '$lib/components/runs/AskUserQuestionCard.svelte';
import CurrentTodos from '$lib/components/runs/CurrentTodos.svelte';
import { answerRunInteraction } from '$lib/rfc/runs.remote';
import { extractCurrentTodos } from '$lib/components/runs/todos';
```

- [ ] **Step 2: Add state and answer handler**

Add near existing state:

```ts
let answering = $state(false);
let answerError = $state<string | null>(null);
```

Add handler:

```ts
async function answerInteraction(
	interactionId: string,
	answers: Record<string, { selected: string[]; otherText?: string }>
) {
	answering = true;
	answerError = null;
	try {
		await answerRunInteraction({ interactionId, answers });
		liveEvents = [];
		await getRun(page.params.runId!).refresh();
	} catch (e) {
		answerError = e instanceof Error ? e.message : 'Could not answer the interaction';
	} finally {
		answering = false;
	}
}
```

- [ ] **Step 3: Treat awaiting_input as active**

Change:

```ts
const ACTIVE = ['queued', 'preparing', 'running', 'pushing'];
```

to:

```ts
const ACTIVE = ['queued', 'preparing', 'running', 'awaiting_input', 'pushing'];
```

Change:

```ts
const ACTIVE_CANCELABLE = ['queued', 'preparing', 'running'];
```

to:

```ts
const ACTIVE_CANCELABLE = ['queued', 'preparing', 'running', 'awaiting_input'];
```

- [ ] **Step 4: Refresh on interaction_request SSE**

Inside `es.onmessage`, after parsing `payload`, add:

```ts
if (
	payload &&
	typeof payload === 'object' &&
	'type' in payload &&
	payload.type === 'interaction_request'
) {
	getRun(runId).refresh();
}
```

- [ ] **Step 5: Derive current todos and active interaction**

Add:

```ts
type ActiveInteraction = {
	id: string;
	request: {
		questions: Array<{
			question: string;
			header: string;
			options: Array<{ label: string; description: string; preview?: string }>;
			multiSelect: boolean;
		}>;
	};
};

const persistedEvents = $derived((run.current?.events ?? []).map((event) => ({ payload: event.payload })));
const todoEvents = $derived(
	liveEvents.length > 0 ? liveEvents.map((event) => ({ payload: event.payload })) : persistedEvents
);
const currentTodos = $derived(extractCurrentTodos(todoEvents));
const activeInteraction = $derived(
	(run.current?.interactions?.[0] ?? null) as ActiveInteraction | null
);
```

- [ ] **Step 6: Render layout**

Replace the top-level content wrapper class:

```svelte
<div class="mx-auto max-w-3xl space-y-4 p-6">
```

with:

```svelte
<div class="mx-auto grid max-w-6xl gap-4 p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
```

Wrap the existing run details/events content in:

```svelte
<main class="space-y-4">
	<!-- existing run detail sections -->
</main>
```

Add the side panel before closing the outer grid:

```svelte
{#if run.current}
	<aside class="space-y-4 lg:sticky lg:top-4 lg:self-start">
		{#if activeInteraction}
			<AskUserQuestionCard
				interaction={activeInteraction}
				busy={answering}
				error={answerError}
				onsubmit={(answers) => answerInteraction(activeInteraction.id, answers)}
			/>
		{/if}
		<CurrentTodos todos={currentTodos} />
	</aside>
{/if}
```

- [ ] **Step 7: Run Svelte autofixer**

Run `mcp__svelte.svelte_autofixer` on `+page.svelte` with `desired_svelte_version: 5` and `async: true`.

Expected: no issues or suggestions. Apply fixes and rerun until clean.

- [ ] **Step 8: Run check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add 'src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte'
git commit -m "feat(runs): wire interactive run page"
```

---

### Task 10: End-To-End Verification Slice

**Files:**
- No required file changes unless verification exposes bugs.

- [ ] **Step 1: Run focused unit suite**

Run:

```bash
bun run test:unit -- --run \
	src/lib/schemas/run-interactions.test.ts \
	src/lib/server/run-interactions-service.test.ts \
	src/lib/server/run-state.test.ts \
	src/lib/server/run-recovery.test.ts \
	src/lib/server/docker.test.ts \
	src/lib/server/run-orchestrator.test.ts \
	src/lib/components/runs/todos.test.ts \
	src/lib/components/runs/run-event-display.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full project check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 3: Run full unit test suite**

Run:

```bash
bun run test:unit -- --run
```

Expected: PASS.

- [ ] **Step 4: Build runner image**

Run:

```bash
bun run runner:build-image
```

Expected: Docker build exits 0.

- [ ] **Step 5: Manual smoke**

Start the app and runner in separate shells:

```bash
bun run dev
bun run runner
```

Use an imported project and launch a run whose prompt encourages Claude Code to ask one structured question through Superpowers. Expected behavior:

- run enters `awaiting_input`;
- the run page shows one active question block;
- answering all questions resumes the same run;
- the run continues producing events;
- the current todo panel updates after `TodoWrite`.

- [ ] **Step 6: Commit verification-only fixes**

If verification required fixes:

```bash
git add <changed-files>
git commit -m "fix(runs): stabilize interactive run flow"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review Checklist

- Spec coverage:
  - `awaiting_input` status: Task 1.
  - one pending interaction per run: Tasks 1 and 3.
  - AskUserQuestion-only capture: Tasks 2, 5, 6.
  - complete response with Other: Tasks 2 and 8.
  - DB-backed web-to-worker handoff: Tasks 3 and 6.
  - current todo projection only: Tasks 7 and 9.
  - Svelte UI: Tasks 8 and 9.
  - verification: Task 10.
- Placeholder scan:
  - Red-flag planning markers and copied-task shortcuts have been removed.
- Type consistency:
  - `interactionId`, `answers`, `response`, `annotations`, `toolUseId`, `RunInteraction.status`, and `awaiting_input` are used consistently across schema, service, runner, and UI tasks.
