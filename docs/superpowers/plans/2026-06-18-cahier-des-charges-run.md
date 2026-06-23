# Cahier Des Charges Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CDC run mode that guides an agent through cahier-des-charges drafting, lets the user validate a marked Markdown draft as a dotWeaver artifact, and keeps the run continuable afterward.

**Architecture:** Add a small run-mode domain layer and a CDC document domain extractor, then persist validated CDC artifacts in a new Prisma model linked to project, run, organization, and user. Server services own extraction, authorization, idempotent version creation, and skill checks; remote functions expose the workflow; Svelte pages reuse the existing run composer and Markdown renderer.

**Tech Stack:** SvelteKit 2 remote functions, Svelte 5 runes, Prisma/PostgreSQL, Zod, Vitest, Bun, existing shadcn-svelte UI components.

---

## File Structure

- Create `src/lib/domain/run-mode.ts`: constants for `agent` and `cdc`, CDC skill name, CDC prompt prefix, and prompt builder.
- Create `src/lib/domain/cdc-document.ts`: pure CDC draft extraction, title derivation, marker stripping, and size validation.
- Create `tests/unit/lib/domain/run-mode.test.ts`: tests for prompt wrapping and mode constants.
- Create `tests/unit/lib/domain/cdc-document.test.ts`: tests for marker extraction and validation.
- Modify `prisma/schema.prisma`: add `RunMode`, `Run.mode`, relations, and `CdcDocument`.
- Create `prisma/migrations/20260618000000_add_cdc_documents/migration.sql`: PostgreSQL enum/table/index migration.
- Create `src/lib/server/cdc-documents-service.ts`: list/get/validate CDC documents and check required skill presence.
- Create `tests/unit/lib/server/cdc-documents-service.test.ts`: mocked Prisma tests for idempotency, versions, guards, and skill check.
- Modify `src/lib/schemas/runs.ts`: add `mode` to `startRunSchema`.
- Modify `src/lib/rfc/runs.remote.ts`: validate CDC mode, set `Run.mode`, enforce skill presence, refresh CDC lists.
- Modify `src/lib/server/run-orchestrator.ts`: pass the CDC preprompt only for fresh CDC runs.
- Modify `src/lib/server/runs-service.ts`: include `mode` and CDC document metadata in run list/detail.
- Create `src/lib/schemas/cdc-documents.ts`: remote function schemas.
- Create `src/lib/rfc/cdc-documents.remote.ts`: `listCdcDocuments`, `getCdcDocument`, `validateRunCdc`.
- Create `tests/unit/lib/rfc/cdc-documents.remote.test.ts`: remote function authorization/error mapping tests.
- Modify `src/routes/(app)/projects/[id]/+page.svelte`: add mode selector, CDC prompt copy, and CDC document list.
- Modify `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`: show CDC draft preview and validation action.
- Create `src/routes/(app)/projects/[id]/cdc/[cdcId]/+page.svelte`: render a validated CDC document.

---

### Task 1: Domain Constants And CDC Extraction

**Files:**
- Create: `src/lib/domain/run-mode.ts`
- Create: `src/lib/domain/cdc-document.ts`
- Test: `tests/unit/lib/domain/run-mode.test.ts`
- Test: `tests/unit/lib/domain/cdc-document.test.ts`

- [ ] **Step 1: Write failing tests for run mode prompt wrapping**

Create `tests/unit/lib/domain/run-mode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	CDC_SKILL_NAME,
	RUN_MODE,
	buildEffectiveRunPrompt,
	isRunMode
} from '../../../../src/lib/domain/run-mode';

describe('run-mode domain', () => {
	it('exposes stable run mode constants', () => {
		expect(RUN_MODE.AGENT).toBe('agent');
		expect(RUN_MODE.CDC).toBe('cdc');
		expect(CDC_SKILL_NAME).toBe('cahier-des-charges');
		expect(isRunMode('agent')).toBe(true);
		expect(isRunMode('cdc')).toBe(true);
		expect(isRunMode('other')).toBe(false);
	});

	it('leaves normal agent prompts untouched', () => {
		expect(buildEffectiveRunPrompt('agent', 'Build the login screen')).toBe(
			'Build the login screen'
		);
	});

	it('wraps fresh cdc prompts with the dotWeaver contract', () => {
		const prompt = buildEffectiveRunPrompt('cdc', 'Je veux cadrer un CRM');

		expect(prompt).toContain('run dotWeaver de type Cahier des charges');
		expect(prompt).toContain('Utilise le skill cahier-des-charges');
		expect(prompt).toContain('<!-- dotweaver:cdc:start -->');
		expect(prompt).toContain('<!-- dotweaver:cdc:end -->');
		expect(prompt).toContain('Je veux cadrer un CRM');
	});
});
```

- [ ] **Step 2: Write failing tests for CDC draft extraction**

Create `tests/unit/lib/domain/cdc-document.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	CDC_MARKER_END,
	CDC_MARKER_START,
	MAX_CDC_MARKDOWN_LENGTH,
	CdcDocumentError,
	extractLatestCdcDraft,
	validateCdcMarkdown
} from '../../../../src/lib/domain/cdc-document';

const assistantEvent = (seq: number, text: string) => ({
	seq,
	payload: {
		type: 'assistant',
		message: {
			content: [{ type: 'text', text }]
		}
	}
});

describe('cdc-document domain', () => {
	it('extracts the latest complete marked CDC draft', () => {
		const first = `${CDC_MARKER_START}\n# First\n\nOld body\n${CDC_MARKER_END}`;
		const second = `${CDC_MARKER_START}\n# Second\n\nNew body\n${CDC_MARKER_END}`;

		const draft = extractLatestCdcDraft([
			assistantEvent(1, first),
			assistantEvent(2, `${CDC_MARKER_START}\n# Broken`),
			assistantEvent(3, second)
		]);

		expect(draft).toEqual({
			sourceEventSeq: 3,
			title: 'Second',
			markdown: '# Second\n\nNew body'
		});
	});

	it('returns null when no complete marked block exists', () => {
		expect(extractLatestCdcDraft([assistantEvent(1, `${CDC_MARKER_START}\n# Missing end`)])).toBe(
			null
		);
	});

	it('uses a fallback title when the draft has no h1', () => {
		const draft = extractLatestCdcDraft([
			assistantEvent(4, `${CDC_MARKER_START}\nNo h1 here\n${CDC_MARKER_END}`)
		]);

		expect(draft?.title).toBe('Cahier des charges');
		expect(draft?.markdown).toBe('No h1 here');
	});

	it('rejects empty and oversized markdown', () => {
		expect(() => validateCdcMarkdown('')).toThrow(CdcDocumentError);
		expect(() => validateCdcMarkdown('x'.repeat(MAX_CDC_MARKDOWN_LENGTH + 1))).toThrow(
			CdcDocumentError
		);
	});
});
```

- [ ] **Step 3: Run the domain tests and verify they fail**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/domain/run-mode.test.ts tests/unit/lib/domain/cdc-document.test.ts
```

