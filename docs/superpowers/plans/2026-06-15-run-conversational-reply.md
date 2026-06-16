# Run Conversational Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre à l'utilisateur de répondre en texte libre à un run en `awaiting_review`, ce qui relance la même run en reprenant la session de l'agent.

**Architecture:** Un message de l'utilisateur est enregistré comme `RunEvent` `user_message`, stocké dans `Run.pendingPrompt`, puis la run repasse `awaiting_review → queued` et est ré-enqueue. Le worker détecte le mode resume (`sessionId` + `pendingPrompt`), réutilise le checkout conservé, relance le container avec `RUN_RESUME_SESSION` + `RUN_PROMPT=<message>`, et continue la numérotation des events. Sortie 0 → retour en `awaiting_review`.

**Tech Stack:** SvelteKit (remote functions `$app/server`), Prisma/PostgreSQL, pg-boss, Docker, Vitest, Svelte 5 runes.

---

## Décisions cadrées (rappel du spec)

- Réponse libre (chat), pas de détection « c'est une question ».
- Même run, fil continu (pas de run enfant).
- Disponible depuis `awaiting_review` uniquement.
- Réutilise le statut `queued` (pas de nouveau statut).
- Message stocké dans `Run.pendingPrompt`.
- Composer toujours visible en `awaiting_review`.

## Fichiers touchés

- Modifier : `prisma/schema.prisma` — champ `pendingPrompt`, valeur d'enum `user_message`.
- Créer : `prisma/migrations/<timestamp>_add_run_pending_prompt_and_user_message_event/migration.sql` (généré).
- Modifier : `src/lib/domain/run-status.ts` — transitions `awaiting_review → queued`, `queued → running`.
- Modifier : `src/lib/domain/run-status.test.ts` — couverture des nouvelles transitions.
- Modifier : `src/lib/server/run-events.ts` — `getNextEventSeq`, classification `user_message`.
- Modifier : `tests/unit/lib/server/run-events.test.ts` — tests des deux ajouts.
- Créer : `src/lib/server/run-reply-service.ts` — logique `replyToRunForOrg` testable.
- Créer : `tests/unit/lib/server/run-reply-service.test.ts`.
- Modifier : `src/lib/schemas/runs.ts` — `replyToRunSchema`.
- Modifier : `tests/unit/lib/schemas/runs.test.ts` — validation du schéma.
- Modifier : `src/lib/rfc/runs.remote.ts` — commande `replyToRun`.
- Modifier : `src/lib/server/run-orchestrator.ts` — branche resume + `seq` depuis la DB + source de `RUN_PROMPT`.
- Modifier : `tests/unit/lib/server/run-orchestrator.test.ts` — test du chemin resume.
- Modifier : `src/lib/components/runs/run-event-display.ts` — kind `user_message`.
- Créer : `tests/unit/lib/components/runs/run-event-display.test.ts` (si absent ; sinon modifier).
- Modifier : `src/lib/components/runs/RunEvent.svelte` — rendu `user_message`.
- Modifier : `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte` — composer de réponse.

---

## Task 1: Schema — `pendingPrompt` + enum `user_message`

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_run_pending_prompt_and_user_message_event/migration.sql` (généré par Prisma)

- [ ] **Step 1: Ajouter la valeur d'enum**

Dans `prisma/schema.prisma`, enum `RunEventType` (vers ligne 142), ajouter `user_message` :

```prisma
enum RunEventType {
  system
  assistant
  tool_use
  tool_result
  result
  error
  user_message
}
```

- [ ] **Step 2: Ajouter le champ `pendingPrompt` sur `Run`**

Dans `model Run` (vers ligne 293), juste après `sessionId String?` :

```prisma
  sessionId             String?
  pendingPrompt         String?
```

- [ ] **Step 3: Générer la migration + le client**

Run:

```bash
bunx prisma migrate dev --name add_run_pending_prompt_and_user_message_event
bunx prisma generate
```

Expected: une nouvelle migration créée, `prisma generate` régénère `@prisma/client` (le type `RunEventType` inclut désormais `user_message`, le type `Run` a `pendingPrompt`).

- [ ] **Step 4: Vérifier la compilation des types**

Run: `bun run check`
Expected: PASS (pas d'erreur de type liée au schéma).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(runs): add pendingPrompt and user_message event type"
```

---

## Task 2: Transitions d'état resume

**Files:**

- Modify: `src/lib/domain/run-status.ts:47-69`
- Test: `src/lib/domain/run-status.test.ts`

- [ ] **Step 1: Écrire le test (qui échoue)**

Dans `src/lib/domain/run-status.test.ts`, ajouter dans le `describe('run-status domain', …)` :

```ts
it('allows resuming an awaiting_review run via the queue', () => {
	expect(canTransition(RUN_STATUS.AWAITING_REVIEW, RUN_STATUS.QUEUED)).toBe(true);
	expect(canTransition(RUN_STATUS.QUEUED, RUN_STATUS.RUNNING)).toBe(true);
});

it('still forbids skipping straight to completed from review', () => {
	expect(canTransition(RUN_STATUS.AWAITING_REVIEW, RUN_STATUS.COMPLETED)).toBe(true);
	expect(canTransition(RUN_STATUS.QUEUED, RUN_STATUS.AWAITING_REVIEW)).toBe(false);
});
```

