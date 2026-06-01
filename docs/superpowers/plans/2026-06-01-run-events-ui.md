# Rich Run-Events UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer l'affichage JSON brut des `RunEvent` par un rendu riche et typé (markdown pour l'assistant, cartes pour les appels d'outils, thinking/résultats repliables, carte de résultat final), réutilisé par le flux live et les events persistés.

**Architecture:** Un normaliseur **pur** `normalizeEvent(payload) → DisplayEvent[]` traduit chaque payload SDK brut en une union typée ; un composant `<RunEvent>` fait un `switch` sur `kind` ; `<Markdown>` rend le texte assistant (marked + isomorphic-dompurify, sanitizé). La page run mappe la source courante (live ou persistée) via le normaliseur et rend la liste.

**Tech Stack:** SvelteKit 5 (runes), vitest, `marked`, `isomorphic-dompurify`.

**Prérequis :** Phases 1–5 présentes. Branche `dot-16-events-ui` (empilée sur `dot-16-phase5-robustness`). Spec : `docs/superpowers/specs/2026-06-01-run-events-ui-design.md`.

## Structure de fichiers

- Create `src/lib/components/runs/run-event-display.ts` — types `DisplayEvent`, `normalizeEvent`, `describeToolUse` (pur, testable).
- Create `src/lib/components/runs/run-event-display.test.ts`.
- Create `src/lib/components/runs/markdown.ts` — `renderMarkdown` (pur, sanitizé) + `src/lib/components/runs/Markdown.svelte` (composant).
- Create `src/lib/components/runs/RunEvent.svelte` — dispatch sur `kind`.
- Modify `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte` — câblage.
- Modify `package.json` — deps.

---

### Task 1: Dépendances

**Files:** Modify `package.json`

- [ ] **Step 1: Installer marked + isomorphic-dompurify**

Run: `bun add marked isomorphic-dompurify`
Expected: les deux en `dependencies`.

- [ ] **Step 2: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore(deps): marked + isomorphic-dompurify for event rendering (DOT-16)"
```

---

### Task 2: `describeToolUse` (TDD pur)

**Files:**

- Create: `src/lib/components/runs/run-event-display.ts`
- Test: `src/lib/components/runs/run-event-display.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// src/lib/components/runs/run-event-display.test.ts
import { describe, it, expect } from 'vitest';
import { describeToolUse } from './run-event-display';

