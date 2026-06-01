# DOT-16 Phase 4 — Diff → revue → push → PR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fermer la boucle métier de DOT-16 : après un run en `awaiting_review`, afficher le diff de l'agent dans l'UI, et permettre à l'utilisateur de **pousser** la branche `claude/<id>` sur GitHub et/ou **ouvrir une PR** — ou d'**abandonner**.

**Architecture:** Le checkout du run (conservé après l'exécution) sert de source au diff (`git diff base..head` côté hôte). Une remote function `getRunDiff` calcule le diff ; `approveRun({ runId, action })` exécute **synchrone** le push (`git push` vers GitHub via un askpass éphémère, token de session) puis, pour l'action « Push & PR », ouvre la PR via l'API GitHub. Le token de session (better-auth) n'est jamais écrit en config git. La machine à états passe `awaiting_review → pushing → completed` (ou `→ canceled` pour l'abandon, `→ failed` en cas d'erreur de push).

**Tech Stack:** SvelteKit 5 (remote functions), Prisma 7, better-auth (token GitHub `repo`), git CLI, API GitHub REST, zod, vitest. Réutilise `git`, `github-git` (askpass + authedCloneUrl), `github` (getGithubToken), `workspace`/`workspace-paths`, `run-state`.

**Prérequis :** Phases 1/2A/2B présentes sur la branche. Un run en `awaiting_review` avec `baseCommitSha`/`headCommitSha` et un checkout sous `$WORKSPACE_ROOT/<projectId>/runs/<runId>`.

**Décisions cadrées :** push **synchrone** dans la remote function ; diff = **liste de fichiers + patch unifié brut** (cap de taille). Branche `claude/<id>` unique par run → un **`git push` simple** suffit (pas de `--force-with-lease` : pertinent seulement au re-push d'une même branche, hors périmètre — resume/fork = Phase 5).

**Hors périmètre :** rendu diff colorisé (Phase ultérieure) ; resume/fork re-push ; nettoyage GC des checkouts (Phase 5). Le checkout est supprimé à l'abandon et conservé après push (réutilisable).

---

### Task 1: Parsers de diff (TDD purs)

**Files:**

- Create: `src/lib/server/diff.ts`
- Test: `src/lib/server/diff.test.ts`

`git diff --numstat` donne `<add>\t<del>\t<path>` (`-` pour binaire) ; `git diff --name-status` donne `<status>\t<path>`. On parse les deux (purs) puis on fusionne.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// src/lib/server/diff.test.ts
import { describe, it, expect } from 'vitest';
import { parseNumstat, parseNameStatus, mergeDiffFiles } from './diff';

describe('parseNumstat', () => {
	it('parses additions/deletions and path; null for binary', () => {
		expect(parseNumstat('3\t1\tsrc/a.ts\n-\t-\timg.png\n')).toEqual([
			{ path: 'src/a.ts', additions: 3, deletions: 1 },
			{ path: 'img.png', additions: null, deletions: null }
		]);
	});
	it('returns [] for empty output', () => {
		expect(parseNumstat('')).toEqual([]);
	});
});

describe('parseNameStatus', () => {
	it('maps the status letter and path', () => {
		expect(parseNameStatus('A\tnew.ts\nM\tsrc/a.ts\nD\told.ts\n')).toEqual([
			{ path: 'new.ts', status: 'A' },
			{ path: 'src/a.ts', status: 'M' },
			{ path: 'old.ts', status: 'D' }
		]);
	});
});

describe('mergeDiffFiles', () => {
	it('joins status with counts by path', () => {
		const merged = mergeDiffFiles(
			[{ path: 'src/a.ts', additions: 3, deletions: 1 }],
			[{ path: 'src/a.ts', status: 'M' }]
		);
		expect(merged).toEqual([{ path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 }]);
	});
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/server/diff.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter les parsers (la suite, `computeDiff`, arrive en Task 2)**

```ts
// src/lib/server/diff.ts
import { gitOk } from '$lib/server/git';

export interface NumstatEntry {
	path: string;
	additions: number | null;
	deletions: number | null;
}
export interface NameStatusEntry {
	path: string;
	status: string;
}
export interface DiffFile {
	path: string;
	status: string;
	additions: number | null;
	deletions: number | null;
}

export function parseNumstat(output: string): NumstatEntry[] {
	return output
		.split('\n')
		.filter((l) => l.trim() !== '')
		.map((line) => {
			const [add, del, ...rest] = line.split('\t');
			return {
				path: rest.join('\t'),
				additions: add === '-' ? null : Number(add),
				deletions: del === '-' ? null : Number(del)
			};
		});
}

export function parseNameStatus(output: string): NameStatusEntry[] {
	return output
		.split('\n')
		.filter((l) => l.trim() !== '')
		.map((line) => {
			const parts = line.split('\t');
			// Pour un rename (R100\told\tnew), on garde le dernier chemin (la cible).
			return { path: parts[parts.length - 1], status: parts[0][0] };
		});
}

export function mergeDiffFiles(num: NumstatEntry[], names: NameStatusEntry[]): DiffFile[] {
	const counts = new Map(num.map((n) => [n.path, n]));
	return names.map((n) => ({
		path: n.path,
		status: n.status,
		additions: counts.get(n.path)?.additions ?? null,
		deletions: counts.get(n.path)?.deletions ?? null
	}));
}
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/server/diff.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/diff.ts src/lib/server/diff.test.ts
git commit -m "feat(diff): numstat/name-status parsers (DOT-16 P4)"
```

---

### Task 2: `computeDiff` (intégration git)

**Files:**

- Modify: `src/lib/server/diff.ts`
- Test: `src/lib/server/diff.integration.test.ts`

- [ ] **Step 1: Écrire le test d'intégration qui échoue** (git réel sur un repo temporaire)

```ts
// src/lib/server/diff.integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitOk } from './git';
import { computeDiff } from './diff';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'dw-diff-'));
	await gitOk(['init', '-b', 'main'], { cwd: dir });
	await gitOk(['config', 'user.email', 't@t.t'], { cwd: dir });
	await gitOk(['config', 'user.name', 't'], { cwd: dir });
	await writeFile(join(dir, 'a.txt'), 'one\n');
	await gitOk(['add', '-A'], { cwd: dir });
	await gitOk(['commit', '-m', 'base'], { cwd: dir });
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('computeDiff', () => {
	it('reports added file, counts, and includes the patch', async () => {
		const base = await gitOk(['rev-parse', 'HEAD'], { cwd: dir });
		await writeFile(join(dir, 'b.txt'), 'hello\nworld\n');
		await gitOk(['add', '-A'], { cwd: dir });
		await gitOk(['commit', '-m', 'add b'], { cwd: dir });
		const head = await gitOk(['rev-parse', 'HEAD'], { cwd: dir });

		const diff = await computeDiff(dir, base, head);
		expect(diff.files).toEqual([{ path: 'b.txt', status: 'A', additions: 2, deletions: 0 }]);
		expect(diff.patch).toContain('+hello');
		expect(diff.truncated).toBe(false);
	});
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/server/diff.integration.test.ts`
Expected: FAIL — `computeDiff` n'existe pas.

- [ ] **Step 3: Ajouter `computeDiff` à `src/lib/server/diff.ts`** (à la fin du fichier)

```ts
export interface RunDiff {
	files: DiffFile[];
	patch: string;
	truncated: boolean;
}

const MAX_PATCH = 200_000;

/** Calcule le diff base..head depuis un checkout (côté hôte). */
export async function computeDiff(
	checkoutPath: string,
	baseSha: string,
	headSha: string,
	env: Record<string, string | undefined> = process.env
): Promise<RunDiff> {
	const range = `${baseSha}..${headSha}`;
	const [numstat, nameStatus, rawPatch] = await Promise.all([
		gitOk(['diff', '--numstat', range], { cwd: checkoutPath, env }),
		gitOk(['diff', '--name-status', range], { cwd: checkoutPath, env }),
		gitOk(['diff', range], { cwd: checkoutPath, env })
	]);
	const files = mergeDiffFiles(parseNumstat(numstat), parseNameStatus(nameStatus));
	const truncated = rawPatch.length > MAX_PATCH;
	return { files, patch: truncated ? rawPatch.slice(0, MAX_PATCH) : rawPatch, truncated };
}
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/server/diff.integration.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/diff.ts src/lib/server/diff.integration.test.ts
git commit -m "feat(diff): computeDiff base..head from a checkout (DOT-16 P4)"
```

---

### Task 3: Schéma d'approbation (TDD)

**Files:**

- Modify: `src/lib/schemas/runs.ts`
- Test: `src/lib/schemas/runs.test.ts`

- [ ] **Step 1: Ajouter le test (au fichier existant)**

Ajouter à `src/lib/schemas/runs.test.ts` :

```ts
import { startRunSchema, approveRunSchema } from './runs';

describe('approveRunSchema', () => {
	it('accepts the three actions', () => {
		for (const action of ['push_pr', 'push', 'abandon'] as const) {
			expect(approveRunSchema.safeParse({ runId: 'r1', action }).success).toBe(true);
		}
	});
	it('rejects an unknown action', () => {
		expect(approveRunSchema.safeParse({ runId: 'r1', action: 'merge' }).success).toBe(false);
	});
	it('rejects a missing runId', () => {
		expect(approveRunSchema.safeParse({ action: 'push' }).success).toBe(false);
	});
});
```

(Garder l'import existant de `startRunSchema` ; remplacer la ligne d'import par celle ci-dessus si nécessaire.)

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/schemas/runs.test.ts`
Expected: FAIL — `approveRunSchema` n'existe pas.

- [ ] **Step 3: Ajouter le schéma à `src/lib/schemas/runs.ts`**

```ts
export const approveRunSchema = z.object({
	runId: z.string().min(1),
	action: z.enum(['push_pr', 'push', 'abandon'])
});

export type ApproveRunSchema = typeof approveRunSchema;
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/schemas/runs.test.ts`
Expected: PASS (les 3 existants + 3 nouveaux).

- [ ] **Step 5: Commit**

```bash
git add src/lib/schemas/runs.ts src/lib/schemas/runs.test.ts
git commit -m "feat(runs): approve-run schema (DOT-16 P4)"
```

---

### Task 4: Push GitHub + ouverture de PR

**Files:**

- Create: `src/lib/server/github-push.ts`

Intégration réseau/git → vérifié par compilation ici + l'e2e (Task 7).

- [ ] **Step 1: Implémenter**

```ts
// src/lib/server/github-push.ts
import { git } from '$lib/server/git';
import { authedCloneUrl, makeGitAuth } from '$lib/server/github-git';

/** Pousse `branch` du checkout vers GitHub (token via askpass éphémère, jamais en config). */
export async function pushBranch(
	checkoutPath: string,
	cloneUrl: string,
	branch: string,
	token: string
): Promise<void> {
	const auth = await makeGitAuth(token);
	try {
		const res = await git(
			['push', authedCloneUrl(cloneUrl), `refs/heads/${branch}:refs/heads/${branch}`],
			{ cwd: checkoutPath, env: auth.env }
		);
		if (res.code !== 0) throw new Error(`Push rejected: ${res.stderr.trim()}`);
	} finally {
		await auth.cleanup();
	}
}

export interface PrResult {
	number: number;
	url: string;
	state: string;
}

function ghHeaders(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'Content-Type': 'application/json'
	};
}

/** Ouvre une PR ; si une PR ouverte existe déjà pour ce head, la renvoie. */
export async function openPullRequest(
	token: string,
	owner: string,
	name: string,
	head: string,
	base: string,
	title: string,
	body: string
): Promise<PrResult> {
	const res = await fetch(`https://api.github.com/repos/${owner}/${name}/pulls`, {
		method: 'POST',
		headers: ghHeaders(token),
		body: JSON.stringify({ title, head, base, body })
	});
	if (res.ok) {
		const j = (await res.json()) as { number: number; html_url: string; state: string };
		return { number: j.number, url: j.html_url, state: j.state };
	}
	if (res.status === 422) {
		// PR déjà existante pour ce head → on la récupère.
		const existing = await fetch(
			`https://api.github.com/repos/${owner}/${name}/pulls?head=${owner}:${head}&state=open`,
			{ headers: ghHeaders(token) }
		);
		const arr = (await existing.json()) as Array<{ number: number; html_url: string; state: string }>;
		if (Array.isArray(arr) && arr[0]) {
			return { number: arr[0].number, url: arr[0].html_url, state: arr[0].state };
		}
	}
	throw new Error(`Open PR failed: ${res.status} ${await res.text()}`);
}
```

- [ ] **Step 2: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 3: Commit**

```bash
git add src/lib/server/github-push.ts
git commit -m "feat(github): push branch + open PR (DOT-16 P4)"
```

---

### Task 5: Remote functions `getRunDiff` + `approveRun`

**Files:**

- Modify: `src/lib/rfc/runs.remote.ts`

- [ ] **Step 1: Ajouter les imports en tête de `src/lib/rfc/runs.remote.ts`**

```ts
import { getGithubToken } from '$lib/server/github';
import { computeDiff } from '$lib/server/diff';
import { pushBranch, openPullRequest } from '$lib/server/github-push';
import { approveRunSchema } from '$lib/schemas/runs';
import { runWorktreePath, workspaceRoot } from '$lib/server/workspace-paths';
import { removeRunCheckout } from '$lib/server/workspace';
```

(Conserver les imports existants : `query`, `command`, `getRequestEvent`, `z`, `error`, `requireHeaders`, `requireActiveOrg`, `prisma`, `startRunSchema`, `agentBranch`, `enqueueRun`.)

- [ ] **Step 2: Ajouter les deux fonctions à la fin du fichier**

```ts
/** Diff base..head du run (org active), depuis son checkout conservé sur l'hôte. */
export const getRunDiff = query(z.string(), async (runId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const run = await prisma.run.findFirst({ where: { id: runId, organizationId } });
	if (!run) error(404, 'Run not found');
	if (!run.baseCommitSha || !run.headCommitSha) {
		return { files: [], patch: '', truncated: false };
	}
	const checkout = runWorktreePath(workspaceRoot(), run.projectId, runId);
	return computeDiff(checkout, run.baseCommitSha, run.headCommitSha);
});

/** Valide un run en `awaiting_review` : push (+ PR) ou abandon. Push synchrone. */
export const approveRun = command(approveRunSchema, async ({ runId, action }) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const run = await prisma.run.findFirst({
		where: { id: runId, organizationId },
		include: { project: true }
	});
	if (!run) error(404, 'Run not found');
	if (run.status !== 'awaiting_review') {
		error(400, `Run is not awaiting review (status: ${run.status})`);
	}
	const project = run.project;

	if (action === 'abandon') {
		await removeRunCheckout(run.projectId, runId);
		await prisma.run.update({
			where: { id: runId },
			data: { status: 'canceled', finishedAt: new Date() }
		});
		await getRun(runId).refresh();
		await listRuns(run.projectId).refresh();
		return { status: 'canceled' as const, pullRequestUrl: null };
	}

	await prisma.run.update({ where: { id: runId }, data: { status: 'pushing' } });
	try {
		const token = await getGithubToken(headers);
		const checkout = runWorktreePath(workspaceRoot(), run.projectId, runId);
		await pushBranch(checkout, project.cloneUrl, run.agentBranch, token);

		let pullRequestUrl: string | null = null;
		if (action === 'push_pr') {
			const title = run.prompt.split('\n')[0].slice(0, 72) || `dotWeaver run ${runId.slice(0, 8)}`;
			const body = `Automated changes from a dotWeaver agent run.\n\n**Prompt:**\n\n> ${run.prompt}`;
			const pr = await openPullRequest(
				token,
				project.owner,
				project.name,
				run.agentBranch,
				project.defaultBranch,
				title,
				body
			);
			await prisma.pullRequest.create({
				data: { runId, number: pr.number, url: pr.url, state: pr.state }
			});
			pullRequestUrl = pr.url;
		}

		await prisma.run.update({
			where: { id: runId },
			data: { status: 'completed', finishedAt: new Date() }
		});
		await getRun(runId).refresh();
		await listRuns(run.projectId).refresh();
		return { status: 'completed' as const, pullRequestUrl };
	} catch (err) {
		await prisma.run.update({
			where: { id: runId },
			data: { status: 'failed', error: String((err as Error)?.message ?? err) }
		});
		await getRun(runId).refresh();
		error(500, err instanceof Error ? err.message : 'Push failed');
	}
});
```

- [ ] **Step 3: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur. (Org-scoping présent ; `getRunDiff`/`approveRun` filtrent par `organizationId` ; `approveRun` n'agit que sur un run `awaiting_review`.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/rfc/runs.remote.ts
git commit -m "feat(runs): getRunDiff + approveRun (push/PR/abandon) remote functions (DOT-16 P4)"
```

---

### Task 6: UI — diff & actions de validation

**Files:**

- Modify: `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`

Ajoute, quand le run est en `awaiting_review`, le diff + trois boutons. On garde l'affichage existant (statut, prompt, events).

- [ ] **Step 1: Remplacer le composant**

```svelte
<!-- src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte -->
<script lang="ts">
	import { page } from '$app/state';
	import { getRun, getRunDiff, approveRun } from '$lib/rfc/runs.remote';
	import { Button } from '$lib/components/ui/button';

	const run = $derived(getRun(page.params.runId!));
	const isReview = $derived(run.current?.status === 'awaiting_review');
	const diff = $derived(isReview ? getRunDiff(page.params.runId!) : undefined);

	let busy = $state(false);
	let actionError = $state<string | null>(null);
	let prUrl = $state<string | null>(null);

	async function act(action: 'push_pr' | 'push' | 'abandon') {
		actionError = null;
		busy = true;
		try {
			const res = await approveRun({ runId: page.params.runId!, action });
			prUrl = res.pullRequestUrl ?? null;
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Action failed';
		} finally {
			busy = false;
		}
	}

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

		{#if prUrl}
			<p class="text-sm">
				Pull request: <a href={prUrl} target="_blank" rel="noreferrer" class="underline">{prUrl}</a>
			</p>
		{/if}

		{#if isReview}
			<section class="space-y-2">
				<h2 class="text-sm font-medium">Review changes</h2>
				{#if actionError}
					<p class="text-sm text-red-500">{actionError}</p>
				{/if}
				{#if diff?.current}
					<ul class="text-xs">
						{#each diff.current.files as f (f.path)}
							<li class="flex justify-between border-b py-1">
								<span class="font-mono">{f.status} {f.path}</span>
								<span class="text-muted-foreground">+{f.additions ?? '?'} -{f.deletions ?? '?'}</span>
							</li>
						{/each}
					</ul>
					{#if diff.current.files.length > 0}
						<pre class="max-h-96 overflow-auto rounded-md border bg-muted/30 p-2 text-xs">{diff.current.patch}{diff.current.truncated ? '\n… (diff tronqué)' : ''}</pre>
					{:else}
						<p class="text-sm text-muted-foreground">No changes in this run.</p>
					{/if}
					<div class="flex gap-2">
						<Button onclick={() => act('push_pr')} disabled={busy}>Push & PR</Button>
						<Button variant="outline" onclick={() => act('push')} disabled={busy}>Push branch</Button>
						<Button variant="outline" onclick={() => act('abandon')} disabled={busy}>Abandon</Button>
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">Loading diff…</p>
				{/if}
			</section>
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

- [ ] **Step 2: Autofixer Svelte**

Lancer le MCP Svelte `svelte-autofixer` (charger via `ToolSearch` `select:mcp__svelte__svelte-autofixer` si besoin) sur le composant jusqu'à 0 issue.

- [ ] **Step 3: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 4: Commit**

```bash
git add "src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte"
git commit -m "feat(runs): diff review + push/PR/abandon UI (DOT-16 P4)"
```

---

### Task 7: Vérification + end-to-end manuel

- [ ] **Step 1: Suite unitaire complète**

Run: `bun run test:unit -- --run`
Expected: tous verts (diff parsers + integration, approveRun schema + existants).

- [ ] **Step 2: Lint + format**

Run: `bunx eslint src/lib/server/diff.ts src/lib/server/github-push.ts src/lib/rfc/runs.remote.ts`
Puis `bunx prettier --write` sur les fichiers créés/modifiés ; commit si changement.

- [ ] **Step 3: End-to-end manuel** (nécessite Docker + worker + `CLAUDE_CODE_OAUTH_TOKEN` + un repo GitHub où tu as les droits push)

1. `bun run dev` + (terminal 2) `bun run runner`.
2. Importer **un repo qui t'appartient** (pas un repo public en lecture seule), lancer un run avec un prompt simple.
3. Quand le run est `awaiting_review`, ouvrir la page run → le diff s'affiche (fichiers + patch).
4. **Push branch** → vérifier que `claude/<runId>` apparaît sur GitHub. Relancer un run, **Push & PR** → une PR est ouverte (le lien s'affiche), `PullRequest` créé en base, run `completed`.
5. **Abandon** sur un autre run → run `canceled`, checkout supprimé.
6. Cas d'erreur : retirer le scope/push impossible → run `failed` avec message clair.

## Couverture Phase 4

- ✅ Parsers diff + `computeDiff` (Tasks 1–2)
- ✅ Schéma d'approbation (Task 3)
- ✅ Push branche + ouverture/réutilisation PR (Task 4)
- ✅ Remote functions `getRunDiff` + `approveRun` (push/PR/abandon), org-scopées, machine à états (Task 5)
- ✅ UI diff + actions (Task 6)
- ⏭️ Phase 3 : live stream SSE. Phase 5 : `--force-with-lease` (re-push resume/fork), GC checkouts, quotas, durcissement.