Expected: FAIL because `src/lib/domain/run-mode.ts` and `src/lib/domain/cdc-document.ts` do not exist.

- [ ] **Step 4: Implement run mode domain helpers**

Create `src/lib/domain/run-mode.ts`:

```ts
export const RUN_MODE = {
	AGENT: 'agent',
	CDC: 'cdc'
} as const;

export type RunMode = (typeof RUN_MODE)[keyof typeof RUN_MODE];

export const CDC_SKILL_NAME = 'cahier-des-charges';

export const CDC_RUN_PROMPT_PREFIX = `Tu es dans une run dotWeaver de type Cahier des charges.
Utilise le skill cahier-des-charges pour conduire le cadrage.
Clarifie les objectifs, utilisateurs, parcours, contraintes, donnees, integrations, risques, criteres d'acceptation et hors-perimetre.
Pose les questions necessaires jusqu'a obtenir un accord explicite.
Quand tous les aspects importants sont stabilises, produis une proposition Markdown complete de CDC entre ces marqueurs exacts :
<!-- dotweaver:cdc:start -->
<!-- dotweaver:cdc:end -->
La validation du CDC par l'utilisateur est un checkpoint, pas la fin obligatoire de la run. Apres validation, tu peux continuer la conversation sur demande.`;

export function isRunMode(value: unknown): value is RunMode {
	return value === RUN_MODE.AGENT || value === RUN_MODE.CDC;
}

export function buildEffectiveRunPrompt(mode: RunMode, prompt: string): string {
	if (mode !== RUN_MODE.CDC) return prompt;
	return `${CDC_RUN_PROMPT_PREFIX}\n\nPrompt utilisateur :\n${prompt}`;
}
```

- [ ] **Step 5: Implement CDC draft extraction**

Create `src/lib/domain/cdc-document.ts`:

```ts
export const CDC_MARKER_START = '<!-- dotweaver:cdc:start -->';
export const CDC_MARKER_END = '<!-- dotweaver:cdc:end -->';
export const MAX_CDC_MARKDOWN_LENGTH = 120_000;
const DEFAULT_CDC_TITLE = 'Cahier des charges';

export class CdcDocumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CdcDocumentError';
	}
}

export type CdcDraftEvent = {
	seq: number;
	payload: unknown;
};

