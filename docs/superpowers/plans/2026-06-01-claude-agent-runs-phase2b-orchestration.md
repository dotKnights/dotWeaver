# DOT-16 Phase 2B — Orchestration & déclenchement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relier les primitives de la Phase 2A à l'app : un worker pg-boss qui exécute un run (mirror → checkout → conteneur agent → persistance des events → `awaiting_review`), déclenché depuis l'UI par un bouton « Run », avec affichage du statut final (sans live stream — Phase 3).

**Architecture:** Une file pg-boss (Postgres) ; un process worker séparé (`src/runner/`) lancé via `vite-node` (résout les alias SvelteKit `$lib`/`$env`). La remote function `startRun` crée un `Run` (`queued`) et l'enqueue ; le worker appelle `executeRun(runId)` qui orchestre les primitives 2A, persiste chaque message SDK en `RunEvent` (seq monotone), capte `session_id`/`head`, et passe le run en `awaiting_review`. Auth GitHub pour le clone via un `GIT_ASKPASS` éphémère (token jamais écrit en config/URL).

**Tech Stack:** SvelteKit 5 (remote functions), Prisma 7 + PostgreSQL, pg-boss v10, vite-node, zod 4, vitest. Réutilise les modules 2A : `workspace`, `docker`, `workspace-paths`.

**Prérequis :** Phase 2A mergée/présente sur la branche (modules `workspace.ts`, `docker.ts`, `workspace-paths.ts`, image `dotweaver-runner`). Les modèles `Run`/`RunEvent` existent (Phase 1).

**Périmètre (aligné sur le découpage du design) :** déclenchement + exécution + persistance des events + statut. **Hors périmètre (Phase 5 — Robustesse) :** annulation, timeout, crash recovery, quotas, resume/fork côté UI. **Hors périmètre (Phase 3) :** live stream SSE. **Hors périmètre (Phase 4) :** diff/push/PR + nettoyage du checkout (on **garde** le checkout après le run pour le diff à venir).

