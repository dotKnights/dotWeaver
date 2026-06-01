# DOT-16 Phase 5 (slice 1) — Robustesse d'exécution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre le runner fiable : (A) un **filet anti-crash** pour que plus aucune rejection non gérée ne tue le serveur/worker, et (B) un **cycle de vie des runs** complet — annulation, timeout mural, et reprise après crash du worker.

**Architecture:** (A) On installe un handler `unhandledRejection`/`uncaughtException` (log, pas de crash) dans le serveur SvelteKit (`hooks.server.ts`) et le worker (`src/runner`). (B) Les transitions d'état du run deviennent **conditionnelles** (`updateMany` gardé par le statut courant) pour qu'une annulation/timeout ne soit jamais écrasée ; `cancelRun` pose `canceled` puis `docker kill` ; le timeout est appliqué dans `runContainer` (kill après N ms) → `timed_out` ; au démarrage le worker marque `failed` les runs actifs orphelins.

**Tech Stack:** SvelteKit (hooks, remote functions), Prisma (`updateMany` conditionnel), Docker CLI, vitest. Réutilise `docker`, `run-state`, `workspace-paths`, l'orchestrateur et le worker des phases 2.

**Prérequis :** Phases 1–4 + le fix DOT-16. Branche empilée sur `dot-16-phase3-live-stream`.

**Décisions cadrées (dev interne) :** timeout par défaut **30 min** (`RUN_TIMEOUT_MS`, configurable) ; crash-recovery = **marquer `failed`** les runs actifs orphelins (pas de requeue → évite les doublons) ; annulation = **`docker kill` immédiat**. Durcissement sécurité (egress, rootfs ro, non-root) = slice ultérieure.

---

## Partie A — Filet anti-crash

### Task 1: Helper `installProcessSafetyNet` (TDD)

**Files:**

- Create: `src/lib/server/process-safety.ts`
- Test: `src/lib/server/process-safety.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// src/lib/server/process-safety.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installProcessSafetyNet } from './process-safety';

afterEach(() => {
	process.removeAllListeners('unhandledRejection');
	process.removeAllListeners('uncaughtException');
	vi.restoreAllMocks();
});

describe('installProcessSafetyNet', () => {
	it('registers unhandledRejection + uncaughtException listeners once (idempotent)', () => {
		installProcessSafetyNet('test');
		installProcessSafetyNet('test'); // 2e appel = no-op
		expect(process.listenerCount('unhandledRejection')).toBe(1);
		expect(process.listenerCount('uncaughtException')).toBe(1);
	});

	it('logs the rejection instead of rethrowing (no crash)', () => {
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		installProcessSafetyNet('test');
		// simulate node emitting the event
		expect(() => process.emit('unhandledRejection', new Error('boom'), Promise.resolve())).not.toThrow();
		expect(err).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/server/process-safety.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

```ts
// src/lib/server/process-safety.ts
let installed = false;

/**
 * Installe un filet de sécurité au niveau process : on LOG les rejections/exceptions
 * non gérées au lieu de laisser Node crasher (mode --unhandled-rejections=throw).
 * Idempotent. À appeler une fois au boot du serveur SvelteKit et du worker.
 *
 * Note : on ne masque rien silencieusement — chaque incident est loggué bien visiblement
 * pour investigation. C'est un garde-fou, pas une excuse pour ignorer les erreurs.
 */
export function installProcessSafetyNet(label: string): void {
	if (installed) return;
	installed = true;
	process.on('unhandledRejection', (reason) => {
		console.error(`[${label}] UNHANDLED REJECTION (caught by safety net):`, reason);
	});
	process.on('uncaughtException', (err) => {
		console.error(`[${label}] UNCAUGHT EXCEPTION (caught by safety net):`, err);
	});
}
```

- [ ] **Step 4: Lancer, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/server/process-safety.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/process-safety.ts src/lib/server/process-safety.test.ts
git commit -m "feat(safety): process-level unhandled-rejection safety net (DOT-16 P5)"
```

---

### Task 2: Brancher le filet dans le serveur + le worker

**Files:**

- Modify: `src/hooks.server.ts`
- Modify: `src/runner/index.ts`

- [ ] **Step 1: `src/hooks.server.ts` — installer le filet au chargement du module**

Ajouter en haut du fichier (après les imports existants), un appel au niveau module (s'exécute une fois à l'init du serveur) :

```ts
import { installProcessSafetyNet } from '$lib/server/process-safety';

installProcessSafetyNet('sveltekit');
```

(Conserver le `handle` existant inchangé.)