export type ExtractedCdcDraft = {
	sourceEventSeq: number;
	title: string;
	markdown: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function extractTextFromPayload(payload: unknown): string {
	const record = asRecord(payload);
	if (!record) return '';

	const directText = record.text;
	if (typeof directText === 'string') return directText;

	const message = asRecord(record.message);
	const content = Array.isArray(message?.content) ? message.content : [];
	return content
		.map((item) => {
			const itemRecord = asRecord(item);
			return typeof itemRecord?.text === 'string' ? itemRecord.text : '';
		})
		.filter(Boolean)
		.join('\n');
}

function lastMarkedBlock(text: string): string | null {
	const start = text.lastIndexOf(CDC_MARKER_START);
	if (start < 0) return null;
	const bodyStart = start + CDC_MARKER_START.length;
	const end = text.indexOf(CDC_MARKER_END, bodyStart);
	if (end < 0) return null;
	return text.slice(bodyStart, end);
}

export function validateCdcMarkdown(markdown: string): string {
	const normalized = markdown.trim();
	if (normalized.length === 0) {
		throw new CdcDocumentError('CDC markdown is empty');
	}
	if (normalized.length > MAX_CDC_MARKDOWN_LENGTH) {
		throw new CdcDocumentError(
			`CDC markdown is too large; max is ${MAX_CDC_MARKDOWN_LENGTH} characters`
		);
	}
	return normalized;
}

export function titleFromCdcMarkdown(markdown: string): string {
	const h1 = markdown
		.split('\n')
		.map((line) => line.trim())
		.find((line) => line.startsWith('# ') && line.slice(2).trim().length > 0);
	return h1 ? h1.slice(2).trim().slice(0, 160) : DEFAULT_CDC_TITLE;
}

export function extractLatestCdcDraft(events: CdcDraftEvent[]): ExtractedCdcDraft | null {
	for (const event of [...events].sort((a, b) => b.seq - a.seq)) {
		const text = extractTextFromPayload(event.payload);
		const block = lastMarkedBlock(text);
		if (!block) continue;
		const markdown = validateCdcMarkdown(block);
		return {
			sourceEventSeq: event.seq,
			title: titleFromCdcMarkdown(markdown),
			markdown
		};
	}
	return null;
}
```

- [ ] **Step 6: Run the domain tests and verify they pass**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/domain/run-mode.test.ts tests/unit/lib/domain/cdc-document.test.ts
```

Expected: PASS for both domain test files.

- [ ] **Step 7: Commit domain helpers**

Run:

```bash
git add src/lib/domain/run-mode.ts src/lib/domain/cdc-document.ts tests/unit/lib/domain/run-mode.test.ts tests/unit/lib/domain/cdc-document.test.ts
git commit -m "feat(cdc): add run mode and draft extraction"
```

---

### Task 2: Prisma Model And Migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260618000000_add_cdc_documents/migration.sql`

- [ ] **Step 1: Update Prisma schema**

Modify `prisma/schema.prisma`:

```prisma
enum RunMode {
  agent
  cdc
}
```

Add CDC relations:

```prisma
model User {
  cdcDocuments CdcDocument[]
}

model Project {
  cdcDocuments CdcDocument[]
}

model Run {
  mode         RunMode       @default(agent)
  cdcDocuments CdcDocument[]
}
```

Add the new model near `PullRequest`:

```prisma
model CdcDocument {
  id             String   @id @default(cuid())
  organizationId String
  projectId      String
  project        Project  @relation(fields: [projectId, organizationId], references: [id, organizationId], onDelete: Cascade)
  runId          String
  run            Run      @relation(fields: [runId], references: [id], onDelete: Cascade)
  createdById    String
  createdBy      User     @relation(fields: [createdById], references: [id], onDelete: Cascade)
  title          String
  markdown       String
  version        Int
  sourceEventSeq Int
  createdAt      DateTime @default(now())

  @@unique([projectId, version])
  @@unique([runId, sourceEventSeq])
  @@index([organizationId, projectId])
  @@index([runId])
  @@map("cdc_document")
}
```

- [ ] **Step 2: Add migration SQL**

Create `prisma/migrations/20260618000000_add_cdc_documents/migration.sql`:

```sql
CREATE TYPE "RunMode" AS ENUM ('agent', 'cdc');

ALTER TABLE "run"
ADD COLUMN "mode" "RunMode" NOT NULL DEFAULT 'agent';

CREATE TABLE "cdc_document" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sourceEventSeq" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cdc_document_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cdc_document_projectId_version_key"
ON "cdc_document"("projectId", "version");

CREATE UNIQUE INDEX "cdc_document_runId_sourceEventSeq_key"
ON "cdc_document"("runId", "sourceEventSeq");

CREATE INDEX "cdc_document_organizationId_projectId_idx"
ON "cdc_document"("organizationId", "projectId");

CREATE INDEX "cdc_document_runId_idx"
ON "cdc_document"("runId");

ALTER TABLE "cdc_document"
ADD CONSTRAINT "cdc_document_projectId_organizationId_fkey"
FOREIGN KEY ("projectId", "organizationId")
REFERENCES "project"("id", "organizationId")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cdc_document"
ADD CONSTRAINT "cdc_document_runId_fkey"
FOREIGN KEY ("runId")
REFERENCES "run"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cdc_document"
ADD CONSTRAINT "cdc_document_createdById_fkey"
FOREIGN KEY ("createdById")
REFERENCES "user"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Regenerate Prisma client**

Run:

```bash
bunx prisma generate
```

Expected: command exits 0 and regenerates `node_modules/.prisma/client`.

- [ ] **Step 4: Run type check for schema fallout**

Run:

```bash
bun run check
```

Expected: FAIL only where code still assumes `Run` has no `mode` or `cdcDocuments`; fix those in later tasks.

- [ ] **Step 5: Commit schema and migration**

Run:

```bash
git add prisma/schema.prisma prisma/migrations/20260618000000_add_cdc_documents/migration.sql
git commit -m "feat(cdc): add document persistence schema"
```

---

### Task 3: CDC Document Service

**Files:**
- Create: `src/lib/server/cdc-documents-service.ts`
- Test: `tests/unit/lib/server/cdc-documents-service.test.ts`

- [ ] **Step 1: Write service tests**

Create `tests/unit/lib/server/cdc-documents-service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { RUN_STATUS } from '../../../../src/lib/domain/run-status';
import { RUN_MODE } from '../../../../src/lib/domain/run-mode';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		projectSkill: { findFirst: vi.fn() },
		cdcDocument: {
			findMany: vi.fn(),
			findFirst: vi.fn()
		},
		run: { findFirst: vi.fn() },
		$transaction: vi.fn()
	}
}));

const { prisma } = await import('../../../../src/lib/server/prisma');
const {
	CdcDocumentServiceError,
	assertCdcSkillEnabledForOrg,
	listCdcDocumentsForOrg,
	validateRunCdcForOrg
} = await import('../../../../src/lib/server/cdc-documents-service');

const runFindFirst = prisma.run.findFirst as unknown as Mock;
const transaction = prisma.$transaction as unknown as Mock;

function assistantEvent(seq: number, markdown: string) {
	return {
		seq,
		payload: {
			type: 'assistant',
			message: {
				content: [
					{
						type: 'text',
						text: `<!-- dotweaver:cdc:start -->\n${markdown}\n<!-- dotweaver:cdc:end -->`
					}
				]
			}
		}
	};
}