- [ ] **Step 2: Lancer le test pour le voir échouer**

Run: `bunx vitest run src/lib/domain/run-status.test.ts`
Expected: FAIL sur `canTransition(AWAITING_REVIEW, QUEUED)` (attendu `true`, reçu `false`).

- [ ] **Step 3: Ajouter les transitions**

Dans `src/lib/domain/run-status.ts`, objet `RUN_TRANSITIONS` :

```ts
	[RUN_STATUS.QUEUED]: [RUN_STATUS.PREPARING, RUN_STATUS.RUNNING, RUN_STATUS.FAILED, RUN_STATUS.CANCELED],
```

et

```ts
	[RUN_STATUS.AWAITING_REVIEW]: [
		RUN_STATUS.PUSHING,
		RUN_STATUS.COMPLETED,
		RUN_STATUS.CANCELED,
		RUN_STATUS.QUEUED
	],
```

- [ ] **Step 4: Lancer le test pour le voir passer**

Run: `bunx vitest run src/lib/domain/run-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/run-status.ts src/lib/domain/run-status.test.ts
git commit -m "feat(runs): allow awaiting_review -> queued -> running resume transitions"
```

---

## Task 3: `getNextEventSeq` + classification `user_message`

**Files:**

- Modify: `src/lib/server/run-events.ts`
- Test: `tests/unit/lib/server/run-events.test.ts`

- [ ] **Step 1: Écrire les tests (qui échouent)**

Remplacer le contenu de `tests/unit/lib/server/run-events.test.ts` par :

```ts
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		runEvent: {
			aggregate: vi.fn(),
			create: vi.fn()
		}
	}
}));

import { prisma } from '$lib/server/prisma';
import { classifyMessage, getNextEventSeq } from '$lib/server/run-events';

const aggregateMock = prisma.runEvent.aggregate as unknown as Mock;

describe('classifyMessage', () => {
	it('maps known SDK message types to RunEventType', () => {
		expect(classifyMessage({ type: 'assistant' })).toBe('assistant');
		expect(classifyMessage({ type: 'user' })).toBe('tool_result');
		expect(classifyMessage({ type: 'result' })).toBe('result');
		expect(classifyMessage({ type: 'error' })).toBe('error');
		expect(classifyMessage({ type: 'system' })).toBe('system');
	});
	it('maps user_message to its own RunEventType', () => {
		expect(classifyMessage({ type: 'user_message' })).toBe('user_message');
	});
	it('falls back to system for unknown/missing types', () => {
		expect(classifyMessage({ type: 'runner_summary' })).toBe('system');
		expect(classifyMessage({})).toBe('system');
	});
});

describe('getNextEventSeq', () => {
	beforeEach(() => vi.resetAllMocks());

	it('returns 0 when the run has no events yet', async () => {
		aggregateMock.mockResolvedValue({ _max: { seq: null } });
		await expect(getNextEventSeq('r1')).resolves.toBe(0);
	});

	it('returns max seq + 1 when events exist', async () => {
		aggregateMock.mockResolvedValue({ _max: { seq: 7 } });
		await expect(getNextEventSeq('r1')).resolves.toBe(8);
		expect(aggregateMock).toHaveBeenCalledWith({ where: { runId: 'r1' }, _max: { seq: true } });
	});
});
```

- [ ] **Step 2: Lancer pour voir échouer**

Run: `bunx vitest run tests/unit/lib/server/run-events.test.ts`
Expected: FAIL (`getNextEventSeq` non exporté ; `user_message` non géré).

- [ ] **Step 3: Implémenter dans `src/lib/server/run-events.ts`**

Ajouter le `case` dans `classifyMessage` (avant le `default`) :

```ts
		case 'user_message':
			return 'user_message';
```

Et ajouter la fonction en fin de fichier :

```ts
/** Prochain `seq` libre pour un run (max existant + 1, ou 0 si aucun event). */
export async function getNextEventSeq(runId: string): Promise<number> {
	const agg = await prisma.runEvent.aggregate({ where: { runId }, _max: { seq: true } });
	return (agg._max.seq ?? -1) + 1;
}
```

- [ ] **Step 4: Lancer pour voir passer**

Run: `bunx vitest run tests/unit/lib/server/run-events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/run-events.ts tests/unit/lib/server/run-events.test.ts
git commit -m "feat(runs): add getNextEventSeq and user_message classification"
```

---

## Task 4: Service `replyToRunForOrg`

**Files:**

- Create: `src/lib/server/run-reply-service.ts`
- Test: `tests/unit/lib/server/run-reply-service.test.ts`

- [ ] **Step 1: Écrire le test (qui échoue)**

Créer `tests/unit/lib/server/run-reply-service.test.ts` :