describe('describeToolUse', () => {
	it('shows the command for Bash', () => {
		expect(describeToolUse('Bash', { command: 'ls /workspace' })).toEqual({
			title: 'Bash',
			detail: 'ls /workspace'
		});
	});
	it('shows the file path for Write/Edit/Read', () => {
		expect(describeToolUse('Write', { file_path: '/workspace/NOTES.md' }).detail).toBe(
			'/workspace/NOTES.md'
		);
		expect(describeToolUse('Edit', { file_path: 'a.ts' }).title).toBe('Edit');
		expect(describeToolUse('Read', { file_path: 'b.ts' }).detail).toBe('b.ts');
	});
	it('shows the pattern for Glob/Grep', () => {
		expect(describeToolUse('Glob', { pattern: '**/*.ts' }).detail).toBe('**/*.ts');
		expect(describeToolUse('Grep', { pattern: 'TODO' }).detail).toBe('TODO');
	});
	it('falls back to JSON for unknown tools', () => {
		expect(describeToolUse('Mystery', { a: 1 })).toEqual({ title: 'Mystery', detail: '{"a":1}' });
	});
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/components/runs/run-event-display.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter (types + describeToolUse ; normalizeEvent ajouté en Task 3)**

```ts
// src/lib/components/runs/run-event-display.ts

export type DisplayEvent =
	| { kind: 'session_start'; model: string }
	| { kind: 'thinking'; text: string }
	| { kind: 'assistant_text'; markdown: string }
	| { kind: 'tool_use'; tool: string; title: string; detail: string }
	| { kind: 'tool_result'; text: string; isError: boolean }
	| {
			kind: 'result';
			isError: boolean;
			subtype: string;
			numTurns: number | null;
			costUsd: number | null;
			durationMs: number | null;
			text: string;
	  }
	| { kind: 'subagent'; phase: 'started' | 'progress' | 'done'; label: string; status: string | null }
	| { kind: 'rate_limit'; status: string; resetsAt: number | null }
	| { kind: 'hidden' }
	| { kind: 'raw'; json: string };

const MAX_DETAIL = 2000;

function truncate(s: string, max = MAX_DETAIL): string {
	return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Décrit un appel d'outil : titre + détail lisible selon l'outil. */
export function describeToolUse(
	name: string,
	input: Record<string, unknown>
): { title: string; detail: string } {
	const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? null));
	switch (name) {
		case 'Bash':
			return { title: 'Bash', detail: truncate(str(input.command)) };
		case 'Write':
		case 'Edit':
		case 'Read':
		case 'NotebookEdit':
			return { title: name, detail: truncate(str(input.file_path)) };
		case 'Glob':
		case 'Grep':
			return { title: name, detail: truncate(str(input.pattern)) };
		default:
			return { title: name, detail: truncate(JSON.stringify(input)) };
	}
}
```

- [ ] **Step 4: Lancer, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/components/runs/run-event-display.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/runs/run-event-display.ts src/lib/components/runs/run-event-display.test.ts
git commit -m "feat(events): DisplayEvent types + describeToolUse (DOT-16)"
```

---

### Task 3: `normalizeEvent` (TDD pur)

**Files:**

- Modify: `src/lib/components/runs/run-event-display.ts`
- Modify: `src/lib/components/runs/run-event-display.test.ts`

- [ ] **Step 1: Ajouter les tests (au fichier existant)**

```ts
import { describeToolUse, normalizeEvent } from './run-event-display';

describe('normalizeEvent', () => {
	it('splits an assistant message into thinking/text/tool_use items', () => {
		const out = normalizeEvent({
			type: 'assistant',
			message: {
				content: [
					{ type: 'thinking', thinking: 'hmm' },
					{ type: 'text', text: 'Hello **world**' },
					{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }
				]
			}
		});
		expect(out.map((e) => e.kind)).toEqual(['thinking', 'assistant_text', 'tool_use']);
		expect(out[1]).toEqual({ kind: 'assistant_text', markdown: 'Hello **world**' });
		expect(out[2]).toMatchObject({ kind: 'tool_use', tool: 'Bash', detail: 'ls' });
	});
	it('maps a user tool_result (with is_error)', () => {
		const out = normalizeEvent({
			type: 'user',
			message: { content: [{ type: 'tool_result', content: 'oops', is_error: true }] }
		});
		expect(out).toEqual([{ kind: 'tool_result', text: 'oops', isError: true }]);
	});
	it('joins array tool_result content into text', () => {
		const out = normalizeEvent({
			type: 'user',
			message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] }
		});
		expect(out).toEqual([{ kind: 'tool_result', text: 'a\nb', isError: false }]);
	});
	it('maps a result event', () => {
		const out = normalizeEvent({
			type: 'result',
			subtype: 'success',
			is_error: false,
			num_turns: 2,
			total_cost_usd: 0.02,
			duration_ms: 1500,
			result: 'done'
		});
		expect(out[0]).toEqual({
			kind: 'result',
			isError: false,
			subtype: 'success',
			numTurns: 2,
			costUsd: 0.02,
			durationMs: 1500,
			text: 'done'
		});
	});
	it('maps system:init to session_start', () => {
		expect(normalizeEvent({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' })).toEqual([
			{ kind: 'session_start', model: 'claude-sonnet-4-6' }
		]);
	});
	it('maps subagent task events', () => {
		expect(normalizeEvent({ type: 'system', subtype: 'task_started', prompt: 'Explore the repo' })[0]).toMatchObject({ kind: 'subagent', phase: 'started' });
		expect(normalizeEvent({ type: 'system', subtype: 'task_progress', description: 'find …' })[0]).toMatchObject({ kind: 'subagent', phase: 'progress', label: 'find …' });
		expect(normalizeEvent({ type: 'system', subtype: 'task_notification', summary: 'Explore', status: 'completed' })[0]).toMatchObject({ kind: 'subagent', phase: 'done', status: 'completed' });
	});
	it('maps rate_limit_event', () => {
		expect(normalizeEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 123 } })).toEqual([
			{ kind: 'rate_limit', status: 'allowed', resetsAt: 123 }
		]);
	});
	it('hides runner_summary', () => {
		expect(normalizeEvent({ type: 'runner_summary', head: 'abc' })).toEqual([{ kind: 'hidden' }]);
	});
	it('falls back to raw for unknown types', () => {
		const out = normalizeEvent({ type: 'totally_new', foo: 1 });
		expect(out[0].kind).toBe('raw');
	});
	it('never throws on malformed input', () => {
		expect(() => normalizeEvent(null)).not.toThrow();
		expect(() => normalizeEvent({})).not.toThrow();
		expect(normalizeEvent(null)[0].kind).toBe('raw');
	});
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/components/runs/run-event-display.test.ts`
Expected: FAIL — `normalizeEvent` introuvable.

- [ ] **Step 3: Ajouter `normalizeEvent` à `run-event-display.ts`**

```ts
interface AnyObj {
	[k: string]: unknown;
}