describe('cdc-documents-service', () => {
	beforeEach(() => vi.clearAllMocks());

	it('checks for an enabled CDC skill in the project', async () => {
		vi.mocked(prisma.projectSkill.findFirst).mockResolvedValueOnce({ id: 'skill_1' } as never);

		await expect(assertCdcSkillEnabledForOrg('org_1', 'project_1')).resolves.toBeUndefined();
		expect(prisma.projectSkill.findFirst).toHaveBeenCalledWith({
			where: {
				organizationId: 'org_1',
				projectId: 'project_1',
				name: 'cahier-des-charges',
				enabled: true
			},
			select: { id: true }
		});
	});

	it('rejects CDC runs when the skill is missing', async () => {
		vi.mocked(prisma.projectSkill.findFirst).mockResolvedValueOnce(null as never);

		await expect(assertCdcSkillEnabledForOrg('org_1', 'project_1')).rejects.toThrow(
			CdcDocumentServiceError
		);
	});

	it('lists CDC documents for a project in version order', async () => {
		vi.mocked(prisma.cdcDocument.findMany).mockResolvedValueOnce([{ id: 'cdc_2' }] as never);

		await expect(listCdcDocumentsForOrg('org_1', 'project_1')).resolves.toEqual([
			{ id: 'cdc_2' }
		]);
		expect(prisma.cdcDocument.findMany).toHaveBeenCalledWith({
			where: { organizationId: 'org_1', projectId: 'project_1' },
			orderBy: { version: 'desc' },
			select: {
				id: true,
				title: true,
				version: true,
				runId: true,
				createdAt: true
			}
		});
	});

	it('creates version 1 from the latest marked CDC draft', async () => {
		runFindFirst.mockResolvedValueOnce({
			id: 'run_1',
			projectId: 'project_1',
			organizationId: 'org_1',
			mode: RUN_MODE.CDC,
			status: RUN_STATUS.AWAITING_REVIEW,
			events: [assistantEvent(5, '# CRM interne\n\nBody')]
		});
		transaction.mockImplementationOnce(async (fn) =>
			fn({
				cdcDocument: {
					findUnique: vi.fn().mockResolvedValue(null),
					aggregate: vi.fn().mockResolvedValue({ _max: { version: null } }),
					create: vi.fn().mockResolvedValue({
						id: 'cdc_1',
						projectId: 'project_1',
						runId: 'run_1',
						title: 'CRM interne',
						markdown: '# CRM interne\n\nBody',
						version: 1,
						sourceEventSeq: 5
					})
				}
			})
		);

		const document = await validateRunCdcForOrg('org_1', 'user_1', 'run_1');

		expect(document).toMatchObject({
			id: 'cdc_1',
			version: 1,
			sourceEventSeq: 5,
			title: 'CRM interne'
		});
	});

	it('returns an existing document when the same source event was already validated', async () => {
		runFindFirst.mockResolvedValueOnce({
			id: 'run_1',
			projectId: 'project_1',
			organizationId: 'org_1',
			mode: RUN_MODE.CDC,
			status: RUN_STATUS.AWAITING_REVIEW,
			events: [assistantEvent(7, '# Existing\n\nBody')]
		});
		transaction.mockImplementationOnce(async (fn) =>
			fn({
				cdcDocument: {
					findUnique: vi.fn().mockResolvedValue({
						id: 'cdc_existing',
						version: 2,
						sourceEventSeq: 7
					})
				}
			})
		);

		await expect(validateRunCdcForOrg('org_1', 'user_1', 'run_1')).resolves.toEqual({
			id: 'cdc_existing',
			version: 2,
			sourceEventSeq: 7
		});
	});

	it('rejects non CDC runs and non review runs', async () => {
		runFindFirst.mockResolvedValueOnce({
			id: 'run_1',
			mode: RUN_MODE.AGENT,
			status: RUN_STATUS.AWAITING_REVIEW,
			events: []
		});
		await expect(validateRunCdcForOrg('org_1', 'user_1', 'run_1')).rejects.toThrow(
			'Run is not a CDC run'
		);

		runFindFirst.mockResolvedValueOnce({
			id: 'run_2',
			mode: RUN_MODE.CDC,
			status: RUN_STATUS.RUNNING,
			events: []
		});
		await expect(validateRunCdcForOrg('org_1', 'user_1', 'run_2')).rejects.toThrow(
			'Run is not awaiting review'
		);
	});
});
```

- [ ] **Step 2: Run service tests and verify they fail**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/cdc-documents-service.test.ts
```

Expected: FAIL because `src/lib/server/cdc-documents-service.ts` does not exist.

- [ ] **Step 3: Implement CDC document service**

Create `src/lib/server/cdc-documents-service.ts`:

```ts
import { RUN_STATUS } from '$lib/domain/run-status';
import { CDC_SKILL_NAME, RUN_MODE } from '$lib/domain/run-mode';
import { extractLatestCdcDraft } from '$lib/domain/cdc-document';
import { prisma } from '$lib/server/prisma';

export class CdcDocumentServiceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CdcDocumentServiceError';
	}
}

export async function assertCdcSkillEnabledForOrg(
	organizationId: string,
	projectId: string
): Promise<void> {
	const skill = await prisma.projectSkill.findFirst({
		where: {
			organizationId,
			projectId,
			name: CDC_SKILL_NAME,
			enabled: true
		},
		select: { id: true }
	});
	if (!skill) {
		throw new CdcDocumentServiceError(
			`CDC runs require an enabled project skill named \`${CDC_SKILL_NAME}\``
		);
	}
}

export function listCdcDocumentsForOrg(organizationId: string, projectId: string) {
	return prisma.cdcDocument.findMany({
		where: { organizationId, projectId },
		orderBy: { version: 'desc' },
		select: {
			id: true,
			title: true,
			version: true,
			runId: true,
			createdAt: true
		}
	});
}

export function getCdcDocumentForOrg(organizationId: string, id: string) {
	return prisma.cdcDocument.findFirst({
		where: { id, organizationId },
		include: {
			project: { select: { id: true, owner: true, name: true } },
			run: { select: { id: true, status: true } }
		}
	});
}