```ts
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: { run: { findFirst: vi.fn() } }
}));
vi.mock('$lib/server/run-events', () => ({
	getNextEventSeq: vi.fn(),
	appendRunEvent: vi.fn()
}));
vi.mock('$lib/server/run-transitions', () => ({ transitionRun: vi.fn() }));
vi.mock('$lib/server/queue', () => ({ enqueueRun: vi.fn() }));

import { prisma } from '$lib/server/prisma';
import { getNextEventSeq, appendRunEvent } from '$lib/server/run-events';
import { transitionRun } from '$lib/server/run-transitions';
import { enqueueRun } from '$lib/server/queue';
import { replyToRunForOrg, RunReplyError } from '$lib/server/run-reply-service';
import { RUN_STATUS } from '$lib/domain/run-status';

const findFirst = prisma.run.findFirst as unknown as Mock;
const nextSeq = getNextEventSeq as unknown as Mock;
const append = appendRunEvent as unknown as Mock;
const transition = transitionRun as unknown as Mock;
const enqueue = enqueueRun as unknown as Mock;

const timeoutAt = new Date('2026-06-15T12:00:00Z');

beforeEach(() => vi.resetAllMocks());

describe('replyToRunForOrg', () => {
	it('rejects an empty message', async () => {
		await expect(
			replyToRunForOrg('org1', { runId: 'r1', message: '   ', timeoutAt })
		).rejects.toBeInstanceOf(RunReplyError);
		expect(findFirst).not.toHaveBeenCalled();
	});

	it('returns null when the run is not found in the org', async () => {
		findFirst.mockResolvedValue(null);
		await expect(
			replyToRunForOrg('org1', { runId: 'r1', message: 'hi', timeoutAt })
		).resolves.toBeNull();
	});

	it('rejects when the run is not awaiting review', async () => {
		findFirst.mockResolvedValue({
			id: 'r1',
			projectId: 'p1',
			status: RUN_STATUS.RUNNING,
			sessionId: 's1'
		});
		await expect(
			replyToRunForOrg('org1', { runId: 'r1', message: 'hi', timeoutAt })
		).rejects.toThrow(/awaiting review/i);
	});

	it('rejects when the run has no session to resume', async () => {
		findFirst.mockResolvedValue({
			id: 'r1',
			projectId: 'p1',
			status: RUN_STATUS.AWAITING_REVIEW,
			sessionId: null
		});
		await expect(
			replyToRunForOrg('org1', { runId: 'r1', message: 'hi', timeoutAt })
		).rejects.toThrow(/cannot be resumed/i);
	});

	it('records the message, queues the run and enqueues a job', async () => {
		findFirst.mockResolvedValue({
			id: 'r1',
			projectId: 'p1',
			status: RUN_STATUS.AWAITING_REVIEW,
			sessionId: 's1'
		});
		transition.mockResolvedValue(true);
		nextSeq.mockResolvedValue(5);

		const res = await replyToRunForOrg('org1', {
			runId: 'r1',
			message: '  please continue  ',
			timeoutAt
		});

		expect(res).toEqual({ runId: 'r1', projectId: 'p1' });
		expect(transition).toHaveBeenCalledWith('r1', RUN_STATUS.AWAITING_REVIEW, RUN_STATUS.QUEUED, {
			pendingPrompt: 'please continue',
			timeoutAt
		});
		expect(append).toHaveBeenCalledWith('r1', 5, {
			type: 'user_message',
			text: 'please continue'
		});
		expect(enqueue).toHaveBeenCalledWith('r1');
	});

	it('does not enqueue when the transition is lost to a concurrent action', async () => {
		findFirst.mockResolvedValue({
			id: 'r1',
			projectId: 'p1',
			status: RUN_STATUS.AWAITING_REVIEW,
			sessionId: 's1'
		});
		transition.mockResolvedValue(false);

		await expect(
			replyToRunForOrg('org1', { runId: 'r1', message: 'hi', timeoutAt })
		).rejects.toThrow(/no longer awaiting review/i);
		expect(enqueue).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Lancer pour voir échouer**

Run: `bunx vitest run tests/unit/lib/server/run-reply-service.test.ts`
Expected: FAIL (module `run-reply-service` introuvable).

- [ ] **Step 3: Implémenter `src/lib/server/run-reply-service.ts`**

```ts
import { prisma } from '$lib/server/prisma';
import { appendRunEvent, getNextEventSeq } from '$lib/server/run-events';
import { transitionRun } from '$lib/server/run-transitions';
import { enqueueRun } from '$lib/server/queue';
import { RUN_STATUS } from '$lib/domain/run-status';

export class RunReplyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RunReplyError';
	}
}

/**
 * Enregistre une réponse utilisateur sur un run en `awaiting_review` et le relance :
 * event `user_message`, `pendingPrompt` posé, transition gardée vers `queued`, enqueue.
 * Retourne `null` si le run est absent/hors org.
 */