**Dette MVP assumée :** enqueue non transactionnel avec la création du `Run` (petite fenêtre at-least-once — durcissement Phase 5) ; refresh de token GitHub non géré (les tokens OAuth GitHub n'expirent pas par défaut).

---

### Task 1: Dépendances + file pg-boss + script worker

**Files:**

- Modify: `package.json`
- Create: `src/lib/server/queue.ts`

- [ ] **Step 1: Installer les dépendances**

Run: `bun add pg-boss && bun add -d vite-node`
Expected: `pg-boss` en dependencies, `vite-node` en devDependencies.

- [ ] **Step 2: Ajouter le script worker à `package.json`**

Dans la section `scripts`, ajouter :

```json
"runner": "vite-node src/runner/index.ts",
```

- [ ] **Step 3: Implémenter `src/lib/server/queue.ts`**

Lit la connexion depuis `process.env.DATABASE_URL` (pas `$env`, pour découpler le worker des alias SvelteKit).

```ts
// src/lib/server/queue.ts
import PgBoss from 'pg-boss';

export const RUN_QUEUE = 'run-execute';

export function makeBoss(): PgBoss {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) throw new Error('DATABASE_URL is required for the job queue');
	return new PgBoss(connectionString);
}

/** Crée la file si absente. `createQueue` est prévue pour être appelée une fois ; on ignore les répétitions. */
export async function ensureRunQueue(boss: PgBoss): Promise<void> {
	try {
		await boss.createQueue(RUN_QUEUE);
	} catch {
		// déjà créée — ignore
	}
}

let sender: PgBoss | null = null;

/** Enqueue un run depuis le contexte SvelteKit (sender singleton démarré paresseusement). */
export async function enqueueRun(runId: string): Promise<void> {
	if (!sender) {
		sender = makeBoss();
		await sender.start();
		await ensureRunQueue(sender);
	}
	await sender.send(RUN_QUEUE, { runId });
}
```

- [ ] **Step 4: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock src/lib/server/queue.ts
git commit -m "feat(queue): pg-boss queue helpers + runner script (DOT-16 P2B)"
```

---

### Task 2: Machine à états du run (TDD)

**Files:**

- Create: `src/lib/server/run-state.ts`
- Test: `src/lib/server/run-state.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// src/lib/server/run-state.test.ts
import { describe, it, expect } from 'vitest';
import { canTransition, assertTransition } from './run-state';

describe('run-state', () => {
	it('allows the happy path queued → preparing → running → awaiting_review', () => {
		expect(canTransition('queued', 'preparing')).toBe(true);
		expect(canTransition('preparing', 'running')).toBe(true);
		expect(canTransition('running', 'awaiting_review')).toBe(true);
	});

	it('forbids skipping states or going backwards', () => {
		expect(canTransition('queued', 'running')).toBe(false);
		expect(canTransition('completed', 'running')).toBe(false);
	});

	it('allows failure/cancel from active states', () => {
		expect(canTransition('running', 'failed')).toBe(true);
		expect(canTransition('preparing', 'canceled')).toBe(true);
		expect(canTransition('running', 'timed_out')).toBe(true);
	});

	it('assertTransition throws on an invalid transition', () => {
		expect(() => assertTransition('queued', 'completed')).toThrow(/Invalid run transition/);
	});
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/server/run-state.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

```ts
// src/lib/server/run-state.ts
import type { RunStatus } from '@prisma/client';

const TRANSITIONS: Record<RunStatus, RunStatus[]> = {
	queued: ['preparing', 'failed', 'canceled'],
	preparing: ['running', 'failed', 'canceled'],
	running: ['awaiting_review', 'failed', 'canceled', 'timed_out'],
	awaiting_review: ['pushing', 'completed', 'canceled'],
	pushing: ['completed', 'failed'],
	completed: [],
	failed: [],
	canceled: [],
	timed_out: []
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
	return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
	if (!canTransition(from, to)) {
		throw new Error(`Invalid run transition ${from} -> ${to}`);
	}
}
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/server/run-state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/run-state.ts src/lib/server/run-state.test.ts
git commit -m "feat(run): state machine transitions (DOT-16 P2B)"
```

---

### Task 3: Classification & persistance des events

**Files:**

- Create: `src/lib/server/run-events.ts`
- Test: `src/lib/server/run-events.test.ts`

La classification d'un message SDK → `RunEventType` est **pure** → TDD. `appendRunEvent` (insert Prisma) est couvert par le test end-to-end (Task 9).

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// src/lib/server/run-events.test.ts
import { describe, it, expect } from 'vitest';
import { classifyMessage } from './run-events';

describe('classifyMessage', () => {
	it('maps known SDK message types to RunEventType', () => {
		expect(classifyMessage({ type: 'assistant' })).toBe('assistant');
		expect(classifyMessage({ type: 'user' })).toBe('tool_result');
		expect(classifyMessage({ type: 'result' })).toBe('result');
		expect(classifyMessage({ type: 'error' })).toBe('error');
		expect(classifyMessage({ type: 'system' })).toBe('system');
	});

	it('falls back to system for unknown/missing types', () => {
		expect(classifyMessage({ type: 'runner_summary' })).toBe('system');
		expect(classifyMessage({})).toBe('system');
	});
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/server/run-events.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

```ts
// src/lib/server/run-events.ts
import type { Prisma, RunEventType } from '@prisma/client';
import { prisma } from '$lib/server/prisma';

export interface SdkMessage {
	type?: string;
	[key: string]: unknown;
}

/** Classe un message SDK (ou de l'entrypoint runner) dans notre enum RunEventType. */
export function classifyMessage(message: SdkMessage): RunEventType {
	switch (message.type) {
		case 'assistant':
			return 'assistant';
		case 'user':
			return 'tool_result';
		case 'result':
			return 'result';
		case 'error':
			return 'error';
		default:
			return 'system';
	}
}

/** Persiste un message comme RunEvent avec un seq monotone (fourni par l'appelant). */
export async function appendRunEvent(runId: string, seq: number, message: SdkMessage): Promise<void> {
	await prisma.runEvent.create({
		data: {
			runId,
			seq,
			type: classifyMessage(message),
			payload: message as Prisma.InputJsonValue
		}
	});
}
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/server/run-events.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/run-events.ts src/lib/server/run-events.test.ts
git commit -m "feat(run): SDK message classification + event persistence (DOT-16 P2B)"
```

---

### Task 4: Schéma zod de déclenchement (TDD)

**Files:**

- Create: `src/lib/schemas/runs.ts`
- Test: `src/lib/schemas/runs.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// src/lib/schemas/runs.test.ts
import { describe, it, expect } from 'vitest';
import { startRunSchema } from './runs';

describe('startRunSchema', () => {
	it('accepts a project id and a non-empty prompt', () => {
		expect(startRunSchema.safeParse({ projectId: 'p1', prompt: 'do it' }).success).toBe(true);
	});

	it('rejects an empty prompt', () => {
		expect(startRunSchema.safeParse({ projectId: 'p1', prompt: '' }).success).toBe(false);
	});

	it('rejects a missing project id', () => {
		expect(startRunSchema.safeParse({ prompt: 'do it' }).success).toBe(false);
	});
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/schemas/runs.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

```ts
// src/lib/schemas/runs.ts
import { z } from 'zod';

export const startRunSchema = z.object({
	projectId: z.string().min(1, 'Project is required'),
	prompt: z.string().min(1, 'A prompt is required')
});

export type StartRunSchema = typeof startRunSchema;
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/schemas/runs.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/schemas/runs.ts src/lib/schemas/runs.test.ts
git commit -m "feat(runs): start-run schema (DOT-16 P2B)"
```

---

### Task 5: Auth GitHub pour le clone (askpass éphémère)

**Files:**

- Create: `src/lib/server/github-git.ts`
- Test: `src/lib/server/github-git.test.ts`

`authedCloneUrl` est **pure** → TDD. `makeGitAuth` (script askpass temporaire) et `getGithubTokenForUser` (lecture Prisma) sont couverts par le end-to-end.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// src/lib/server/github-git.test.ts
import { describe, it, expect } from 'vitest';
import { authedCloneUrl } from './github-git';

describe('authedCloneUrl', () => {
	it('injects the x-access-token username into an https clone url', () => {
		expect(authedCloneUrl('https://github.com/o/r.git')).toBe('https://x-access-token@github.com/o/r.git');
	});

	it('leaves non-https urls unchanged', () => {
		expect(authedCloneUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
	});
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/server/github-git.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

```ts
// src/lib/server/github-git.ts
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '$lib/server/prisma';

/**
 * Injecte le username `x-access-token` dans une URL https → git demandera le mot de
 * passe via GIT_ASKPASS (le token n'apparaît jamais dans l'URL ni la config).
 */
export function authedCloneUrl(cloneUrl: string): string {
	if (!cloneUrl.startsWith('https://')) return cloneUrl;
	return cloneUrl.replace('https://', 'https://x-access-token@');
}

/** Lit le token GitHub de l'utilisateur (géré par better-auth dans la table Account). */
export async function getGithubTokenForUser(userId: string): Promise<string | null> {
	const account = await prisma.account.findFirst({
		where: { userId, providerId: 'github' },
		select: { accessToken: true }
	});
	return account?.accessToken ?? null;
}

export interface GitAuth {
	env: Record<string, string | undefined>;
	cleanup: () => Promise<void>;
}

/** Crée un GIT_ASKPASS éphémère (script temp 0700) fournissant le token. */
export async function makeGitAuth(token: string): Promise<GitAuth> {
	const dir = await mkdtemp(join(tmpdir(), 'dw-gitauth-'));
	const askpass = join(dir, 'askpass.sh');
	await writeFile(askpass, `#!/bin/sh\nprintf '%s' "${token}"\n`, { mode: 0o700 });
	return {
		env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0' },
		cleanup: () => rm(dir, { recursive: true, force: true })
	};
}
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/server/github-git.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/github-git.ts src/lib/server/github-git.test.ts
git commit -m "feat(github): ephemeral askpass auth for git clone (DOT-16 P2B)"
```

---

### Task 6: Orchestrateur `executeRun`

**Files:**

- Create: `src/lib/server/run-orchestrator.ts`

Intègre les primitives 2A. Pas de test unitaire dédié (orchestration IO/Docker) → couvert par le end-to-end (Task 9). Vérification ici = compilation.

- [ ] **Step 1: Implémenter**

```ts
// src/lib/server/run-orchestrator.ts
import { prisma } from '$lib/server/prisma';
import { ensureMirror, createRunCheckout, getHeadSha } from '$lib/server/workspace';
import { buildRunArgs, runContainer } from '$lib/server/docker';
import { appendRunEvent, type SdkMessage } from '$lib/server/run-events';
import { authedCloneUrl, getGithubTokenForUser, makeGitAuth } from '$lib/server/github-git';

const RUNNER_IMAGE = process.env.RUNNER_IMAGE ?? 'dotweaver-runner';

/**
 * Exécute un run de bout en bout : mirror → checkout → conteneur agent → events →
 * `awaiting_review`. Toute erreur → `failed` avec message. Le checkout est CONSERVÉ
 * (le diff/push de la Phase 4 en a besoin).
 */
export async function executeRun(runId: string): Promise<void> {
	const run = await prisma.run.findUnique({ where: { id: runId }, include: { project: true } });
	if (!run) throw new Error(`Run ${runId} not found`);
	const project = run.project;

	try {
		await prisma.run.update({
			where: { id: runId },
			data: { status: 'preparing', startedAt: new Date() }
		});

		// Auth GitHub pour le clone (repos privés). Repo public : pas de token requis.
		const token = await getGithubTokenForUser(run.createdById);
		const auth = token ? await makeGitAuth(token) : null;
		try {
			const cloneUrl = token ? authedCloneUrl(project.cloneUrl) : project.cloneUrl;
			await ensureMirror(project.id, cloneUrl, auth?.env);
			const { checkoutPath, baseSha } = await createRunCheckout(
				project.id,
				runId,
				project.defaultBranch,
				auth?.env
			);
			await prisma.run.update({
				where: { id: runId },
				data: { status: 'running', baseCommitSha: baseSha }
			});

			let seq = 0;
			let sessionId: string | undefined;
			const pending: Promise<void>[] = [];

			const env: Record<string, string> = {
				RUN_PROMPT: run.prompt,
				CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ''
			};
			if (run.model) env.RUN_MODEL = run.model;
			if (run.sessionId) env.RUN_RESUME_SESSION = run.sessionId;

			const args = buildRunArgs({
				image: RUNNER_IMAGE,
				name: `dwrun-${runId}`,
				workspacePath: checkoutPath,
				env
			});

			const { exitCode } = await runContainer(args, (line) => {
				let msg: SdkMessage;
				try {
					msg = JSON.parse(line);
				} catch {
					return;
				}
				if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
					sessionId = (msg as { session_id?: string }).session_id;
				}
				// seq attribué de façon synchrone → ordre garanti même si les inserts finissent dans le désordre.
				pending.push(appendRunEvent(runId, seq++, msg).catch(() => {}));
			});

			await Promise.all(pending);

			if (exitCode === 0) {
				const head = await getHeadSha(checkoutPath, auth?.env);
				await prisma.run.update({
					where: { id: runId },
					data: {
						status: 'awaiting_review',
						headCommitSha: head,
						sessionId: sessionId ?? null,
						finishedAt: new Date()
					}
				});
			} else {
				await prisma.run.update({
					where: { id: runId },
					data: {
						status: 'failed',
						error: `Container exited with code ${exitCode}`,
						finishedAt: new Date()
					}
				});
			}
		} finally {
			await auth?.cleanup();
		}
	} catch (err) {
		await prisma.run.update({
			where: { id: runId },
			data: { status: 'failed', error: String((err as Error)?.message ?? err), finishedAt: new Date() }
		});
	}
}
```

- [ ] **Step 2: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 3: Commit**

```bash
git add src/lib/server/run-orchestrator.ts
git commit -m "feat(run): executeRun orchestrator wiring 2A primitives (DOT-16 P2B)"
```

---

### Task 7: Process worker

**Files:**

- Create: `src/runner/index.ts`

- [ ] **Step 1: Implémenter le worker**

```ts
// src/runner/index.ts
import { makeBoss, RUN_QUEUE, ensureRunQueue } from '$lib/server/queue';
import { executeRun } from '$lib/server/run-orchestrator';

async function main() {
	const boss = makeBoss();
	boss.on('error', (e) => console.error('[runner] boss error', e));
	await boss.start();
	await ensureRunQueue(boss);

	await boss.work(RUN_QUEUE, { batchSize: 1 }, async ([job]) => {
		const { runId } = job.data as { runId: string };
		console.log('[runner] executing run', runId);
		await executeRun(runId);
		console.log('[runner] finished run', runId);
	});

	console.log('[runner] worker started, listening on', RUN_QUEUE);
}

main().catch((e) => {
	console.error('[runner] fatal', e);
	process.exit(1);
});
```

- [ ] **Step 2: Démarrer le worker (vérifie le boot + la résolution des alias `$lib`/`$env`)**

Prérequis : Postgres lancé, `.env` rempli, et `export CLAUDE_CODE_OAUTH_TOKEN=...` dans le shell du worker.

Run: `bun run runner`
Expected: logs `[runner] worker started, listening on run-execute`, sans erreur d'import. (Ctrl-C pour arrêter.)
Si `$env/dynamic/private` ne se résout pas sous vite-node, c'est un blocage à signaler : repli possible = instancier un `PrismaClient` dédié dans le worker lisant `process.env.DATABASE_URL` au lieu de réutiliser `$lib/server/prisma`. Ne pas appliquer ce repli sans confirmation.

- [ ] **Step 3: Commit**

```bash
git add src/runner/index.ts
git commit -m "feat(runner): pg-boss worker process (DOT-16 P2B)"
```

---

### Task 8: Remote functions des runs

**Files:**

- Create: `src/lib/rfc/runs.remote.ts`

Suit le pattern de `projects.remote.ts` (org-scoping via `requireActiveOrg`, `requireHeaders`).

- [ ] **Step 1: Implémenter**

```ts
// src/lib/rfc/runs.remote.ts
import { query, command, getRequestEvent } from '$app/server';
import { z } from 'zod';
import { error } from '@sveltejs/kit';
import { requireHeaders } from '$lib/server/utils';
import { requireActiveOrg } from '$lib/server/org';
import { prisma } from '$lib/server/prisma';
import { startRunSchema } from '$lib/schemas/runs';
import { agentBranch } from '$lib/server/workspace-paths';
import { enqueueRun } from '$lib/server/queue';

/** Crée un run (queued) sur un projet de l'org active et l'enqueue. */
export const startRun = command(startRunSchema, async ({ projectId, prompt }) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const { locals } = getRequestEvent();
	const project = await prisma.project.findFirst({ where: { id: projectId, organizationId } });
	if (!project) error(404, 'Project not found');

	// On génère l'id pour pouvoir dériver la branche `claude/<id>` à la création.
	const id = crypto.randomUUID();
	await prisma.run.create({
		data: {
			id,
			projectId,
			organizationId,
			createdById: locals.user!.id,
			prompt,
			agentBranch: agentBranch(id),
			status: 'queued'
		}
	});
	await enqueueRun(id);
	await listRuns(projectId).refresh();
	return { runId: id };
});

/** Runs d'un projet (org active), du plus récent au plus ancien. */
export const listRuns = query(z.string(), async (projectId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	return prisma.run.findMany({
		where: { projectId, organizationId },
		orderBy: { queuedAt: 'desc' },
		select: {
			id: true,
			status: true,
			prompt: true,
			queuedAt: true,
			finishedAt: true,
			error: true
		}
	});
});

/** Détail d'un run (org active) avec ses events ordonnés. */
export const getRun = query(z.string(), async (runId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const run = await prisma.run.findFirst({
		where: { id: runId, organizationId },
		include: { events: { orderBy: { seq: 'asc' } } }
	});
	if (!run) error(404, 'Run not found');
	return run;
});
```

- [ ] **Step 2: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 3: Commit**

```bash
git add src/lib/rfc/runs.remote.ts
git commit -m "feat(runs): start/list/get remote functions (DOT-16 P2B)"
```

---

### Task 9: UI — déclenchement & statut

**Files:**

- Modify: `src/routes/(app)/projects/[id]/+page.svelte`
- Create: `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`

- [ ] **Step 1: Ajouter le formulaire « Run » + la liste des runs à la page projet**

Remplacer le paragraphe placeholder `<p ...>Running agents on this project comes in the next phase.</p>` par le bloc ci-dessous (et compléter le `<script>` avec les imports/état). Le composant final :

```svelte
<!-- src/routes/(app)/projects/[id]/+page.svelte -->
<script lang="ts">
	import { page } from '$app/state';
	import { getProject } from '$lib/rfc/projects.remote';
	import { listRuns, startRun } from '$lib/rfc/runs.remote';
	import { Button } from '$lib/components/ui/button';

	const project = $derived(getProject(page.params.id!));
	const runs = $derived(listRuns(page.params.id!));

	let prompt = $state('');
	let starting = $state(false);
	let startError = $state<string | null>(null);

	async function handleStart() {
		if (!prompt.trim()) return;
		startError = null;
		starting = true;
		try {
			await startRun({ projectId: page.params.id!, prompt });
			prompt = '';
		} catch (e) {
			startError = e instanceof Error ? e.message : 'Failed to start run';
		} finally {
			starting = false;
		}
	}
</script>

<div class="mx-auto max-w-3xl space-y-6 p-6">
	{#if project.error}
		<p class="text-sm text-red-500">{project.error.message}</p>
	{:else if project.current}
		<div class="flex items-center justify-between">
			<h1 class="text-2xl font-semibold">{project.current.owner}/{project.current.name}</h1>
			<a href="/projects" class="text-sm hover:underline">← Projects</a>
		</div>
		<dl class="grid grid-cols-2 gap-2 text-sm">
			<dt class="text-muted-foreground">Default branch</dt>
			<dd>{project.current.defaultBranch}</dd>
			<dt class="text-muted-foreground">Visibility</dt>
			<dd>{project.current.private ? 'Private' : 'Public'}</dd>
		</dl>

		<section class="space-y-2">
			<h2 class="text-lg font-medium">Run an agent</h2>
			{#if startError}
				<p class="text-sm text-red-500">{startError}</p>
			{/if}
			<textarea
				bind:value={prompt}
				rows="3"
				placeholder="Describe what the agent should do…"
				class="w-full rounded-md border border-input bg-transparent p-2 text-sm"
			></textarea>
			<Button onclick={handleStart} disabled={starting || !prompt.trim()}>
				{starting ? 'Starting…' : 'Run'}
			</Button>
		</section>

		<section class="space-y-2">
			<h2 class="text-lg font-medium">Runs</h2>
			{#if runs.current}
				{#if runs.current.length === 0}
					<p class="text-sm text-muted-foreground">No runs yet.</p>
				{:else}
					<ul class="space-y-2">
						{#each runs.current as run (run.id)}
							<li>
								<a
									href={`/projects/${page.params.id}/runs/${run.id}`}
									class="flex items-center justify-between rounded-md border p-3 hover:bg-accent"
								>
									<span class="truncate text-sm">{run.prompt}</span>
									<span class="ml-3 shrink-0 text-xs text-muted-foreground">{run.status}</span>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			{:else}
				<p class="text-sm text-muted-foreground">Loading runs…</p>
			{/if}
		</section>
	{:else}
		<p class="text-sm text-muted-foreground">Loading project…</p>
	{/if}
</div>
```

- [ ] **Step 2: Autofixer Svelte sur la page projet**

Lancer le MCP Svelte `svelte-autofixer` (charger via `ToolSearch` query `select:mcp__svelte__svelte-autofixer` si besoin) sur le composant jusqu'à 0 issue.

- [ ] **Step 3: Créer la page détail d'un run**

```svelte
<!-- src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte -->
<script lang="ts">
	import { page } from '$app/state';
	import { getRun } from '$lib/rfc/runs.remote';

	const run = $derived(getRun(page.params.runId!));

	function summarize(payload: unknown): string {
		const text = JSON.stringify(payload);
		return text.length > 300 ? text.slice(0, 300) + '…' : text;
	}
</script>

<div class="mx-auto max-w-3xl space-y-4 p-6">
	{#if run.error}
		<p class="text-sm text-red-500">{run.error.message}</p>
	{:else if run.current}
		<div class="flex items-center justify-between">
			<h1 class="text-xl font-semibold">Run</h1>
			<a href={`/projects/${page.params.id}`} class="text-sm hover:underline">← Project</a>
		</div>
		<dl class="grid grid-cols-2 gap-2 text-sm">
			<dt class="text-muted-foreground">Status</dt>
			<dd>{run.current.status}</dd>
			<dt class="text-muted-foreground">Branch</dt>
			<dd>{run.current.agentBranch}</dd>
		</dl>
		{#if run.current.error}
			<p class="text-sm text-red-500">{run.current.error}</p>
		{/if}
		<div>
			<h2 class="mb-1 text-sm font-medium">Prompt</h2>
			<pre class="whitespace-pre-wrap rounded-md border p-2 text-xs">{run.current.prompt}</pre>
		</div>
		<div>
			<h2 class="mb-1 text-sm font-medium">Events</h2>
			{#if run.current.events.length === 0}
				<p class="text-sm text-muted-foreground">No events recorded.</p>
			{:else}
				<ul class="space-y-1">
					{#each run.current.events as event (event.id)}
						<li class="rounded border p-2 text-xs">
							<span class="font-mono text-muted-foreground">{event.type}</span>
							<div class="mt-1 break-all">{summarize(event.payload)}</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{:else}
		<p class="text-sm text-muted-foreground">Loading run…</p>
	{/if}
</div>
```

- [ ] **Step 4: Autofixer Svelte sur la page run**

Lancer `svelte-autofixer` sur ce composant jusqu'à 0 issue.

- [ ] **Step 5: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 6: Commit**

```bash
git add "src/routes/(app)/projects/[id]/+page.svelte" "src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte"
git commit -m "feat(runs): run trigger form + status/detail UI (DOT-16 P2B)"
```

---

### Task 10: Vérification + end-to-end manuel

- [ ] **Step 1: Suite unitaire complète**

Run: `bun run test:unit -- --run`
Expected: tous verts (run-state, run-events, runs schema, github-git + existants).

- [ ] **Step 2: Lint des nouveaux modules**

Run: `bunx eslint src/lib/server/queue.ts src/lib/server/run-state.ts src/lib/server/run-events.ts src/lib/server/github-git.ts src/lib/server/run-orchestrator.ts src/runner/index.ts src/lib/rfc/runs.remote.ts src/lib/schemas/runs.ts`
Expected: 0 erreur.

- [ ] **Step 3: Format**

Run: `bunx prettier --write` sur les fichiers créés/modifiés de cette phase, puis commit si changement.

- [ ] **Step 4: End-to-end manuel** (nécessite Docker + image `dotweaver-runner` + `CLAUDE_CODE_OAUTH_TOKEN`)

1. Terminal A : `bun run dev`.
2. Terminal B : `export CLAUDE_CODE_OAUTH_TOKEN=...` puis `bun run runner`.
3. UI : se connecter (GitHub, scope `repo`), équipe active, importer un repo, ouvrir le projet.
4. Saisir un prompt simple (« Create a file NOTES.md with one line and stop. ») → **Run**.
5. Le run apparaît `queued` → (worker) `preparing` → `running` → `awaiting_review`. Rafraîchir la page run pour suivre (pas de live — Phase 3).
6. Vérifier : la page run liste des events ; `headCommitSha` renseigné ; un commit existe sur `claude/<runId>` dans le checkout sous `$WORKSPACE_ROOT/<projectId>/runs/<runId>`.

- [ ] **Step 5: Commit final éventuel** (format)

---

## Couverture du périmètre Phase 2B

- ✅ File pg-boss + worker via vite-node (Tasks 1, 7)
- ✅ Machine à états (Task 2)
- ✅ Classification + persistance des events (Task 3)
- ✅ Schéma + remote functions start/list/get (Tasks 4, 8)
- ✅ Auth GitHub clone (askpass éphémère) (Task 5)
- ✅ Orchestrateur executeRun (Task 6)
- ✅ UI déclenchement + statut + détail (Task 9)
- ✅ End-to-end manuel (Task 10)
- ⏭️ Phase 3 : live stream SSE (`LISTEN/NOTIFY` + endpoint + UI temps réel).
- ⏭️ Phase 4 : diff → push → PR + nettoyage du checkout.
- ⏭️ Phase 5 : annulation, timeout, crash recovery, quotas, resume/fork UI, durcissement (egress, rootfs ro, uid mapping).