export async function validateRunCdcForOrg(
	organizationId: string,
	createdById: string,
	runId: string
) {
	const run = await prisma.run.findFirst({
		where: { id: runId, organizationId },
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			mode: true,
			status: true,
			events: {
				orderBy: { seq: 'asc' },
				select: { seq: true, payload: true }
			}
		}
	});
	if (!run) return null;
	if (run.mode !== RUN_MODE.CDC) {
		throw new CdcDocumentServiceError('Run is not a CDC run');
	}
	if (run.status !== RUN_STATUS.AWAITING_REVIEW) {
		throw new CdcDocumentServiceError(`Run is not awaiting review (status: ${run.status})`);
	}

	const draft = extractLatestCdcDraft(run.events);
	if (!draft) {
		throw new CdcDocumentServiceError('No complete CDC draft found in this run');
	}

	return prisma.$transaction(async (tx) => {
		const existing = await tx.cdcDocument.findUnique({
			where: {
				runId_sourceEventSeq: {
					runId,
					sourceEventSeq: draft.sourceEventSeq
				}
			}
		});
		if (existing) return existing;

		const aggregate = await tx.cdcDocument.aggregate({
			where: { projectId: run.projectId },
			_max: { version: true }
		});
		const version = (aggregate._max.version ?? 0) + 1;

		return tx.cdcDocument.create({
			data: {
				organizationId,
				projectId: run.projectId,
				runId,
				createdById,
				title: draft.title,
				markdown: draft.markdown,
				version,
				sourceEventSeq: draft.sourceEventSeq
			}
		});
	});
}
```

- [ ] **Step 4: Run service tests and verify they pass**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/cdc-documents-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit service**

Run:

```bash
git add src/lib/server/cdc-documents-service.ts tests/unit/lib/server/cdc-documents-service.test.ts
git commit -m "feat(cdc): persist validated documents"
```

---

### Task 4: Run Mode Wiring

**Files:**
- Modify: `src/lib/schemas/runs.ts`
- Modify: `src/lib/rfc/runs.remote.ts`
- Modify: `src/lib/server/run-orchestrator.ts`
- Modify: `src/lib/server/runs-service.ts`
- Test: `tests/unit/lib/rfc/runs.remote.test.ts`
- Test: `tests/unit/lib/server/runs-service.test.ts`

- [ ] **Step 1: Extend run schema**

Modify `src/lib/schemas/runs.ts`:

```ts
import { z } from 'zod';
import { RUN_MODE } from '$lib/domain/run-mode';

export const runModeSchema = z.enum([RUN_MODE.AGENT, RUN_MODE.CDC]);
export type RunMode = z.infer<typeof runModeSchema>;
```

Add `mode` to `startRunSchema`:

```ts
export const startRunSchema = z.object({
	projectId: z.string().min(1, 'Project is required'),
	prompt: z.string().min(1, 'A prompt is required'),
	baseBranch: z.string().min(1, 'Base branch is required').optional(),
	model: runModelSchema.optional(),
	useProjectAgentConfig: z.boolean().default(true),
	mode: runModeSchema.default(RUN_MODE.AGENT)
});
```

- [ ] **Step 2: Update run creation command**

Modify imports in `src/lib/rfc/runs.remote.ts`:

```ts
import { RUN_MODE } from '$lib/domain/run-mode';
import {
	assertCdcSkillEnabledForOrg,
	CdcDocumentServiceError
} from '$lib/server/cdc-documents-service';
```

Change the `startRun` callback signature:

```ts
async ({ projectId, prompt, baseBranch, model, useProjectAgentConfig, mode }) => {
```

Add CDC guard after project lookup and before branch validation:

```ts
if (mode === RUN_MODE.CDC) {
	if (!useProjectAgentConfig) {
		error(400, 'CDC runs require project agent config');
	}
	try {
		await assertCdcSkillEnabledForOrg(organizationId, projectId);
	} catch (e) {
		if (e instanceof CdcDocumentServiceError) error(400, e.message);
		throw e;
	}
}
```

Add `mode` to `prisma.run.create`:

```ts
mode,
```

- [ ] **Step 3: Update orchestrator prompt**

Modify imports in `src/lib/server/run-orchestrator.ts`:

```ts
import { buildEffectiveRunPrompt } from '$lib/domain/run-mode';
```

Change env construction:

```ts
const runPrompt = isResume ? run.pendingPrompt! : buildEffectiveRunPrompt(run.mode, run.prompt);
const env: Record<string, string> = {
	RUN_PROMPT: runPrompt,
	CLAUDE_CODE_OAUTH_TOKEN: privateEnv.CLAUDE_CODE_OAUTH_TOKEN ?? '',
	...agentConfig.secretEnv
};
```

- [ ] **Step 4: Return mode and CDC metadata from run queries**

Modify `listRunsForOrg` in `src/lib/server/runs-service.ts`:

```ts
select: {
	id: true,
	status: true,
	mode: true,
	prompt: true,
	queuedAt: true,
	finishedAt: true,
	error: true,
	agentBranch: true,
	baseBranch: true,
	cdcDocuments: {
		orderBy: { version: 'desc' },
		take: 1,
		select: { id: true, title: true, version: true }
	}
}
```

Modify `getRunForOrg` include:

```ts
cdcDocuments: {
	orderBy: { version: 'desc' },
	select: { id: true, title: true, version: true, createdAt: true, sourceEventSeq: true }
}
```

- [ ] **Step 5: Add tests for CDC guard and run query shape**

In `tests/unit/lib/rfc/runs.remote.test.ts`, extend the hoisted mocks:

```ts
assertCdcSkillEnabledForOrg: vi.fn()
```

Add the service mock:

```ts
vi.mock('$lib/server/cdc-documents-service', () => ({
	assertCdcSkillEnabledForOrg: mocks.assertCdcSkillEnabledForOrg,
	CdcDocumentServiceError: class CdcDocumentServiceError extends Error {}
}));
```

Add this test:

```ts
it('requires the CDC skill and stores cdc mode when starting a CDC run', async () => {
	mocks.projectFindFirst.mockResolvedValue({
		id: 'p1',
		cloneUrl: 'https://github.com/acme/repo.git',
		defaultBranch: 'main'
	});
	mocks.assertCdcSkillEnabledForOrg.mockResolvedValue(undefined);
	mocks.getGithubToken.mockResolvedValue('gh-token');
	mocks.assertProjectBranchExists.mockResolvedValue(undefined);
	mocks.runCreate.mockResolvedValue({ id: 'run-created' });
	mocks.enqueueRun.mockResolvedValue(undefined);

	await startRun({
		projectId: 'p1',
		prompt: 'cadrer le CRM',
		mode: 'cdc'
	});

	expect(mocks.assertCdcSkillEnabledForOrg).toHaveBeenCalledWith('org1', 'p1');
	expect(mocks.runCreate).toHaveBeenCalledWith(
		expect.objectContaining({
			data: expect.objectContaining({ mode: 'cdc' })
		})
	);
});
```

In `tests/unit/lib/server/runs-service.test.ts`, add expectations that `mode` and `cdcDocuments` are selected by `listRunsForOrg` and included by `getRunForOrg`:

```ts
expect(prisma.run.findMany).toHaveBeenCalledWith(
	expect.objectContaining({
		select: expect.objectContaining({
			mode: true,
			cdcDocuments: expect.objectContaining({
				take: 1,
				select: { id: true, title: true, version: true }
			})
		})
	})
);

expect(prisma.run.findFirst).toHaveBeenCalledWith(
	expect.objectContaining({
		include: expect.objectContaining({
			cdcDocuments: expect.objectContaining({
				select: { id: true, title: true, version: true, createdAt: true, sourceEventSeq: true }
			})
		})
	})
);
```

- [ ] **Step 6: Run targeted tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/rfc/runs.remote.test.ts tests/unit/lib/server/runs-service.test.ts tests/unit/lib/domain/run-mode.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit run mode wiring**

Run:

```bash
git add src/lib/schemas/runs.ts src/lib/rfc/runs.remote.ts src/lib/server/run-orchestrator.ts src/lib/server/runs-service.ts tests/unit/lib/rfc/runs.remote.test.ts tests/unit/lib/server/runs-service.test.ts
git commit -m "feat(cdc): wire cdc mode into runs"
```

---

### Task 5: CDC Remote Functions

**Files:**
- Create: `src/lib/schemas/cdc-documents.ts`
- Create: `src/lib/rfc/cdc-documents.remote.ts`
- Test: `tests/unit/lib/rfc/cdc-documents.remote.test.ts`

- [ ] **Step 1: Add CDC schemas**

Create `src/lib/schemas/cdc-documents.ts`:

```ts
import { z } from 'zod';

export const cdcDocumentIdSchema = z.string().min(1, 'CDC document is required');
export const validateRunCdcSchema = z.object({
	runId: z.string().min(1, 'Run is required')
});

export type ValidateRunCdcSchema = typeof validateRunCdcSchema;
```

- [ ] **Step 2: Implement remote functions**

Create `src/lib/rfc/cdc-documents.remote.ts`:

```ts
import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { cdcDocumentIdSchema, validateRunCdcSchema } from '$lib/schemas/cdc-documents';
import {
	CdcDocumentServiceError,
	getCdcDocumentForOrg,
	listCdcDocumentsForOrg,
	validateRunCdcForOrg
} from '$lib/server/cdc-documents-service';
import { requireActiveOrg } from '$lib/server/org';
import { requireHeaders } from '$lib/server/utils';
import { getRun } from '$lib/rfc/runs.remote';

async function requireOrganizationId(): Promise<string> {
	return await requireActiveOrg(requireHeaders());
}

function mapCdcError(e: unknown): never {
	if (e instanceof CdcDocumentServiceError) error(400, e.message);
	throw e;
}

export const listCdcDocuments = query(z.string().min(1), async (projectId) => {
	const organizationId = await requireOrganizationId();
	return await listCdcDocumentsForOrg(organizationId, projectId);
});

export const getCdcDocument = query(cdcDocumentIdSchema, async (id) => {
	const organizationId = await requireOrganizationId();
	const document = await getCdcDocumentForOrg(organizationId, id);
	if (!document) error(404, 'CDC document not found');
	return document;
});

export const validateRunCdc = command(validateRunCdcSchema, async ({ runId }) => {
	const organizationId = await requireOrganizationId();
	const { locals } = getRequestEvent();
	try {
		const document = await validateRunCdcForOrg(organizationId, locals.user!.id, runId);
		if (!document) error(404, 'Run not found');
		await getRun(runId).refresh();
		await listCdcDocuments(document.projectId).refresh();
		return { id: document.id, projectId: document.projectId, version: document.version };
	} catch (e) {
		mapCdcError(e);
	}
});
```

- [ ] **Step 3: Add remote function tests**

Create `tests/unit/lib/rfc/cdc-documents.remote.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	requireHeaders: vi.fn(),
	requireActiveOrg: vi.fn(),
	listCdcDocumentsForOrg: vi.fn(),
	getCdcDocumentForOrg: vi.fn(),
	validateRunCdcForOrg: vi.fn()
}));

