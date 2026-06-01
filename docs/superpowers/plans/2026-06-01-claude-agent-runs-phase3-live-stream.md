# DOT-16 Phase 3 — Live streaming (SSE) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Streamer en direct la sortie d'un run dans l'UI : pendant qu'un run est actif, les `RunEvent` apparaissent au fur et à mesure (au lieu de rafraîchir la page), et l'UI bascule sur la vue diff quand le run atteint `awaiting_review`.

**Architecture:** Source de vérité = table `RunEvent` (déjà persistée par le worker). Un endpoint **SSE** `GET /api/runs/[id]/events` (a) rejoue les events depuis `Last-Event-ID` (header EventSource), puis (b) **poll** `RunEvent` (`seq > cursor`) toutes les ~1 s et pousse les nouveaux ; il ferme le flux quand le run est terminal. Le front utilise `EventSource` (reconnexion auto, replay idempotent par `seq`). Pas de `LISTEN/NOTIFY` (optimisation Phase 5) — le polling d'une table indexée suffit à notre échelle.

**Tech Stack:** SvelteKit endpoint (`+server.ts`, `ReadableStream`), better-auth (auth de l'endpoint), Prisma, `EventSource` côté client, vitest.

**Prérequis :** Phases 1/2A/2B (le worker insère des `RunEvent` avec `seq` monotone). `RunEvent` indexé `@@unique([runId, seq])`.

**Décisions cadrées :** transport = **SSE par polling 1 s** ; auth de l'endpoint = même règle que les remote functions (session + org active + appartenance) ; fin de flux = event `done` quand le run est terminal.

**Hors périmètre :** `LISTEN/NOTIFY`, backpressure fine, multiplexage (Phase 5). Rendu joli des messages (on réutilise le résumé JSON existant).

---

### Task 1: Helpers de stream (TDD purs)

**Files:**

- Create: `src/lib/server/run-stream.ts`
- Test: `src/lib/server/run-stream.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// src/lib/server/run-stream.test.ts
import { describe, it, expect } from 'vitest';
import { formatSseEvent, isTerminalStatus } from './run-stream';

describe('formatSseEvent', () => {
	it('formats an SSE message with id (seq) and JSON data', () => {
		expect(formatSseEvent(3, { type: 'assistant', text: 'hi' })).toBe(
			'id: 3\ndata: {"type":"assistant","text":"hi"}\n\n'
		);
	});
});

describe('isTerminalStatus', () => {
	it('is true for terminal states', () => {
		for (const s of ['awaiting_review', 'completed', 'failed', 'canceled', 'timed_out'] as const) {
			expect(isTerminalStatus(s)).toBe(true);
		}
	});
	it('is false for active states', () => {
		for (const s of ['queued', 'preparing', 'running', 'pushing'] as const) {
			expect(isTerminalStatus(s)).toBe(false);
		}
	});
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/server/run-stream.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

```ts
// src/lib/server/run-stream.ts
import type { RunStatus } from '@prisma/client';

/** Formate un message SSE : `id` = seq (pour Last-Event-ID), `data` = payload JSON. */
export function formatSseEvent(seq: number, payload: unknown): string {
	return `id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const TERMINAL: RunStatus[] = ['awaiting_review', 'completed', 'failed', 'canceled', 'timed_out'];

/** Un run terminal n'émettra plus d'events → le flux SSE peut se fermer. */
export function isTerminalStatus(status: RunStatus): boolean {
	return TERMINAL.includes(status);
}
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/server/run-stream.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/run-stream.ts src/lib/server/run-stream.test.ts
git commit -m "feat(stream): SSE formatting + terminal-status helpers (DOT-16 P3)"
```

---

### Task 2: Endpoint SSE `GET /api/runs/[id]/events`

**Files:**

- Create: `src/routes/api/runs/[id]/events/+server.ts`

Auth identique aux remote functions (session + org active + appartenance), puis replay + poll.

- [ ] **Step 1: Implémenter**

```ts
// src/routes/api/runs/[id]/events/+server.ts
import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { prisma } from '$lib/server/prisma';
import { resolveActiveOrgId } from '$lib/server/org';
import { formatSseEvent, isTerminalStatus } from '$lib/server/run-stream';

const POLL_MS = 1000;
const PING_EVERY = 15; // ~15 s de heartbeat

export const GET: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session || !locals.user) error(401, 'Not authenticated');
	const runId = params.id;

	const session = await auth.api.getSession({ headers: request.headers });
	let organizationId: string;
	try {
		organizationId = resolveActiveOrgId(session?.session ?? null);
	} catch {
		error(400, 'No active team selected');
	}
	const member = await prisma.member.findFirst({
		where: { organizationId, userId: locals.user.id },
		select: { id: true }
	});
	if (!member) error(403, 'Not a member of the active team');
	const run = await prisma.run.findFirst({
		where: { id: runId, organizationId },
		select: { id: true }
	});
	if (!run) error(404, 'Run not found');

	const lastEventId = Number(request.headers.get('last-event-id'));
	let cursor = Number.isFinite(lastEventId) ? lastEventId : -1;

	const stream = new ReadableStream({
		async start(controller) {
			const enc = new TextEncoder();
			let closed = false;
			const send = (s: string) => {
				if (!closed) controller.enqueue(enc.encode(s));
			};
			const close = () => {
				if (closed) return;
				closed = true;
				try {
					controller.close();
				} catch {
					// déjà fermé
				}
			};
			request.signal.addEventListener('abort', close);

			let tick = 0;
			while (!closed) {
				const events = await prisma.runEvent.findMany({
					where: { runId, seq: { gt: cursor } },
					orderBy: { seq: 'asc' }
				});
				for (const ev of events) {
					send(formatSseEvent(ev.seq, ev.payload));
					cursor = ev.seq;
				}
				const current = await prisma.run.findUnique({
					where: { id: runId },
					select: { status: true }
				});
				if (current && isTerminalStatus(current.status)) {
					send(`event: done\ndata: ${JSON.stringify({ status: current.status })}\n\n`);
					break;
				}
				if (++tick % PING_EVERY === 0) send(': ping\n\n');
				await new Promise((r) => setTimeout(r, POLL_MS));
			}
			close();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-store',
			Connection: 'keep-alive'
		}
	});
};
```

- [ ] **Step 2: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur. (Le type généré `./$types` n'existe qu'après `svelte-kit sync`, que `check` lance.)

- [ ] **Step 3: Commit**

```bash
git add "src/routes/api/runs/[id]/events/+server.ts"
git commit -m "feat(stream): SSE endpoint replaying + polling RunEvent (DOT-16 P3)"
```

---

### Task 3: UI — flux live sur la page run

**Files:**

- Modify: `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`

Quand le run est **actif** (`queued`/`preparing`/`running`/`pushing`), on ouvre un `EventSource` qui empile les events en direct et, à l'event `done`, rafraîchit `getRun` (→ statut final + diff). Sinon (terminal), on garde l'affichage existant des events persistés.

- [ ] **Step 1: Ajouter le streaming au `<script>` existant**

Insérer, après les `const`/`$state` existants du composant (garder tout le reste du fichier inchangé) :

```ts
	const ACTIVE = ['queued', 'preparing', 'running', 'pushing'];
	let liveEvents = $state<Array<{ seq: number; payload: unknown }>>([]);

	$effect(() => {
		const status = run.current?.status;
		if (!status || !ACTIVE.includes(status)) return;
		const runId = page.params.runId!;
		const es = new EventSource(`/api/runs/${runId}/events`);
		es.onmessage = (e) => {
			const seq = Number(e.lastEventId);
			if (liveEvents.some((x) => x.seq === seq)) return;
			let payload: unknown = e.data;
			try {
				payload = JSON.parse(e.data);
			} catch {
				/* garde le texte brut */
			}
			liveEvents = [...liveEvents, { seq, payload }];
		};
		es.addEventListener('done', () => {
			es.close();
			getRun(runId).refresh();
		});
		es.onerror = () => {
			/* EventSource se reconnecte tout seul ; replay idempotent par seq */
		};
		return () => es.close();
	});
```

- [ ] **Step 2: Afficher le flux live**

Dans le bloc `<h2 ...>Events</h2>` du composant, remplacer l'affichage des events persistés par : le **flux live** si présent, sinon les events persistés. Remplacer le contenu de la `<div>` des events par :

```svelte
		<div>
			<h2 class="mb-1 text-sm font-medium">Events</h2>
			{#if liveEvents.length > 0}
				<ul class="space-y-1">
					{#each liveEvents as event (event.seq)}
						<li class="rounded border p-2 text-xs">
							<div class="break-all">{summarize(event.payload)}</div>
						</li>
					{/each}
				</ul>
			{:else if run.current.events.length === 0}
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
```

- [ ] **Step 3: Autofixer Svelte**

Lancer le MCP `svelte-autofixer` (charger via `ToolSearch` `select:mcp__svelte__svelte-autofixer` si besoin) sur le composant jusqu'à 0 issue. En particulier, vérifier que l'usage de `$effect` avec EventSource + cleanup est correct.

- [ ] **Step 4: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 5: Commit**

```bash
git add "src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte"
git commit -m "feat(stream): live event streaming on the run page (DOT-16 P3)"
```

---

### Task 4: Vérification + validation headless

- [ ] **Step 1: Suite unitaire + lint + format**

Run: `bun run test:unit -- --run` (tous verts)
Run: `bunx eslint src/lib/server/run-stream.ts "src/routes/api/runs/[id]/events/+server.ts"` (0 erreur)
Puis `bunx prettier --write` sur les fichiers créés/modifiés ; commit si changement.

- [ ] **Step 2: Validation SSE headless** (Docker + worker + `CLAUDE_CODE_OAUTH_TOKEN`)

Cette étape valide l'endpoint sans navigateur, via `curl`. Elle nécessite une session authentifiée → on teste l'endpoint avec un cookie de session valide **ou** on vérifie d'abord le 401 sans cookie :

1. `bun run dev` + `bun run runner`.
2. Sans cookie : `curl -N http://localhost:5173/api/runs/<id>/events` → **401** (auth OK).
3. Avec un run actif et un cookie de session valide (copié depuis le navigateur après login), `curl -N -H "Cookie: <session>" http://localhost:5173/api/runs/<runId>/events` doit streamer des lignes `id:`/`data:` puis `event: done`.

(Le test bout-en-bout complet avec login se fait dans le navigateur : lancer un run, ouvrir la page run, voir les events défiler en direct puis la bascule vers le diff.)

## Couverture Phase 3

- ✅ Helpers SSE + terminal (Task 1)
- ✅ Endpoint SSE : auth org-scopée + replay `Last-Event-ID` + poll + `done` (Task 2)
- ✅ UI live via `EventSource` + bascule diff à la fin (Task 3)
- ⏭️ Phase 5 : `LISTEN/NOTIFY` (au lieu du polling), backpressure fine.