export async function replyToRunForOrg(
	organizationId: string,
	input: { runId: string; message: string; timeoutAt: Date }
): Promise<{ runId: string; projectId: string } | null> {
	const text = input.message.trim();
	if (!text) throw new RunReplyError('A message is required');

	const run = await prisma.run.findFirst({
		where: { id: input.runId, organizationId },
		select: { id: true, projectId: true, status: true, sessionId: true }
	});
	if (!run) return null;

	if (run.status !== RUN_STATUS.AWAITING_REVIEW) {
		throw new RunReplyError(`Run is not awaiting review (status: ${run.status})`);
	}
	if (!run.sessionId) {
		throw new RunReplyError('This run cannot be resumed (no agent session)');
	}

	const claimed = await transitionRun(run.id, RUN_STATUS.AWAITING_REVIEW, RUN_STATUS.QUEUED, {
		pendingPrompt: text,
		timeoutAt: input.timeoutAt
	});
	if (!claimed) throw new RunReplyError('Run is no longer awaiting review');

	const seq = await getNextEventSeq(run.id);
	await appendRunEvent(run.id, seq, { type: 'user_message', text });

	await enqueueRun(run.id);

	return { runId: run.id, projectId: run.projectId };
}
```

- [ ] **Step 4: Lancer pour voir passer**

Run: `bunx vitest run tests/unit/lib/server/run-reply-service.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/run-reply-service.ts tests/unit/lib/server/run-reply-service.test.ts
git commit -m "feat(runs): add replyToRunForOrg service"
```

---

## Task 5: Schéma `replyToRunSchema`

**Files:**

- Modify: `src/lib/schemas/runs.ts`
- Test: `tests/unit/lib/schemas/runs.test.ts`

- [ ] **Step 1: Écrire le test (qui échoue)**

Dans `tests/unit/lib/schemas/runs.test.ts`, ajouter (importer `replyToRunSchema` depuis `$lib/schemas/runs` en tête si besoin) :

```ts
import { replyToRunSchema } from '$lib/schemas/runs';

describe('replyToRunSchema', () => {
	it('accepts a runId and a non-empty message', () => {
		const parsed = replyToRunSchema.safeParse({ runId: 'r1', message: 'continue please' });
		expect(parsed.success).toBe(true);
	});

	it('rejects an empty message', () => {
		const parsed = replyToRunSchema.safeParse({ runId: 'r1', message: '' });
		expect(parsed.success).toBe(false);
	});

	it('rejects a missing runId', () => {
		const parsed = replyToRunSchema.safeParse({ message: 'hi' });
		expect(parsed.success).toBe(false);
	});
});
```

- [ ] **Step 2: Lancer pour voir échouer**

Run: `bunx vitest run tests/unit/lib/schemas/runs.test.ts`
Expected: FAIL (`replyToRunSchema` non exporté).

- [ ] **Step 3: Implémenter dans `src/lib/schemas/runs.ts`**

Ajouter en fin de fichier :

```ts
export const replyToRunSchema = z.object({
	runId: z.string().min(1),
	message: z.string().min(1, 'A message is required')
});