function asObj(v: unknown): AnyObj {
	return v && typeof v === 'object' ? (v as AnyObj) : {};
}

function toolResultText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => (typeof c === 'string' ? c : typeof asObj(c).text === 'string' ? (asObj(c).text as string) : JSON.stringify(c)))
			.join('\n');
	}
	return content == null ? '' : JSON.stringify(content);
}

/** Traduit un payload SDK brut en items affichables. Ne lève jamais : type inconnu → `raw`. */
export function normalizeEvent(payload: unknown): DisplayEvent[] {
	try {
		const p = asObj(payload);
		const type = p.type;

		if (type === 'assistant') {
			const content = asObj(p.message).content;
			const items = Array.isArray(content) ? content : [];
			const out: DisplayEvent[] = [];
			for (const raw of items) {
				const c = asObj(raw);
				if (c.type === 'thinking') out.push({ kind: 'thinking', text: String(c.thinking ?? '') });
				else if (c.type === 'text') out.push({ kind: 'assistant_text', markdown: String(c.text ?? '') });
				else if (c.type === 'tool_use') {
					const d = describeToolUse(String(c.name ?? 'tool'), asObj(c.input));
					out.push({ kind: 'tool_use', tool: String(c.name ?? 'tool'), title: d.title, detail: d.detail });
				}
			}
			return out.length ? out : [{ kind: 'hidden' }];
		}

		if (type === 'user') {
			const content = asObj(p.message).content;
			const items = Array.isArray(content) ? content : [];
			const out: DisplayEvent[] = [];
			for (const raw of items) {
				const c = asObj(raw);
				if (c.type === 'tool_result') {
					out.push({ kind: 'tool_result', text: toolResultText(c.content), isError: c.is_error === true });
				} else if (c.type === 'text') {
					out.push({ kind: 'assistant_text', markdown: String(c.text ?? '') });
				}
			}
			return out.length ? out : [{ kind: 'hidden' }];
		}

		if (type === 'result') {
			return [
				{
					kind: 'result',
					isError: p.is_error === true,
					subtype: String(p.subtype ?? ''),
					numTurns: typeof p.num_turns === 'number' ? p.num_turns : null,
					costUsd: typeof p.total_cost_usd === 'number' ? p.total_cost_usd : null,
					durationMs: typeof p.duration_ms === 'number' ? p.duration_ms : null,
					text: typeof p.result === 'string' ? p.result : ''
				}
			];
		}

		if (type === 'system') {
			const sub = p.subtype;
			if (sub === 'init') return [{ kind: 'session_start', model: String(p.model ?? '') }];
			if (sub === 'task_started') return [{ kind: 'subagent', phase: 'started', label: String(p.prompt ?? 'subagent task').slice(0, 80), status: null }];
			if (sub === 'task_progress') return [{ kind: 'subagent', phase: 'progress', label: String(p.description ?? '').slice(0, 80), status: null }];
			if (sub === 'task_notification') return [{ kind: 'subagent', phase: 'done', label: String(p.summary ?? 'subagent task').slice(0, 80), status: typeof p.status === 'string' ? p.status : null }];
			return [{ kind: 'raw', json: JSON.stringify(payload) }];
		}

		if (type === 'rate_limit_event') {
			const info = asObj(p.rate_limit_info);
			return [{ kind: 'rate_limit', status: String(info.status ?? 'unknown'), resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null }];
		}

		if (type === 'runner_summary') return [{ kind: 'hidden' }];

		return [{ kind: 'raw', json: JSON.stringify(payload) }];
	} catch {
		return [{ kind: 'raw', json: (() => { try { return JSON.stringify(payload); } catch { return String(payload); } })() }];
	}
}
```

- [ ] **Step 4: Lancer, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/components/runs/run-event-display.test.ts`
Expected: PASS (tous : describeToolUse + normalizeEvent).

- [ ] **Step 5: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 6: Commit**

```bash
git add src/lib/components/runs/run-event-display.ts src/lib/components/runs/run-event-display.test.ts
git commit -m "feat(events): normalizeEvent payload → DisplayEvent[] (DOT-16)"
```

---

### Task 4: Rendu markdown sanitizé (`markdown.ts` + `<Markdown>`)

**Files:**

- Create: `src/lib/components/runs/markdown.ts` (fonction pure `renderMarkdown`, testable)
- Test: `src/lib/components/runs/markdown.test.ts`
- Create: `src/lib/components/runs/Markdown.svelte` (composant qui utilise `renderMarkdown`)