function remoteHandle<T extends (...args: never[]) => unknown>(
	handler: T
): T & { refresh: () => Promise<void> } {
	const wrapped = vi.fn(handler) as unknown as T & {
		__: { type: 'command' };
		refresh: () => Promise<void>;
	};
	wrapped.__ = { type: 'command' };
	wrapped.refresh = vi.fn(async () => undefined);
	return wrapped;
}

vi.mock('$app/server', () => ({
	command: vi.fn((schemaOrHandler, maybeHandler) => remoteHandle(maybeHandler ?? schemaOrHandler)),
	query: vi.fn((schemaOrHandler, maybeHandler) => {
		const handler = maybeHandler ?? schemaOrHandler;
		const wrapped = vi.fn(handler) as unknown as {
			__: { type: 'query' };
			refresh: () => Promise<void>;
		};
		wrapped.__ = { type: 'query' };
		wrapped.refresh = vi.fn(async () => undefined);
		return wrapped;
	}),
	getRequestEvent: mocks.getRequestEvent
}));

vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));

vi.mock('$lib/server/utils', () => ({ requireHeaders: mocks.requireHeaders }));
vi.mock('$lib/server/org', () => ({ requireActiveOrg: mocks.requireActiveOrg }));
vi.mock('$lib/server/cdc-documents-service', () => ({
	listCdcDocumentsForOrg: mocks.listCdcDocumentsForOrg,
	getCdcDocumentForOrg: mocks.getCdcDocumentForOrg,
	validateRunCdcForOrg: mocks.validateRunCdcForOrg,
	CdcDocumentServiceError: class CdcDocumentServiceError extends Error {}
}));
vi.mock('$lib/rfc/runs.remote', () => ({
	getRun: vi.fn(() => ({ refresh: vi.fn(async () => undefined) }))
}));

import {
	getCdcDocument,
	listCdcDocuments,
	validateRunCdc
} from '$lib/rfc/cdc-documents.remote';