export type ReplyToRunSchema = typeof replyToRunSchema;
```

- [ ] **Step 4: Lancer pour voir passer**

Run: `bunx vitest run tests/unit/lib/schemas/runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schemas/runs.ts tests/unit/lib/schemas/runs.test.ts
git commit -m "feat(runs): add replyToRun schema"
```

---

## Task 6: Commande remote `replyToRun`

**Files:**

- Modify: `src/lib/rfc/runs.remote.ts`

- [ ] **Step 1: Importer le schéma, le service et son erreur**

Dans `src/lib/rfc/runs.remote.ts`, étendre l'import des schémas runs (ligne 7) :

```ts
import { startRunSchema, replyToRunSchema } from '$lib/schemas/runs';
```

Et ajouter après l'import de `run-interactions-service` (vers ligne 37) :

```ts
import { replyToRunForOrg, RunReplyError } from '$lib/server/run-reply-service';
```

- [ ] **Step 2: Ajouter la commande**

Après la commande `answerRunInteraction` (vers ligne 141), ajouter :

```ts
/** Répond à un run en `awaiting_review` : enregistre le message et relance la session. */
export const replyToRun = command(replyToRunSchema, async ({ runId, message }) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	try {
		const res = await replyToRunForOrg(organizationId, {
			runId,
			message,
			timeoutAt: new Date(Date.now() + TIMEOUT_MS)
		});
		if (!res) error(404, 'Run not found');
		await getRun(res.runId).refresh();
		await listRuns(res.projectId).refresh();
		return { ok: true };
	} catch (e) {
		if (e instanceof RunReplyError) error(400, e.message);
		throw e;
	}
});
```

- [ ] **Step 3: Vérifier types + lint**

Run: `bun run check && bunx eslint src/lib/rfc/runs.remote.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/rfc/runs.remote.ts
git commit -m "feat(runs): add replyToRun remote command"
```

---

## Task 7: Orchestrateur — chemin resume

**Files:**

- Modify: `src/lib/server/run-orchestrator.ts`
- Test: `tests/unit/lib/server/run-orchestrator.test.ts`

- [ ] **Step 1: Remplacer le corps de `executeRun`**

Dans `src/lib/server/run-orchestrator.ts`, ajouter les imports manquants en tête :

```ts
import { existsSync } from 'node:fs';
import { runWorktreePath, workspaceRoot } from '$lib/server/workspace-paths';
```

Mettre à jour l'import de `run-events` pour inclure `getNextEventSeq` :

```ts
import { appendRunEvent, getNextEventSeq, type SdkMessage } from '$lib/server/run-events';
```

Remplacer **intégralement** la fonction `executeRun` (à partir de `export async function executeRun`) par :

```ts
export async function executeRun(runId: string): Promise<void> {
	const run = await prisma.run.findUnique({ where: { id: runId }, include: { project: true } });
	if (!run) throw new Error(`Run ${runId} not found`);
	const project = run.project;
	const isResume = Boolean(run.sessionId && run.pendingPrompt);
	const pending: Promise<void>[] = [];
	const interactionAbort = new AbortController();
	const interactionSetupTasks = new Set<Promise<unknown>>();
	const interactionAnswerTasks = new Set<Promise<unknown>>();

	function trackInteractionTask<T>(tasks: Set<Promise<unknown>>, task: Promise<T>): Promise<T> {
		const tracked = task.finally(() => {
			tasks.delete(tracked);
		});
		tasks.add(tracked);
		void tracked.catch(() => {});
		return task;
	}

	async function waitForInteractionTasks(propagateErrors: boolean): Promise<void> {
		while (interactionSetupTasks.size > 0 || interactionAnswerTasks.size > 0) {
			const tasks = [...interactionSetupTasks, ...interactionAnswerTasks];
			if (propagateErrors) {
				await Promise.all(tasks);
			} else {
				await Promise.allSettled(tasks);
			}
		}
	}

	async function abortAndSettleInteractionTasks(): Promise<void> {
		interactionAbort.abort();
		await waitForInteractionTasks(false);
	}

	// Réclame le job avec la bonne transition initiale.
	if (isResume) {
		if (
			!(await transitionRun(runId, RUN_STATUS.QUEUED, RUN_STATUS.RUNNING, { pendingPrompt: null }))
		) {
			return;
		}
	} else {
		if (
			!(await transitionRun(runId, RUN_STATUS.QUEUED, RUN_STATUS.PREPARING, {
				startedAt: new Date()
			}))
		) {
			return;
		}
	}

	try {
		// La reprise n'a besoin ni de mirror ni de clone : le checkout est déjà sur l'hôte.
		const token = isResume ? null : await getGithubTokenForUser(run.createdById);
		const auth = token ? await makeGitAuth(token) : null;
		try {
			let checkoutPath: string;
			let baseSha: string | undefined;

			if (isResume) {
				checkoutPath = runWorktreePath(workspaceRoot(), project.id, runId);
				if (!existsSync(checkoutPath)) {
					await transitionRun(runId, RUN_STATUS.RUNNING, RUN_STATUS.FAILED, {
						error: 'Run workspace is no longer available for resume',
						finishedAt: new Date()
					});
					return;
				}
			} else {
				const cloneUrl = token ? authedCloneUrl(project.cloneUrl) : project.cloneUrl;
				await ensureMirror(project.id, cloneUrl, auth?.env);
				const checkout = await createRunCheckout(project.id, runId, run.baseBranch, auth?.env);
				checkoutPath = checkout.checkoutPath;
				baseSha = checkout.baseSha;
			}

			const agentConfig = await buildRunAgentConfig(run.organizationId, project.id, {
				useProjectAgentConfig: run.useProjectAgentConfig
			});
			if (run.useProjectAgentConfig) {
				await materializeRunAgentConfig(checkoutPath, agentConfig);
			}

			if (!isResume) {
				if (
					!(await transitionRun(runId, RUN_STATUS.PREPARING, RUN_STATUS.RUNNING, {
						baseCommitSha: baseSha,
						agentConfigSnapshot: agentConfig.snapshot
					}))
				) {
					return;
				}
			}

			let seq = await getNextEventSeq(runId);
			let sessionId: string | undefined = run.sessionId ?? undefined;
			const env: Record<string, string> = {
				RUN_PROMPT: isResume ? run.pendingPrompt! : run.prompt,
				CLAUDE_CODE_OAUTH_TOKEN: privateEnv.CLAUDE_CODE_OAUTH_TOKEN ?? '',
				...agentConfig.secretEnv
			};
			if (run.model) env.RUN_MODEL = run.model;
			if (run.sessionId) env.RUN_RESUME_SESSION = run.sessionId;

			const timeoutMs = run.timeoutAt
				? Math.max(1000, run.timeoutAt.getTime() - Date.now())
				: DEFAULT_TIMEOUT_MS;
			const args = buildRunArgs({
				image: RUNNER_IMAGE,
				name: containerName(runId),
				workspacePath: checkoutPath,
				env
			});

			const containerResult = await runContainer(
				args,
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
						const setupTask = (async () => {
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
							await transitionRun(runId, RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_INPUT);
							const answerTask = (async () => {
								const response = await waitForRunInteractionAnswer(interaction.id, {
									signal: interactionAbort.signal
								});
								if (interactionAbort.signal.aborted) return;
								await control.sendControlMessage({
									type: 'interaction_response',
									toolUseId: msg.toolUseId,
									response
								});
								if (interactionAbort.signal.aborted) return;
								await transitionRun(runId, RUN_STATUS.AWAITING_INPUT, RUN_STATUS.RUNNING);
							})().catch((error: unknown) => {
								if (interactionAbort.signal.aborted) return;
								throw error;
							});
							trackInteractionTask(interactionAnswerTasks, answerTask);
						})();
						await trackInteractionTask(interactionSetupTasks, setupTask);
						return;
					}
					pending.push(appendRunEvent(runId, seq++, msg).catch(() => {}));
				},
				{ timeoutMs, name: containerName(runId) }
			);
			const { exitCode, timedOut } = containerResult;

			if (timedOut) {
				await abortAndSettleInteractionTasks();
				await Promise.all(pending);
				await cancelPendingRunInteractions(runId);
				await transitionRun(
					runId,
					[RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_INPUT],
					RUN_STATUS.TIMED_OUT,
					{
						error: 'Run exceeded the time limit',
						finishedAt: new Date()
					}
				);
			} else if (exitCode === 0) {
				await waitForInteractionTasks(true);
				await Promise.all(pending);
				const head = await getHeadSha(checkoutPath, auth?.env);
				await transitionRun(runId, RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_REVIEW, {
					headCommitSha: head,
					sessionId: sessionId ?? null,
					finishedAt: new Date()
				});
			} else {
				await abortAndSettleInteractionTasks();
				await Promise.all(pending);
				await cancelPendingRunInteractions(runId);
				await transitionRun(
					runId,
					[RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_INPUT],
					RUN_STATUS.FAILED,
					{
						error: `Container exited with code ${exitCode}`,
						finishedAt: new Date()
					}
				);
			}
		} finally {
			await auth?.cleanup();
		}
	} catch (err) {
		await abortAndSettleInteractionTasks();
		await Promise.allSettled(pending);
		await cancelPendingRunInteractions(runId);
		await transitionRun(
			runId,
			[RUN_STATUS.QUEUED, RUN_STATUS.PREPARING, RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_INPUT],
			RUN_STATUS.FAILED,
			{
				error: String((err as Error)?.message ?? err),
				finishedAt: new Date()
			}
		);
	}
}
```

- [ ] **Step 2: Mettre à jour les mocks du test orchestrateur**

Dans `tests/unit/lib/server/run-orchestrator.test.ts`, étendre le bloc `vi.hoisted` pour ajouter :

```ts
	getNextEventSeq: vi.fn(),
	runWorktreePath: vi.fn(),
	workspaceRoot: vi.fn(),
	existsSync: vi.fn()