On met la logique sanitize dans un `.ts` **pur** (testable sans dépendre de l'import d'un `.svelte`), et le composant l'appelle.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// src/lib/components/runs/markdown.test.ts
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
	it('renders basic markdown to HTML', () => {
		const html = renderMarkdown('# Title\n\nHello **world**');
		expect(html).toContain('<h1');
		expect(html).toContain('<strong>world</strong>');
	});
	it('strips <script> and on* handlers (XSS)', () => {
		const html = renderMarkdown('<script>alert(1)</script><img src=x onerror="alert(2)">');
		expect(html).not.toContain('<script');
		expect(html.toLowerCase()).not.toContain('onerror');
	});
	it('does not throw on non-string input', () => {
		expect(() => renderMarkdown(undefined as unknown as string)).not.toThrow();
	});
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/components/runs/markdown.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter `markdown.ts`**

```ts
// src/lib/components/runs/markdown.ts
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

/** Rend du markdown en HTML sanitizé. Ne lève jamais (repli sur texte échappé). */
export function renderMarkdown(source: string): string {
	try {
		const raw = marked.parse(typeof source === 'string' ? source : String(source ?? ''), {
			async: false,
			breaks: true
		}) as string;
		return DOMPurify.sanitize(raw);
	} catch {
		return String(source ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}
}
```

- [ ] **Step 4: Lancer, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/components/runs/markdown.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Implémenter `Markdown.svelte`**

```svelte
<script lang="ts">
	import { renderMarkdown } from './markdown';

	let { source }: { source: string } = $props();
	const html = $derived(renderMarkdown(source));
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify in renderMarkdown -->
<div class="prose prose-sm max-w-none text-sm">{@html html}</div>
```

- [ ] **Step 6: Autofixer Svelte + check**

Lancer le MCP `svelte-autofixer` sur `Markdown.svelte` jusqu'à 0 issue (l'unique avertissement `no-at-html-tags` est justifié — contenu sanitizé — et le commentaire de désactivation est en place).
Run: `bun run check` → 0 erreur.

- [ ] **Step 7: Commit**

```bash
git add src/lib/components/runs/markdown.ts src/lib/components/runs/markdown.test.ts src/lib/components/runs/Markdown.svelte
git commit -m "feat(events): sanitized markdown render (helper + component) (DOT-16)"
```

---

### Task 5: Composant `<RunEvent>`

**Files:**

- Create: `src/lib/components/runs/RunEvent.svelte`

- [ ] **Step 1: Implémenter**

```svelte
<script lang="ts">
	import type { DisplayEvent } from './run-event-display';
	import Markdown from './Markdown.svelte';

	let { event }: { event: DisplayEvent } = $props();

	function fmtCost(c: number | null): string {
		return c == null ? '' : ` · $${c.toFixed(4)}`;
	}
	function fmtDur(ms: number | null): string {
		return ms == null ? '' : ` · ${(ms / 1000).toFixed(1)}s`;
	}
</script>

{#if event.kind === 'session_start'}
	<p class="text-xs text-muted-foreground">Session · {event.model}</p>
{:else if event.kind === 'thinking'}
	<details class="rounded border bg-muted/20 p-2 text-xs">
		<summary class="cursor-pointer text-muted-foreground">🧠 Thinking</summary>
		<pre class="mt-1 whitespace-pre-wrap break-words">{event.text}</pre>
	</details>
{:else if event.kind === 'assistant_text'}
	<div class="rounded-md border p-3"><Markdown source={event.markdown} /></div>
{:else if event.kind === 'tool_use'}
	<div class="rounded-md border p-2 text-xs">
		<span class="font-medium">🔧 {event.title}</span>
		<pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-muted-foreground">{event.detail}</pre>
	</div>
{:else if event.kind === 'tool_result'}
	<details class="rounded border p-2 text-xs" class:border-red-400={event.isError}>
		<summary class="cursor-pointer {event.isError ? 'text-red-500' : 'text-muted-foreground'}">
			{event.isError ? '⚠️ Tool error' : '↳ Tool result'}
		</summary>
		<pre class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono">{event.text}</pre>
	</details>
{:else if event.kind === 'result'}
	<div class="rounded-md border p-3 text-sm" class:border-red-400={event.isError}>
		<p class="font-medium">
			{event.isError ? '✗' : '✓'}
			{event.subtype || (event.isError ? 'error' : 'done')}{event.numTurns != null
				? ` · ${event.numTurns} turns`
				: ''}{fmtCost(event.costUsd)}{fmtDur(event.durationMs)}
		</p>
		{#if event.text}<div class="mt-1"><Markdown source={event.text} /></div>{/if}
	</div>
{:else if event.kind === 'subagent'}
	<p class="border-l-2 pl-3 text-xs text-muted-foreground">
		⤷ subagent: {event.label}{event.status ? ` (${event.status})` : ''}
	</p>
{:else if event.kind === 'rate_limit'}
	{#if event.status !== 'allowed'}
		<p class="text-xs text-amber-600">Rate limit: {event.status}</p>
	{/if}
{:else if event.kind === 'raw'}
	<pre class="overflow-auto rounded border p-2 text-xs break-all">{event.json}</pre>
{/if}
```