- [ ] **Step 2: `src/runner/index.ts` — idem dans le worker**

Au tout début de `main()` (avant `makeBoss()`), ajouter :

```ts
import { installProcessSafetyNet } from '$lib/server/process-safety';
// …
async function main() {
	installProcessSafetyNet('runner');
	// … reste inchangé
}
```

- [ ] **Step 3: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 4: Commit**

```bash
git add src/hooks.server.ts src/runner/index.ts
git commit -m "feat(safety): install safety net in server + worker (DOT-16 P5)"
```

---

## Partie B — Cycle de vie des runs

### Task 3: Helper `containerName` (TDD) + l'utiliser dans l'orchestrateur

**Files:**

- Modify: `src/lib/server/workspace-paths.ts`
- Modify: `src/lib/server/workspace-paths.test.ts`
- Modify: `src/lib/server/run-orchestrator.ts`

- [ ] **Step 1: Ajouter le test (au fichier existant)**

Ajouter à `src/lib/server/workspace-paths.test.ts` :

```ts
import { agentBranch, containerName } from './workspace-paths';

describe('containerName', () => {
	it('derives a deterministic docker container name from the run id', () => {
		expect(containerName('run1')).toBe('dwrun-run1');
	});
});
```

(Ajuster la ligne d'import existante pour inclure `containerName`.)

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/server/workspace-paths.test.ts`
Expected: FAIL — `containerName` introuvable.

- [ ] **Step 3: Implémenter dans `workspace-paths.ts`**

```ts
/** Nom de conteneur Docker déterministe pour un run (kill par nom à l'annulation/timeout). */
export function containerName(runId: string): string {
	return `dwrun-${runId}`;
}
```

- [ ] **Step 4: Utiliser le helper dans l'orchestrateur**

Dans `src/lib/server/run-orchestrator.ts`, importer `containerName` depuis `$lib/server/workspace-paths` (ajouter à l'import existant `runWorktreePath`/`workspaceRoot`… non — l'orchestrateur importe depuis `./workspace`/`./docker`. Ajouter `import { containerName } from '$lib/server/workspace-paths';`) et remplacer la chaîne en dur :

```ts
// avant : name: `dwrun-${runId}`
const args = buildRunArgs({
	image: RUNNER_IMAGE,
	name: containerName(runId),
	workspacePath: checkoutPath,
	env
});
```

- [ ] **Step 5: Lancer le test + check**

Run: `bun run test:unit -- --run src/lib/server/workspace-paths.test.ts` → PASS
Run: `bun run check` → 0 erreur

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/workspace-paths.ts src/lib/server/workspace-paths.test.ts src/lib/server/run-orchestrator.ts
git commit -m "feat(run): containerName helper used by orchestrator (DOT-16 P5)"
```

---

### Task 4: Timeout dans `runContainer`

**Files:**

- Modify: `src/lib/server/docker.ts`

- [ ] **Step 1: Étendre `runContainer` (timeout + flag timedOut)**

Remplacer la signature/impl de `runContainer` et `RunContainerResult` :

```ts
export interface RunContainerResult {
	exitCode: number;
	timedOut: boolean;
}

export interface RunContainerOptions {
	/** Au-delà de ce délai, on `docker kill` le conteneur (nommé `name`) et on résout avec timedOut=true. */
	timeoutMs?: number;
	/** Nom du conteneur (pour le kill). Requis si timeoutMs est fourni. */
	name?: string;
}

export function runContainer(
	args: string[],
	onLine: (line: string) => void,
	options: RunContainerOptions = {},
	onStderr?: (line: string) => void
): Promise<RunContainerResult> {
	const child = spawn('docker', args);
	const out = createInterface({ input: child.stdout });
	out.on('line', onLine);
	if (onStderr) {
		const err = createInterface({ input: child.stderr });
		err.on('line', onStderr);
	}
	let timedOut = false;
	let timer: NodeJS.Timeout | undefined;
	if (options.timeoutMs && options.name) {
		const name = options.name;
		timer = setTimeout(() => {
			timedOut = true;
			void killContainer(name);
		}, options.timeoutMs);
	}
	return new Promise((resolve, reject) => {
		child.on('error', (e) => {
			if (timer) clearTimeout(timer);
			reject(e);
		});
		child.on('close', (code) => {
			if (timer) clearTimeout(timer);
			resolve({ exitCode: code ?? -1, timedOut });
		});
	});
}
```

(`killContainer` existe déjà dans ce fichier.)

- [ ] **Step 2: Vérifier la compilation** (l'orchestrateur consomme l'ancien `{ exitCode }` — il sera mis à jour en Task 5 ; pour l'instant `bun run check` peut signaler l'usage. Si c'est le cas, c'est attendu et corrigé en Task 5. Pour garder l'arbre vert entre tâches, faire Task 5 juste après.)

Run: `bun run check`
Expected: peut signaler `timedOut` manquant côté orchestrateur — sera résolu en Task 5. (Ne pas committer un arbre rouge : enchaîner Task 5 puis committer ensemble si besoin. Sinon, si check est vert, committer ici.)

- [ ] **Step 3: Commit** (si check vert ; sinon committer avec Task 5)

```bash
git add src/lib/server/docker.ts
git commit -m "feat(docker): runContainer wall-clock timeout (DOT-16 P5)"
```

---

### Task 5: Orchestrateur — transitions conditionnelles + timeout

**Files:**

- Modify: `src/lib/server/run-orchestrator.ts`

On rend les transitions **conditionnelles** (via `updateMany` gardé par le statut courant) pour qu'une annulation/timeout concurrente ne soit jamais écrasée, et on applique le timeout.

- [ ] **Step 1: Réécrire `executeRun`**

```ts
import { prisma } from '$lib/server/prisma';
import { ensureMirror, createRunCheckout, getHeadSha } from '$lib/server/workspace';
import { buildRunArgs, runContainer } from '$lib/server/docker';
import { appendRunEvent, type SdkMessage } from '$lib/server/run-events';
import { authedCloneUrl, getGithubTokenForUser, makeGitAuth } from '$lib/server/github-git';
import { containerName } from '$lib/server/workspace-paths';
import type { RunStatus } from '@prisma/client';

const RUNNER_IMAGE = process.env.RUNNER_IMAGE ?? 'dotweaver-runner';
const DEFAULT_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 30 * 60 * 1000);

/** Transition conditionnelle : n'écrit que si le run est encore au statut `from`. Renvoie true si appliquée. */
async function transition(
	runId: string,
	from: RunStatus | RunStatus[],
	data: Record<string, unknown>
): Promise<boolean> {
	const res = await prisma.run.updateMany({
		where: { id: runId, status: { in: Array.isArray(from) ? from : [from] } },
		data
	});
	return res.count > 0;
}

export async function executeRun(runId: string): Promise<void> {
	const run = await prisma.run.findUnique({ where: { id: runId }, include: { project: true } });
	if (!run) throw new Error(`Run ${runId} not found`);
	const project = run.project;

	// queued → preparing ; si déjà annulé entre-temps, on abandonne.
	if (!(await transition(runId, 'queued', { status: 'preparing', startedAt: new Date() }))) return;

	try {
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

			// preparing → running ; si annulé pendant le clone, on abandonne (et on nettoie).
			if (!(await transition(runId, 'preparing', { status: 'running', baseCommitSha: baseSha }))) {
				return;
			}

			let seq = 0;
			let sessionId: string | undefined;
			const pending: Promise<void>[] = [];
			const env: Record<string, string> = {
				RUN_PROMPT: run.prompt,
				CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ''
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

			const { exitCode, timedOut } = await runContainer(
				args,
				(line) => {
					let msg: SdkMessage;
					try {
						msg = JSON.parse(line);
					} catch {
						return;
					}
					if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
						sessionId = (msg as { session_id?: string }).session_id;
					}
					pending.push(appendRunEvent(runId, seq++, msg).catch(() => {}));
				},
				{ timeoutMs, name: containerName(runId) }
			);
			await Promise.all(pending);

			// running → terminal ; gardé pour ne pas écraser un `canceled` concurrent.
			if (timedOut) {
				await transition(runId, 'running', {
					status: 'timed_out',
					error: `Run exceeded the time limit`,
					finishedAt: new Date()
				});
			} else if (exitCode === 0) {
				const head = await getHeadSha(checkoutPath, auth?.env);
				await transition(runId, 'running', {
					status: 'awaiting_review',
					headCommitSha: head,
					sessionId: sessionId ?? null,
					finishedAt: new Date()
				});
			} else {
				await transition(runId, 'running', {
					status: 'failed',
					error: `Container exited with code ${exitCode}`,
					finishedAt: new Date()
				});
			}
		} finally {
			await auth?.cleanup();
		}
	} catch (err) {
		// échec inattendu : ne pas écraser un statut terminal (canceled/…).
		await transition(runId, ['queued', 'preparing', 'running'], {
			status: 'failed',
			error: String((err as Error)?.message ?? err),
			finishedAt: new Date()
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
git commit -m "feat(run): conditional transitions + wall-clock timeout in executeRun (DOT-16 P5)"
```

---

### Task 6: `cancelRun` remote function + `timeoutAt` à l'enqueue

**Files:**

- Modify: `src/lib/rfc/runs.remote.ts`

- [ ] **Step 1: Ajouter les imports**

En tête de `src/lib/rfc/runs.remote.ts`, ajouter :

```ts
import { killContainer } from '$lib/server/docker';
import { containerName } from '$lib/server/workspace-paths';
```

(Garder les imports existants. `agentBranch` est déjà importé depuis `workspace-paths` — ajouter `containerName` à cette ligne.)

- [ ] **Step 2: `startRun` — poser un `timeoutAt`**

Dans `startRun`, ajouter `timeoutAt` aux données créées :

```ts
const TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 30 * 60 * 1000);
// …
await prisma.run.create({
	data: {
		id,
		projectId,
		organizationId,
		createdById: locals.user!.id,
		prompt,
		agentBranch: agentBranch(id),
		status: 'queued',
		timeoutAt: new Date(Date.now() + TIMEOUT_MS)
	}
});
```

(Déclarer `TIMEOUT_MS` en tête de module, après les imports.)

- [ ] **Step 3: Ajouter `cancelRun`**

```ts
/** Annule un run actif : pose `canceled` (gardé) PUIS tue le conteneur. */
export const cancelRun = command(z.string(), async (runId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const run = await prisma.run.findFirst({
		where: { id: runId, organizationId },
		select: { id: true, status: true }
	});
	if (!run) error(404, 'Run not found');

	// On pose `canceled` AVANT de tuer le conteneur, pour que l'orchestrateur
	// (transition gardée `running → failed`) ne réécrive pas le statut.
	const res = await prisma.run.updateMany({
		where: { id: runId, status: { in: ['queued', 'preparing', 'running'] } },
		data: { status: 'canceled', finishedAt: new Date() }
	});
	if (res.count > 0) {
		await killContainer(containerName(runId));
	}
	await getRun(runId).refresh();
	await listRuns(run.projectId ?? '').refresh();
	return { canceled: res.count > 0 };
});
```

> Note : `run.projectId` n'est pas dans le `select` ci-dessus — ajouter `projectId: true` au `select`, ou récupérer le projectId. Corriger le `select` en `{ id: true, status: true, projectId: true }` et utiliser `run.projectId`.

- [ ] **Step 4: Corriger le `select` de cancelRun**

S'assurer que le `findFirst` de `cancelRun` sélectionne `projectId` :

```ts
select: { id: true, status: true, projectId: true }
```
et l'appel de refresh : `await listRuns(run.projectId).refresh();`

- [ ] **Step 5: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 6: Commit**

```bash
git add src/lib/rfc/runs.remote.ts
git commit -m "feat(runs): cancelRun + timeoutAt at enqueue (DOT-16 P5)"
```

---

### Task 7: Crash recovery au démarrage du worker

**Files:**

- Create: `src/lib/server/run-recovery.ts`
- Test: `src/lib/server/run-recovery.test.ts`
- Modify: `src/runner/index.ts`

Les statuts actifs (`preparing`, `running`, `pushing`) trouvés au boot = runs orphelins (worker tué en cours) → marqués `failed`. (`queued` n'est PAS orphelin : pg-boss le re-livrera.)

- [ ] **Step 1: Écrire le test (prédicat pur) qui échoue**

```ts
// src/lib/server/run-recovery.test.ts
import { describe, it, expect } from 'vitest';
import { ORPHAN_STATUSES } from './run-recovery';

describe('ORPHAN_STATUSES', () => {
	it('covers the active non-queued statuses, and excludes queued + terminal', () => {
		expect([...ORPHAN_STATUSES].sort()).toEqual(['preparing', 'pushing', 'running']);
		expect(ORPHAN_STATUSES).not.toContain('queued');
		expect(ORPHAN_STATUSES).not.toContain('completed');
	});
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/server/run-recovery.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

```ts
// src/lib/server/run-recovery.ts
import type { RunStatus } from '@prisma/client';
import { prisma } from '$lib/server/prisma';

/** Statuts « actifs mais sans worker vivant » au démarrage → orphelins. `queued` est re-livré par pg-boss. */
export const ORPHAN_STATUSES: RunStatus[] = ['preparing', 'running', 'pushing'];

/** Marque `failed` les runs orphelins (worker redémarré en plein run). Renvoie le nombre récupéré. */
export async function recoverOrphanedRuns(): Promise<number> {
	const res = await prisma.run.updateMany({
		where: { status: { in: ORPHAN_STATUSES } },
		data: { status: 'failed', error: 'Interrupted by a worker restart', finishedAt: new Date() }
	});
	return res.count;
}
```

- [ ] **Step 4: Lancer, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/server/run-recovery.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Brancher dans le worker**

Dans `src/runner/index.ts`, dans `main()` après `await ensureRunQueue(boss);` et avant `boss.work(...)` :

```ts
import { recoverOrphanedRuns } from '$lib/server/run-recovery';
// …
	const recovered = await recoverOrphanedRuns();
	if (recovered > 0) console.log(`[runner] recovered ${recovered} orphaned run(s) → failed`);
```

- [ ] **Step 6: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/run-recovery.ts src/lib/server/run-recovery.test.ts src/runner/index.ts
git commit -m "feat(run): recover orphaned runs on worker startup (DOT-16 P5)"
```

---

### Task 8: UI — bouton Cancel

**Files:**

- Modify: `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`

- [ ] **Step 1: Ajouter le cancel à la page run**

Dans le `<script>`, importer `cancelRun` (ajouter à l'import existant `{ getRun, getRunDiff, approveRun }`) et ajouter :

```ts
	const ACTIVE_CANCELABLE = ['queued', 'preparing', 'running'];
	let canceling = $state(false);
	async function cancel() {
		canceling = true;
		try {
			await cancelRun(page.params.runId!);
		} catch {
			/* l'erreur remonte dans run.error au refresh */
		} finally {
			canceling = false;
		}
	}
```

Et dans le markup, juste après le bloc `{#if run.current.error}` (avant le `{#if prUrl}`), ajouter un bouton visible quand le run est annulable :

```svelte
		{#if ACTIVE_CANCELABLE.includes(run.current.status)}
			<button
				onclick={cancel}
				disabled={canceling}
				class="rounded-md border px-3 py-1 text-sm hover:bg-accent"
			>
				{canceling ? 'Canceling…' : 'Cancel run'}
			</button>
		{/if}
```

- [ ] **Step 2: Autofixer Svelte**

Lancer le MCP `svelte-autofixer` (charger via `ToolSearch` `select:mcp__svelte__svelte-autofixer` si besoin) jusqu'à 0 issue (les suggestions « $effect assigne du state » de l'EventSource existant sont attendues — cf. Phase 3).

- [ ] **Step 3: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 4: Commit**

```bash
git add "src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte"
git commit -m "feat(runs): cancel button on active runs (DOT-16 P5)"
```

---

### Task 9: Vérification + validation headless

- [ ] **Step 1: Suite + lint + format**

Run: `bun run test:unit -- --run` (tous verts)
Run: `bunx eslint` sur les fichiers créés/modifiés (0 erreur)
Puis `bunx prettier --write` sur les fichiers touchés ; commit si changement.

- [ ] **Step 2: Validation headless — annulation** (Docker + worker + token)

Réutiliser le harness `scripts/e2e-orchestration.ts` mais avec un prompt **long** (ex. « Wait by creating 5 files one at a time with a short pause, then stop. ») pour avoir le temps d'annuler ; pendant que le run est `running`, appeler `cancelRun` (via un petit script vite-node qui pose `canceled` + `killContainer(containerName(runId))`) et vérifier :
- le run finit en `canceled` (pas `failed`),
- le conteneur `dwrun-<id>` n'existe plus (`docker ps`).

- [ ] **Step 3: Validation headless — crash recovery**

Insérer (script) un `Run` en statut `running`, appeler `recoverOrphanedRuns()`, vérifier qu'il passe `failed` avec le message d'interruption.

- [ ] **Step 4: Validation — filet anti-crash**

Vérifier que la suite unit `process-safety.test.ts` passe (l'émission d'`unhandledRejection` ne jette pas). En complément, le bug DOT-16 (déjà corrigé) ne crasherait plus le serveur même si une rejection s'échappait.

## Couverture (slice A+B)

- ✅ A — filet anti-crash (process-safety) dans serveur + worker (Tasks 1–2)
- ✅ B — containerName (Task 3), timeout runContainer (Task 4), transitions conditionnelles + timeout orchestrateur (Task 5), cancelRun + timeoutAt (Task 6), crash recovery (Task 7), UI cancel (Task 8)
- ⏭️ Slices Phase 5 restantes : C quotas, D durcissement (egress/rootfs/non-root), E resume/fork + force-with-lease, F LISTEN/NOTIFY.