```

Mettre à jour le mock `run-events` :

```ts
vi.mock('$lib/server/run-events', () => ({
	appendRunEvent: mocks.appendRunEvent,
	getNextEventSeq: mocks.getNextEventSeq
}));
```

Mettre à jour le mock `workspace-paths` :

```ts
vi.mock('$lib/server/workspace-paths', () => ({
	containerName: mocks.containerName,
	runWorktreePath: mocks.runWorktreePath,
	workspaceRoot: mocks.workspaceRoot
}));
```

Ajouter le mock de `node:fs` (après les autres `vi.mock`) :

```ts
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }));
```

Et, dans le `beforeEach` existant, donner une valeur par défaut à `getNextEventSeq` (renvoyer 0) afin de ne pas casser les tests « run frais » :

```ts
mocks.getNextEventSeq.mockResolvedValue(0);
```

- [ ] **Step 3: Ajouter le test du chemin resume**

Dans `tests/unit/lib/server/run-orchestrator.test.ts`, ajouter ce test (dans le `describe` principal). Il vérifie qu'une run resume saute mirror/checkout, continue le `seq`, relance le container avec le `pendingPrompt`, et repasse en `awaiting_review` :

```ts
it('resumes an awaiting_review run from the existing checkout without re-cloning', async () => {
	mocks.runFindUnique.mockResolvedValue({
		id: runId,
		createdById: 'u1',
		organizationId: 'org1',
		prompt: 'initial prompt',
		pendingPrompt: 'please continue',
		sessionId: 'sess-1',
		baseBranch: 'main',
		baseCommitSha: 'base-sha',
		model: null,
		useProjectAgentConfig: false,
		timeoutAt: null,
		project: { id: 'p1', cloneUrl: 'https://example.com/repo.git' }
	});
	mocks.runUpdateMany.mockResolvedValue({ count: 1 });
	mocks.getNextEventSeq.mockResolvedValue(9);
	mocks.workspaceRoot.mockReturnValue('/workspace-root');
	mocks.runWorktreePath.mockReturnValue('/workspace-root/p1/r1');
	mocks.existsSync.mockReturnValue(true);
	mocks.buildRunAgentConfig.mockResolvedValue({ secretEnv: {}, snapshot: {} });
	mocks.buildRunArgs.mockReturnValue(['arg']);
	mocks.containerName.mockReturnValue('dotweaver-run-r1');
	mocks.getHeadSha.mockResolvedValue('new-head');
	mocks.runContainer.mockResolvedValue({ exitCode: 0, timedOut: false });

	await executeRun(runId);

	// Pas de clone/mirror en resume.
	expect(mocks.ensureMirror).not.toHaveBeenCalled();
	expect(mocks.createRunCheckout).not.toHaveBeenCalled();
	// Le container tourne sur le checkout conservé.
	expect(mocks.buildRunArgs).toHaveBeenCalledWith(
		expect.objectContaining({
			workspacePath: '/workspace-root/p1/r1',
			env: expect.objectContaining({
				RUN_PROMPT: 'please continue',
				RUN_RESUME_SESSION: 'sess-1'
			})
		})
	);
	// Transition queued -> running avec effacement du pendingPrompt.
	expect(mocks.runUpdateMany).toHaveBeenCalledWith({
		where: { id: runId, status: { in: ['queued'] } },
		data: { pendingPrompt: null, status: 'running' }
	});
	// Retour en awaiting_review en fin de tour.
	expect(mocks.runUpdateMany).toHaveBeenCalledWith({
		where: { id: runId, status: { in: ['running'] } },
		data: expect.objectContaining({ status: 'awaiting_review', headCommitSha: 'new-head' })
	});
});
```

> Note : adapter les noms de champs du `mockResolvedValue` de `runFindUnique` à ceux déjà attendus par les autres tests du fichier (vérifier la forme exacte de l'objet `run` mocké en haut du fichier et compléter si nécessaire).

- [ ] **Step 4: Lancer le test orchestrateur complet**

Run: `bunx vitest run tests/unit/lib/server/run-orchestrator.test.ts`
Expected: PASS (tests existants + nouveau test resume).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/run-orchestrator.ts tests/unit/lib/server/run-orchestrator.test.ts
git commit -m "feat(runs): resume awaiting_review runs from preserved checkout"
```