describe('cdc-documents.remote', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.requireHeaders.mockReturnValue(new Headers());
		mocks.requireActiveOrg.mockResolvedValue('org1');
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'user1' } } });
	});

	it('lists CDC documents for the active org', async () => {
		mocks.listCdcDocumentsForOrg.mockResolvedValue([{ id: 'cdc_1' }]);

		await expect(listCdcDocuments('project_1')).resolves.toEqual([{ id: 'cdc_1' }]);
		expect(mocks.listCdcDocumentsForOrg).toHaveBeenCalledWith('org1', 'project_1');
	});

	it('maps missing CDC document to 404', async () => {
		mocks.getCdcDocumentForOrg.mockResolvedValueOnce(null);

		await expect(getCdcDocument('missing')).rejects.toMatchObject({ status: 404 });
	});

	it('validates a run CDC with the current user id', async () => {
		mocks.validateRunCdcForOrg.mockResolvedValueOnce({
			id: 'cdc_1',
			projectId: 'project_1',
			version: 1
		});

		await expect(validateRunCdc({ runId: 'run_1' })).resolves.toEqual({
			id: 'cdc_1',
			projectId: 'project_1',
			version: 1
		});
		expect(mocks.validateRunCdcForOrg).toHaveBeenCalledWith('org1', 'user1', 'run_1');
	});
});
```

- [ ] **Step 4: Run targeted remote tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/rfc/cdc-documents.remote.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit remote functions**

Run:

```bash
git add src/lib/schemas/cdc-documents.ts src/lib/rfc/cdc-documents.remote.ts tests/unit/lib/rfc/cdc-documents.remote.test.ts
git commit -m "feat(cdc): expose document remote functions"
```

---

### Task 6: Project Page UI

**Files:**
- Modify: `src/routes/(app)/projects/[id]/+page.svelte`

- [ ] **Step 1: Add imports and queries**

Modify the script block:

```svelte
<script lang="ts">
	import { RUN_MODE, type RunMode } from '$lib/domain/run-mode';
	import { listCdcDocuments } from '$lib/rfc/cdc-documents.remote';
```

Add state:

```ts
const cdcDocuments = $derived(listCdcDocuments(page.params.id!));
let mode = $state<RunMode>(RUN_MODE.AGENT);
```

- [ ] **Step 2: Pass mode to `startRun`**

Modify `handleStart`:

```ts
await startRun({
	projectId: page.params.id!,
	prompt,
	baseBranch: selectedBaseBranch || undefined,
	model: model || undefined,
	useProjectAgentConfig,
	mode
});
prompt = '';
baseBranch = '';
useProjectAgentConfig = true;
mode = RUN_MODE.AGENT;
```

- [ ] **Step 3: Add mode selector**

Add a segmented control before the prompt textarea:

```svelte
<div class="inline-grid grid-cols-2 border border-border">
	<Button
		variant={mode === RUN_MODE.AGENT ? 'default' : 'ghost'}
		aria-pressed={mode === RUN_MODE.AGENT}
		onclick={() => (mode = RUN_MODE.AGENT)}
	>
		Agent
	</Button>
	<Button
		variant={mode === RUN_MODE.CDC ? 'default' : 'ghost'}
		aria-pressed={mode === RUN_MODE.CDC}
		onclick={() => {
			mode = RUN_MODE.CDC;
			useProjectAgentConfig = true;
		}}
	>
		Cahier des charges
	</Button>
</div>
```

Change textarea placeholder:

```svelte
placeholder={mode === RUN_MODE.CDC
	? 'Decris le produit, le contexte et ce que tu veux cadrer...'
	: 'Describe what the agent should do...'}
```

Disable project config opt-out for CDC:

```svelte
<input
	type="checkbox"
	bind:checked={useProjectAgentConfig}
	disabled={mode === RUN_MODE.CDC}
	class="h-4 w-4 accent-primary"