- [ ] **Step 2: Autofixer Svelte**

Lancer `svelte-autofixer` sur le composant jusqu'à 0 issue.

- [ ] **Step 3: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/runs/RunEvent.svelte
git commit -m "feat(events): RunEvent component dispatching on kind (DOT-16)"
```

---

### Task 6: Câbler la page run

**Files:**

- Modify: `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`

- [ ] **Step 1: Importer le normaliseur + le composant ; dériver la liste affichable**

Dans le `<script>`, ajouter aux imports :

```ts
import RunEvent from '$lib/components/runs/RunEvent.svelte';
import { normalizeEvent, type DisplayEvent } from '$lib/components/runs/run-event-display';
```

Et ajouter une dérivation (après les `$state`/`$derived` existants) qui choisit la source (live si présent, sinon persisté) et la normalise :

```ts
	const displayEvents = $derived.by<DisplayEvent[]>(() => {
		const source =
			liveEvents.length > 0
				? liveEvents.map((e) => e.payload)
				: (run.current?.events ?? []).map((e) => e.payload);
		return source.flatMap((p) => normalizeEvent(p)).filter((e) => e.kind !== 'hidden');
	});
```

- [ ] **Step 2: Remplacer le bloc « Events » par le rendu riche**

Remplacer tout le contenu de la `<div>` qui contient `<h2 ...>Events</h2>` (la liste actuelle live/persistée avec `summarize`) par :

```svelte
		<div>
			<h2 class="mb-1 text-sm font-medium">Events</h2>
			{#if displayEvents.length === 0}
				<p class="text-sm text-muted-foreground">No events yet.</p>
			{:else}
				<ul class="space-y-2">
					{#each displayEvents as event, i (i)}
						<li><RunEvent {event} /></li>
					{/each}
				</ul>
			{/if}
		</div>
```

- [ ] **Step 3: Retirer la fonction `summarize` devenue inutilisée**

Supprimer la fonction `summarize(...)` du `<script>` (elle n'est plus référencée). Vérifier qu'aucune autre partie du fichier ne l'utilise (`grep summarize` sur le fichier → aucun résultat).

- [ ] **Step 4: Autofixer Svelte**

Lancer `svelte-autofixer` sur la page jusqu'à 0 issue (les suggestions connues `$effect`/EventSource du live-stream restent attendues).

- [ ] **Step 5: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 6: Commit**

```bash
git add "src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte"
git commit -m "feat(events): render rich RunEvent feed on the run page (DOT-16)"
```

---

### Task 7: Vérification + smoke

- [ ] **Step 1: Suite + lint + format**

Run: `bun run test:unit -- --run` (tous verts)
Run: `bunx eslint src/lib/components/runs/run-event-display.ts src/lib/components/runs/markdown.ts` (0 erreur)
Puis `bunx prettier --write` sur les fichiers créés/modifiés ; commit si changement.

- [ ] **Step 2: Smoke manuel** (Docker + worker + dev, optionnel mais recommandé)

`bun run dev` + `bun run runner` ; ouvrir un run existant (ex. celui qui a créé `NOTES.md`) : vérifier que la page affiche désormais le texte de l'agent en markdown, les appels d'outils en cartes, le résultat en carte « ✓ Success … », le thinking et les résultats d'outils repliables. Relancer un run et vérifier le rendu en **live**.

## Couverture (vs spec)

- ✅ Normaliseur pur `normalizeEvent` + `describeToolUse` (Tasks 2–3)
- ✅ `<Markdown>` sanitizé (Task 4)
- ✅ `<RunEvent>` dispatch par kind, tous les kinds du spec (Task 5)
- ✅ Câblage live/persisté + masquage `hidden` (Task 6)
- ✅ Tests : normalizeEvent (toutes formes + fallback + ne lève jamais), describeToolUse, sanitization XSS (Tasks 2–4)
- ⏭️ Hors périmètre : diff inline, tokens live, filtres, syntax highlighting (spec § YAGNI).