---

## Task 8: Affichage de l'event `user_message`

**Files:**

- Modify: `src/lib/components/runs/run-event-display.ts`
- Test: `tests/unit/lib/components/runs/run-event-display.test.ts` (créer si absent)

- [ ] **Step 1: Écrire le test (qui échoue)**

Créer (ou compléter) `tests/unit/lib/components/runs/run-event-display.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { normalizeEvent } from '$lib/components/runs/run-event-display';

describe('normalizeEvent — user_message', () => {
	it('maps a user_message payload to a user_message display event', () => {
		expect(normalizeEvent({ type: 'user_message', text: 'please continue' })).toEqual([
			{ kind: 'user_message', text: 'please continue' }
		]);
	});

	it('tolerates a missing text field', () => {
		expect(normalizeEvent({ type: 'user_message' })).toEqual([{ kind: 'user_message', text: '' }]);
	});
});
```

- [ ] **Step 2: Lancer pour voir échouer**

Run: `bunx vitest run tests/unit/lib/components/runs/run-event-display.test.ts`
Expected: FAIL (le payload tombe sur la branche `raw`).

- [ ] **Step 3: Ajouter le kind et la branche**

Dans `src/lib/components/runs/run-event-display.ts`, ajouter au type `DisplayEvent` (par exemple après `assistant_text`) :

```ts
	| { kind: 'user_message'; text: string }
```

Dans `normalizeEvent`, ajouter avant `if (type === 'result')` :

```ts
if (type === 'user_message') {
	return [{ kind: 'user_message', text: String(p.text ?? '') }];
}
```

- [ ] **Step 4: Lancer pour voir passer**

Run: `bunx vitest run tests/unit/lib/components/runs/run-event-display.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/runs/run-event-display.ts tests/unit/lib/components/runs/run-event-display.test.ts
git commit -m "feat(runs): normalize user_message events"
```

---

## Task 9: Rendu `user_message` dans `RunEvent.svelte`

**Files:**

- Modify: `src/lib/components/runs/RunEvent.svelte`

- [ ] **Step 1: Importer une icône utilisateur**

Dans le bloc d'import `@lucide/svelte` de `RunEvent.svelte`, ajouter `User` :

```ts
(Braces, User);
```

- [ ] **Step 2: Ajouter la branche de rendu**

Ajouter, juste après le bloc `{:else if event.kind === 'assistant_text'}` :

```svelte
{:else if event.kind === 'user_message'}
	<div class="ml-auto max-w-[85%] rounded-md border bg-primary/5 px-3.5 py-3 shadow-sm">
		<div class="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
			<User class="h-3.5 w-3.5 shrink-0" />
			You
		</div>
		<Markdown source={event.text} />
	</div>
```

- [ ] **Step 3: Vérifier le composant via le MCP Svelte**

Utiliser l'outil `svelte-autofixer` sur le contenu de `RunEvent.svelte` et corriger les éventuels problèmes signalés jusqu'à ce qu'il n'en reste plus.

- [ ] **Step 4: Vérifier types + lint**

Run: `bun run check && bunx eslint src/lib/components/runs/RunEvent.svelte`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/runs/RunEvent.svelte
git commit -m "feat(runs): render user_message as a user bubble"
```

---

## Task 10: Composer de réponse dans la page run

**Files:**

- Modify: `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`

- [ ] **Step 1: Importer `replyToRun`**

Dans le bloc d'import des remote functions (lignes 4-10), ajouter `replyToRun` :

```ts
import {
	getRun,
	getRunDiff,
	approveRun,
	cancelRun,
	answerRunInteraction,
	replyToRun
} from '$lib/rfc/runs.remote';
```

- [ ] **Step 2: Étendre l'état UI**

Dans le type `RunUiState` (vers ligne 31), ajouter :

```ts
replying: boolean;
replyError: string | null;
```

Et dans `defaultUiState` (vers ligne 40) :

```ts
		replying: false,
		replyError: null