/>
```

- [ ] **Step 4: Add CDC documents section**

Add below the run form and before the runs list:

```svelte
<section class="space-y-2">
	<h2 class="text-lg font-medium">Cahiers des charges</h2>
	{#if cdcDocuments.error}
		<p class="text-sm text-red-500">{cdcDocuments.error.message}</p>
	{:else if cdcDocuments.current}
		{#if cdcDocuments.current.length === 0}
			<p class="text-sm text-muted-foreground">No CDC documents yet.</p>
		{:else}
			<ul class="divide-y divide-border border-y border-border">
				{#each cdcDocuments.current as document (document.id)}
					<li class="py-2">
						<a
							href={`/projects/${page.params.id}/cdc/${document.id}`}
							class="flex items-center justify-between gap-3 text-sm hover:underline"
						>
							<span class="truncate">{document.title}</span>
							<span class="shrink-0 text-xs text-muted-foreground">v{document.version}</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	{:else}
		<p class="text-sm text-muted-foreground">Loading CDC documents...</p>
	{/if}
</section>
```

- [ ] **Step 5: Run Svelte autofixer on updated component**

Use the Svelte MCP `svelte-autofixer` on the full updated `+page.svelte`. Apply all issues it returns, then run it again until no issues or suggestions remain.

- [ ] **Step 6: Run Svelte check**

Run:

```bash
bun run check
```

Expected: PASS or only failures from later unimplemented tasks. If failures are from this page, fix them before continuing.

- [ ] **Step 7: Commit project page UI**

Run:

```bash
git add 'src/routes/(app)/projects/[id]/+page.svelte'
git commit -m "feat(cdc): add cdc launch and project list"
```

---

### Task 7: Run Page Validation UI

**Files:**
- Modify: `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`

- [ ] **Step 1: Add imports and state**

Modify the script block:

```svelte
<script lang="ts">
	import Markdown from '$lib/components/runs/Markdown.svelte';
	import { extractLatestCdcDraft } from '$lib/domain/cdc-document';
	import { RUN_MODE } from '$lib/domain/run-mode';
	import { validateRunCdc } from '$lib/rfc/cdc-documents.remote';
```

Extend `RunUiState`:

```ts
validatingCdc: boolean;
cdcError: string | null;
cdcDocumentId: string | null;
```

Extend `defaultUiState`:

```ts
validatingCdc: false,
cdcError: null,
cdcDocumentId: null
```

Add derived draft:

```ts
const cdcDraft = $derived.by(() => {
	if (run.current?.mode !== RUN_MODE.CDC) return null;
	return extractLatestCdcDraft(run.current.events ?? []);
});
```

- [ ] **Step 2: Add validation handler**

Add function:

```ts
async function validateCdcDraft() {
	const runId = currentRunId;
	setRunUiState(runId, { validatingCdc: true, cdcError: null });
	try {
		const document = await validateRunCdc({ runId });
		setRunUiState(runId, { cdcDocumentId: document.id });
		await getRun(runId).refresh();
	} catch (e) {
		setRunUiState(runId, {
			cdcError: e instanceof Error ? e.message : 'Could not validate the CDC'
		});
	} finally {
		setRunUiState(runId, { validatingCdc: false });
	}
}
```

- [ ] **Step 3: Render CDC preview and action**

Add this section above the `Review changes` section:

```svelte
{#if run.current.mode === RUN_MODE.CDC}
	<section class="space-y-2 rounded-md border border-border p-3">
		<div class="flex items-center justify-between gap-3">
			<h2 class="text-sm font-medium">Cahier des charges</h2>
			{#if ui.cdcDocumentId}
				<a
					href={`/projects/${page.params.id}/cdc/${ui.cdcDocumentId}`}
					class="text-xs underline"
				>
					Open validated CDC
				</a>
			{/if}
		</div>
		{#if ui.cdcError}
			<p class="text-sm text-red-500">{ui.cdcError}</p>
		{/if}
		{#if cdcDraft}
			<div class="max-h-96 overflow-auto rounded-md border bg-muted/30 p-3">
				<Markdown source={cdcDraft.markdown} />
			</div>
			<Button
				onclick={validateCdcDraft}
				disabled={ui.validatingCdc || run.current.status !== RUN_STATUS.AWAITING_REVIEW}
			>
				{ui.validatingCdc ? 'Validating...' : 'Valider comme CDC'}
			</Button>
		{:else}
			<p class="text-sm text-muted-foreground">
				No complete CDC proposal has been detected yet.
			</p>
		{/if}
	</section>
{/if}
```

Add mode to the run metadata list:

```svelte
<dt class="text-muted-foreground">Mode</dt>
<dd>{run.current.mode}</dd>
```

- [ ] **Step 4: Run Svelte autofixer on updated component**

Use the Svelte MCP `svelte-autofixer` on the full updated run page. Apply all issues it returns, then run it again until no issues or suggestions remain.

- [ ] **Step 5: Run Svelte check**

Run:

```bash
bun run check
```

Expected: PASS or only failures from the not-yet-created CDC detail route. If failures are from the run page, fix them before continuing.

- [ ] **Step 6: Commit run page UI**

Run:

```bash
git add 'src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte'
git commit -m "feat(cdc): validate drafts from run page"
```

---

### Task 8: CDC Detail Page

**Files:**
- Create: `src/routes/(app)/projects/[id]/cdc/[cdcId]/+page.svelte`

- [ ] **Step 1: Create detail page**

Create `src/routes/(app)/projects/[id]/cdc/[cdcId]/+page.svelte`:

```svelte
<script lang="ts">
	import { page } from '$app/state';
	import Markdown from '$lib/components/runs/Markdown.svelte';
	import { getCdcDocument } from '$lib/rfc/cdc-documents.remote';

	const document = $derived(getCdcDocument(page.params.cdcId!));
</script>

<div class="mx-auto max-w-4xl space-y-4 p-6">
	{#if document.error}
		<p class="text-sm text-red-500">{document.error.message}</p>
	{:else if document.current}
		<div class="flex items-center justify-between gap-3">
			<div class="min-w-0">
				<h1 class="truncate text-2xl font-semibold">{document.current.title}</h1>
				<p class="text-sm text-muted-foreground">
					Version {document.current.version} - {document.current.project.owner}/{document.current.project.name}
				</p>
			</div>
			<a href={`/projects/${page.params.id}/runs/${document.current.runId}`} class="text-sm hover:underline">
				Back to run
			</a>
		</div>

		<section class="rounded-md border border-border p-4">
			<Markdown source={document.current.markdown} />
		</section>
	{:else}
		<p class="text-sm text-muted-foreground">Loading CDC document...</p>
	{/if}
</div>
```

- [ ] **Step 2: Run Svelte autofixer on detail page**

Use the Svelte MCP `svelte-autofixer` on the full new component. Apply all issues it returns, then run it again until no issues or suggestions remain.

- [ ] **Step 3: Run Svelte check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 4: Commit detail page**

Run:

```bash
git add 'src/routes/(app)/projects/[id]/cdc/[cdcId]/+page.svelte'
git commit -m "feat(cdc): add document detail page"
```

---

### Task 9: Final Verification

**Files:**
- Review all files touched by Tasks 1-8.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/domain/run-mode.test.ts tests/unit/lib/domain/cdc-document.test.ts tests/unit/lib/server/cdc-documents-service.test.ts tests/unit/lib/rfc/cdc-documents.remote.test.ts tests/unit/lib/rfc/runs.remote.test.ts tests/unit/lib/server/runs-service.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full unit suite**

Run:

```bash
bun run test:unit -- --run
```

Expected: PASS.

- [ ] **Step 3: Run SvelteKit check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 4: Run lint**

Run:

```bash
bun run lint
```

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected:

- `git status --short` shows only intentional CDC feature files if the final commit has not been made.
- `git diff --check` exits 0 with no whitespace errors.

- [ ] **Step 6: Final feature commit**

If Tasks 1-8 were not already committed individually, commit the remaining changes:

```bash
git add prisma/schema.prisma prisma/migrations/20260618000000_add_cdc_documents/migration.sql src tests
git commit -m "feat(cdc): add cahier des charges run workflow"
```

If Tasks 1-8 were committed individually, skip this command and keep the existing commit series.