```

- [ ] **Step 3: Ajouter l'état local du champ + le handler**

Après la déclaration `const ui = $derived(...)` (vers ligne 55), ajouter un état pour le texte saisi :

```ts
let replyText = $state('');
```

Après la fonction `answerInteraction` (vers ligne 169), ajouter :

```ts
async function sendReply() {
	const runId = currentRunId;
	const message = replyText.trim();
	if (!message) return;
	setRunUiState(runId, { replying: true, replyError: null });
	try {
		await replyToRun({ runId, message });
		replyText = '';
		clearLiveEventsForRun(runId);
		await getRun(runId).refresh();
		scheduleResumeRefresh(runId);
	} catch (e) {
		setRunUiState(runId, {
			replyError: e instanceof Error ? e.message : 'Could not send your reply'
		});
	} finally {
		setRunUiState(runId, { replying: false });
	}
}
```

- [ ] **Step 4: Ajouter le composer dans la section review**

Dans le bloc `{#if isReview}` (section `Review changes`), juste avant la fermeture `</section>` (ligne 275), ajouter le composer :

```svelte
<div class="space-y-2 border-t pt-3">
	<h3 class="text-sm font-medium">Reply to the agent</h3>
	<p class="text-xs text-muted-foreground">
		Send a message to continue this run — the agent resumes the same session.
	</p>
	{#if ui.replyError}
		<p class="text-sm text-red-500">{ui.replyError}</p>
	{/if}
	<textarea
		bind:value={replyText}
		rows="3"
		placeholder="Type your reply…"
		disabled={ui.replying}
		class="w-full rounded-md border bg-background p-2 text-sm"
	></textarea>
	<div class="flex justify-end">
		<Button onclick={sendReply} disabled={ui.replying || !replyText.trim()}>
			{ui.replying ? 'Sending…' : 'Send reply'}
		</Button>
	</div>
</div>
```

- [ ] **Step 5: Vérifier le composant via le MCP Svelte**

Utiliser l'outil `svelte-autofixer` sur le contenu de `+page.svelte` et corriger jusqu'à plus aucun problème.

- [ ] **Step 6: Vérifier types + lint**

Run: `bun run check && bunx eslint "src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add "src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte"
git commit -m "feat(runs): add reply composer on awaiting_review runs"
```

---

## Task 11: Vérification globale

**Files:** (aucun nouveau)

- [ ] **Step 1: Suite de tests unitaires complète**

Run: `bun run test:unit -- --run`
Expected: PASS (toute la suite).

- [ ] **Step 2: Typecheck**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 3: Lint + format**

Run: `bun run lint`
Expected: PASS. Si `prettier --check` échoue, lancer `bun run format` puis re-commit.

- [ ] **Step 4: Vérification manuelle (E2E manuel)**

Démarrer l'app + le runner (`bun run dev` et `bun run runner`), lancer un run dont le prompt amène l'agent à terminer son tour par une question en texte libre. Quand le run est en `awaiting_review` :

1. Vérifier que la bulle « You » n'apparaît pas encore et que le composer « Reply to the agent » est visible.
2. Envoyer une réponse → le statut passe à `running`, la bulle `user_message` apparaît dans le fil, puis les nouveaux events de l'agent s'enchaînent (seq continu, pas de doublon).
3. À la fin du nouveau tour, le run revient en `awaiting_review` avec un diff à jour ; on peut re-répondre ou pousser/abandonner.

- [ ] **Step 5: Commit final (si format/lint a modifié des fichiers)**

```bash
git add -A
git commit -m "chore(runs): formatting after conversational reply feature"
```

---

## Self-review (rempli par l'auteur du plan)

- **Couverture du spec** : schéma (`pendingPrompt`, enum) → Task 1 ; transitions → Task 2 ; `seq` continu + classification → Task 3 ; commande `replyToRun` + gardes → Tasks 4-6 ; orchestrateur resume (skip checkout, RUN_PROMPT, clear pendingPrompt, checkout manquant → failed) → Task 7 ; UI composer + bulle → Tasks 8-10 ; tests transitions/gardes/seq/normalisation + E2E manuel → Tasks 2,3,4,5,7,8,11. Concurrence reply vs approve : gérée par la transition gardée (Task 4, test « concurrent action ») et `approveRun` exige `awaiting_review` (existant).
- **Placeholders** : aucun TODO/TBD ; tout le code est fourni.
- **Cohérence des types** : `replyToRunForOrg(organizationId, { runId, message, timeoutAt })` retourne `{ runId, projectId } | null` — utilisé tel quel par la commande (Task 6). `getNextEventSeq(runId): Promise<number>` utilisé en Tasks 4 et 7. `DisplayEvent` kind `user_message` (Task 8) consommé par `RunEvent.svelte` (Task 9). `RunReplyError` exporté (Task 4) et importé (Task 6).
