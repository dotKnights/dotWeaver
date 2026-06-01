# DOT-16 Phase 2A — Agent execution primitives — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construire les primitives bas niveau qui exécutent un agent Claude sur un checkout isolé d'un repo : un gestionnaire de workspace (clone miroir + git worktree sur `claude/<runId>`), une couche d'invocation Docker, et l'image conteneur qui lance l'Agent SDK et commit ses changements.

**Architecture:** Côté hôte (app SvelteKit), des modules serveur purs/testables : `workspace-paths` (calcul de chemins), `git` (wrapper `git` via child_process), `workspace` (miroir + worktree), `docker` (construction des args `docker run` + spawn/kill). Côté conteneur, une image `docker/runner/` embarquant `@anthropic-ai/claude-agent-sdk` ; son entrypoint appelle `query()` avec `settingSources: ['project']` et `permissionMode: 'bypassPermissions'`, émet chaque message SDK en JSON-lines sur stdout, puis fait un commit de sécurité des changements de l'agent. L'orchestration (worker pg-boss, machine à états, persistance des events, remote functions, UI) est la **Phase 2B** et n'est PAS dans ce plan.

**Tech Stack:** Node 22 (child_process), Docker, `@anthropic-ai/claude-agent-sdk`, git, vitest. Auth modèle : abonnement via `CLAUDE_CODE_OAUTH_TOKEN`.

**Décisions de périmètre (validées) :**
- **Réseau conteneur ouvert** pour le MVP dev sur Mac (Docker Desktop) — l'allowlist egress Anthropic-only et le rootfs read-only sont une **dette documentée**, traitée en Phase 5 / hôte Linux. On applique quand même `--cap-drop ALL`, `--security-opt no-new-privileges`, et les limites CPU/RAM/PID.
- **Auth abonnement** : le token `CLAUDE_CODE_OAUTH_TOKEN` est lu depuis l'env de l'hôte et injecté dans le conteneur. L'entrypoint **supprime tout `ANTHROPIC_API_KEY`** parasite (qui sinon écrase silencieusement l'abonnement).
- **Prérequis machine** : Docker installé et démarré ; un token généré via `claude setup-token` pour le smoke test.

**Note politique (à connaître) :** depuis le 15 juin 2026, l'usage Agent SDK sur abonnement puise dans un crédit mensuel « Agent SDK » distinct des limites interactives. Contexte = équipe interne de confiance (usage autorisé). Pertinent pour les quotas (Phase 5).

---

### Task 1: Chemins de workspace (TDD pur)

**Files:**

- Create: `src/lib/server/workspace-paths.ts`
- Test: `src/lib/server/workspace-paths.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// src/lib/server/workspace-paths.test.ts
import { describe, it, expect } from 'vitest';
import { workspaceRoot, mirrorPath, runWorktreePath, agentBranch } from './workspace-paths';

describe('workspace-paths', () => {
	it('uses WORKSPACE_ROOT when set, else a default', () => {
		expect(workspaceRoot({ WORKSPACE_ROOT: '/data/ws' })).toBe('/data/ws');
		expect(workspaceRoot({})).toBe('/tmp/dotweaver-workspaces');
	});

	it('derives mirror and worktree paths from ids', () => {
		expect(mirrorPath('/data/ws', 'proj1')).toBe('/data/ws/proj1/repo.git');
		expect(runWorktreePath('/data/ws', 'proj1', 'run1')).toBe('/data/ws/proj1/runs/run1');
	});

	it('names the agent branch from the run id', () => {
		expect(agentBranch('run1')).toBe('claude/run1');
	});
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/server/workspace-paths.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

```ts
// src/lib/server/workspace-paths.ts
import { join } from 'node:path';

/** Racine de stockage des workspaces sur l'hôte. */
export function workspaceRoot(env: Record<string, string | undefined> = process.env): string {
	return env.WORKSPACE_ROOT ?? '/tmp/dotweaver-workspaces';
}

/** Clone miroir (bare) servant de cache par projet. */
export function mirrorPath(root: string, projectId: string): string {
	return join(root, projectId, 'repo.git');
}

/** Checkout isolé d'un run (git worktree). */
export function runWorktreePath(root: string, projectId: string, runId: string): string {
	return join(root, projectId, 'runs', runId);
}

/** Branche de travail isolée de l'agent. */
export function agentBranch(runId: string): string {
	return `claude/${runId}`;
}
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/server/workspace-paths.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/workspace-paths.ts src/lib/server/workspace-paths.test.ts
git commit -m "feat(workspace): path helpers for mirror/worktree/branch (DOT-16 P2A)"
```

---

### Task 2: Wrapper `git` (child_process)

**Files:**

- Create: `src/lib/server/git.ts`
- Test: `src/lib/server/git.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// src/lib/server/git.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitOk } from './git';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'dw-git-'));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('git wrapper', () => {
	it('gitOk returns trimmed stdout on success', async () => {
		await gitOk(['init', '-b', 'main'], { cwd: dir });
		const branch = await gitOk(['symbolic-ref', '--short', 'HEAD'], { cwd: dir });
		expect(branch).toBe('main');
	});

	it('git returns a non-zero code instead of throwing', async () => {
		const res = await git(['rev-parse', 'HEAD'], { cwd: dir }); // no commits yet
		expect(res.code).not.toBe(0);
	});

	it('gitOk throws with stderr on failure', async () => {
		await expect(gitOk(['rev-parse', 'HEAD'], { cwd: dir })).rejects.toThrow(/git rev-parse HEAD failed/);
	});
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/server/git.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

```ts
// src/lib/server/git.ts
import { spawn } from 'node:child_process';

export interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface GitOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
}

/** Exécute `git <args>` ; ne rejette jamais sur un code non-zéro (le code est dans le retour). */
export function git(args: string[], opts: GitOptions = {}): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', args, { cwd: opts.cwd, env: opts.env ?? process.env });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => (stdout += d.toString()));
		child.stderr.on('data', (d) => (stderr += d.toString()));
		child.on('error', reject);
		child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
	});
}

/** Comme `git`, mais lève une erreur si le code est non-zéro ; renvoie stdout (trim). */
export async function gitOk(args: string[], opts: GitOptions = {}): Promise<string> {
	const res = await git(args, opts);
	if (res.code !== 0) {
		throw new Error(`git ${args.join(' ')} failed (${res.code}): ${res.stderr.trim()}`);
	}
	return res.stdout.trim();
}
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/server/git.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/git.ts src/lib/server/git.test.ts
git commit -m "feat(git): child_process git wrapper (DOT-16 P2A)"
```

---

### Task 3: Gestionnaire de workspace (miroir + checkout par run)

**Files:**

- Create: `src/lib/server/workspace.ts`
- Test: `src/lib/server/workspace.test.ts`

> **Écart assumé vs. design (« git worktree ») :** un *worktree* git stocke un `.git`
> **fichier** pointant vers un `gitdir` absolu situé dans le miroir — hors du bind-mount
> du conteneur. Git, dans le conteneur, ne pourrait pas le résoudre. On utilise donc un
> **`git clone` depuis le miroir local** : objets en hardlink (rapide, peu de disque) et
> `.git` **autonome**, montable tel quel. Le miroir reste le cache par projet.

- [ ] **Step 1: Écrire le test d'intégration qui échoue** (git réel sur un repo temporaire local, sans réseau)

```ts
// src/lib/server/workspace.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitOk } from './git';
import { ensureMirror, createRunCheckout, getHeadSha, removeRunCheckout } from './workspace';

let tmp: string;
let sourceRepo: string;
let env: Record<string, string | undefined>;

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), 'dw-ws-'));
	sourceRepo = join(tmp, 'source');
	await mkdir(sourceRepo, { recursive: true });
	await gitOk(['init', '-b', 'main'], { cwd: sourceRepo });
	await gitOk(['config', 'user.email', 't@t.t'], { cwd: sourceRepo });
	await gitOk(['config', 'user.name', 't'], { cwd: sourceRepo });
	await writeFile(join(sourceRepo, 'README.md'), '# hi\n');
	await gitOk(['add', '-A'], { cwd: sourceRepo });
	await gitOk(['commit', '-m', 'init'], { cwd: sourceRepo });
	env = { ...process.env, WORKSPACE_ROOT: join(tmp, 'workspaces') };
});
afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

describe('workspace lifecycle', () => {
	it('mirrors, creates a self-contained checkout on claude/<id>, captures head, cleans up', async () => {
		await ensureMirror('proj1', sourceRepo, env);
		const { checkoutPath, baseSha, branch } = await createRunCheckout('proj1', 'run1', 'main', env);
		expect(branch).toBe('claude/run1');
		expect(existsSync(checkoutPath)).toBe(true);
		// `.git` must be a real directory (self-contained), not a worktree pointer file.
		expect(existsSync(join(checkoutPath, '.git', 'HEAD'))).toBe(true);

		// the "agent" makes a change + commit on the checkout
		await writeFile(join(checkoutPath, 'NEW.md'), 'new\n');
		await gitOk(['config', 'user.email', 'a@a.a'], { cwd: checkoutPath });
		await gitOk(['config', 'user.name', 'a'], { cwd: checkoutPath });
		await gitOk(['add', '-A'], { cwd: checkoutPath });
		await gitOk(['commit', '-m', 'change'], { cwd: checkoutPath });

		const head = await getHeadSha(checkoutPath, env);
		expect(head).not.toBe(baseSha);

		await removeRunCheckout('proj1', 'run1', env);
		expect(existsSync(checkoutPath)).toBe(false);
	});

	it('re-running ensureMirror fetches instead of failing', async () => {
		await ensureMirror('proj1', sourceRepo, env);
		await expect(ensureMirror('proj1', sourceRepo, env)).resolves.toBeTypeOf('string');
	});
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/server/workspace.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

```ts
// src/lib/server/workspace.ts
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gitOk } from './git';
import { workspaceRoot, mirrorPath, runWorktreePath, agentBranch } from './workspace-paths';

/**
 * Garantit un clone miroir (bare) du projet : clone si absent, sinon fetch.
 * `cloneUrl` peut être une URL distante (avec credentials gérés en amont) ou un
 * chemin local (utilisé par les tests). Renvoie le chemin du miroir.
 */
export async function ensureMirror(
	projectId: string,
	cloneUrl: string,
	env: Record<string, string | undefined> = process.env
): Promise<string> {
	const mirror = mirrorPath(workspaceRoot(env), projectId);
	if (existsSync(mirror)) {
		await gitOk(['fetch', '--prune'], { cwd: mirror, env });
	} else {
		await mkdir(dirname(mirror), { recursive: true });
		await gitOk(['clone', '--mirror', cloneUrl, mirror], { env });
	}
	return mirror;
}

/**
 * Crée un checkout **autonome** pour un run : `git clone` depuis le miroir local
 * (objets en hardlink → rapide + peu de disque, `.git` complet montable dans le
 * conteneur), puis une branche `claude/<runId>` basée sur `baseRef` résolu dans le
 * miroir. Renvoie le chemin du checkout + le sha de base.
 */
export async function createRunCheckout(
	projectId: string,
	runId: string,
	baseRef: string,
	env: Record<string, string | undefined> = process.env
): Promise<{ checkoutPath: string; baseSha: string; branch: string }> {
	const mirror = mirrorPath(workspaceRoot(env), projectId);
	const checkoutPath = runWorktreePath(workspaceRoot(env), projectId, runId);
	const branch = agentBranch(runId);
	const baseSha = await gitOk(['rev-parse', baseRef], { cwd: mirror, env });
	await mkdir(dirname(checkoutPath), { recursive: true });
	// Clone local (hardlinks) sans checkout, puis on crée la branche sur baseSha.
	await gitOk(['clone', '--no-checkout', mirror, checkoutPath], { env });
	await gitOk(['checkout', '-b', branch, baseSha], { cwd: checkoutPath, env });
	return { checkoutPath, baseSha, branch };
}

/** SHA du HEAD courant d'un checkout (après commits de l'agent). */
export async function getHeadSha(
	checkoutPath: string,
	env: Record<string, string | undefined> = process.env
): Promise<string> {
	return gitOk(['rev-parse', 'HEAD'], { cwd: checkoutPath, env });
}

/** Supprime le checkout du run (idempotent). La branche vit dans le checkout, donc rien d'autre à nettoyer. */
export async function removeRunCheckout(
	projectId: string,
	runId: string,
	env: Record<string, string | undefined> = process.env
): Promise<void> {
	const checkoutPath = runWorktreePath(workspaceRoot(env), projectId, runId);
	await rm(checkoutPath, { recursive: true, force: true });
}
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/server/workspace.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/workspace.ts src/lib/server/workspace.test.ts
git commit -m "feat(workspace): mirror clone + self-contained per-run checkout (DOT-16 P2A)"
```

---

### Task 4: Couche d'invocation Docker

**Files:**

- Create: `src/lib/server/docker.ts`
- Test: `src/lib/server/docker.test.ts`

La construction des arguments `docker run` est **pure** → TDD. Le `spawn`/`kill` réel est couvert par le smoke test (Task 6), pas par un test automatisé (évite d'exiger Docker en CI).

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// src/lib/server/docker.test.ts
import { describe, it, expect } from 'vitest';
import { buildRunArgs } from './docker';

describe('buildRunArgs', () => {
	it('includes hardening flags, the workspace mount, env pairs, image last', () => {
		const args = buildRunArgs({
			image: 'dotweaver-runner',
			name: 'run-abc',
			workspacePath: '/ws/proj/runs/abc',
			env: { RUN_PROMPT: 'do it', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }
		});
		expect(args[0]).toBe('run');
		expect(args).toContain('--rm');
		expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL']));
		expect(args).toEqual(expect.arrayContaining(['--security-opt', 'no-new-privileges']));
		expect(args).toEqual(expect.arrayContaining(['--name', 'run-abc']));
		expect(args).toEqual(expect.arrayContaining(['-v', '/ws/proj/runs/abc:/workspace']));
		expect(args).toEqual(expect.arrayContaining(['-e', 'RUN_PROMPT=do it']));
		expect(args).toEqual(expect.arrayContaining(['-e', 'CLAUDE_CODE_OAUTH_TOKEN=tok']));
		expect(args[args.length - 1]).toBe('dotweaver-runner');
	});

	it('defaults network to bridge (MVP open egress) and applies resource limits', () => {
		const args = buildRunArgs({
			image: 'img',
			name: 'n',
			workspacePath: '/w',
			env: {}
		});
		expect(args).toEqual(expect.arrayContaining(['--network', 'bridge']));
		expect(args).toEqual(expect.arrayContaining(['--memory', '4g']));
		expect(args).toEqual(expect.arrayContaining(['--cpus', '2']));
		expect(args).toEqual(expect.arrayContaining(['--pids-limit', '512']));
	});
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/server/docker.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

```ts
// src/lib/server/docker.ts
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface RunContainerSpec {
	image: string;
	name: string;
	/** Chemin hôte du worktree, bind-monté en RW sur /workspace. */
	workspacePath: string;
	/** Variables injectées dans le conteneur (RUN_PROMPT, CLAUDE_CODE_OAUTH_TOKEN, …). */
	env: Record<string, string>;
	memory?: string; // défaut '4g'
	cpus?: string; // défaut '2'
	pidsLimit?: number; // défaut 512
	network?: string; // défaut 'bridge' (MVP) ; 'none'+proxy egress en durcissement
}

/**
 * Construit l'argv de `docker run`. Durcissement MVP : cap-drop ALL,
 * no-new-privileges, limites CPU/RAM/PID. (rootfs read-only + egress allowlist =
 * dette Phase 5.)
 */
export function buildRunArgs(spec: RunContainerSpec): string[] {
	const args = [
		'run',
		'--rm',
		'--name',
		spec.name,
		'--cap-drop',
		'ALL',
		'--security-opt',
		'no-new-privileges',
		'--pids-limit',
		String(spec.pidsLimit ?? 512),
		'--memory',
		spec.memory ?? '4g',
		'--cpus',
		spec.cpus ?? '2',
		'--network',
		spec.network ?? 'bridge',
		'-v',
		`${spec.workspacePath}:/workspace`,
		'-w',
		'/workspace'
	];
	for (const [k, v] of Object.entries(spec.env)) {
		args.push('-e', `${k}=${v}`);
	}
	args.push(spec.image);
	return args;
}

export interface RunContainerResult {
	exitCode: number;
}

/**
 * Lance le conteneur et appelle `onLine` pour chaque ligne stdout (JSON-lines
 * de l'agent). Résout quand le conteneur se termine.
 */
export function runContainer(
	args: string[],
	onLine: (line: string) => void,
	onStderr?: (line: string) => void
): Promise<RunContainerResult> {
	const child = spawn('docker', args);
	const out = createInterface({ input: child.stdout });
	out.on('line', onLine);
	if (onStderr) {
		const err = createInterface({ input: child.stderr });
		err.on('line', onStderr);
	}
	return new Promise((resolve, reject) => {
		child.on('error', reject);
		child.on('close', (code) => resolve({ exitCode: code ?? -1 }));
	});
}

/** Tue un conteneur par son nom (annulation/timeout). Idempotent/best-effort. */
export function killContainer(name: string): Promise<void> {
	return new Promise((resolve) => {
		const child = spawn('docker', ['kill', name]);
		child.on('close', () => resolve());
		child.on('error', () => resolve());
	});
}
```

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `bun run test:unit -- --run src/lib/server/docker.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/docker.ts src/lib/server/docker.test.ts
git commit -m "feat(docker): run args builder + container spawn/kill (DOT-16 P2A)"
```

---

### Task 5: Image conteneur de l'agent

**Files:**

- Create: `docker/runner/Dockerfile`
- Create: `docker/runner/package.json`
- Create: `docker/runner/entrypoint.mjs`

- [ ] **Step 1: `docker/runner/package.json`**

D'abord, récupérer la version publiée actuelle du SDK pour la figer (pas de version inventée) :

Run: `npm view @anthropic-ai/claude-agent-sdk version`
Expected: une version, ex. `0.x.y`. Utiliser cette valeur ci-dessous (remplacer `<VERSION>`), en gardant le caret :

```json
{
	"name": "dotweaver-runner",
	"private": true,
	"type": "module",
	"dependencies": {
		"@anthropic-ai/claude-agent-sdk": "^<VERSION>"
	}
}
```

- [ ] **Step 2: `docker/runner/entrypoint.mjs`**

```js
// docker/runner/entrypoint.mjs
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';

const prompt = process.env.RUN_PROMPT;
const model = process.env.RUN_MODEL || undefined;
const resume = process.env.RUN_RESUME_SESSION || undefined;

if (!prompt) {
	console.error('RUN_PROMPT is required');
	process.exit(2);
}

// Ne jamais laisser une clé API parasite écraser l'OAuth abonnement.
if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
	delete process.env.ANTHROPIC_API_KEY;
}

function emit(obj) {
	process.stdout.write(JSON.stringify(obj) + '\n');
}

const gitc = (args) => execFileSync('git', args, { cwd: '/workspace' }).toString();

// Identité git pour les commits de l'agent.
gitc(['config', 'user.email', 'agent@dotweaver.local']);
gitc(['config', 'user.name', 'dotWeaver agent']);

let sessionId;
let lastResult;

try {
	for await (const message of query({
		prompt,
		options: {
			cwd: '/workspace',
			model,
			resume,
			settingSources: ['project'],
			permissionMode: 'bypassPermissions'
		}
	})) {
		if (message.type === 'system' && message.subtype === 'init') {
			sessionId = message.session_id;
		}
		if (message.type === 'result') {
			lastResult = message;
		}
		emit(message);
	}
} catch (err) {
	emit({ type: 'error', error: String(err?.message ?? err) });
	process.exit(1);
}

// Commit de sécurité : capture tout changement non commité par l'agent.
const status = gitc(['status', '--porcelain']).trim();
if (status) {
	gitc(['add', '-A']);
	gitc(['commit', '-m', 'chore: agent changes']);
}

const head = gitc(['rev-parse', 'HEAD']).trim();
emit({ type: 'runner_summary', session_id: sessionId, head, result_subtype: lastResult?.subtype ?? null });
```

- [ ] **Step 3: `docker/runner/Dockerfile`**

```dockerfile
FROM node:22-slim

# git pour l'outil Bash de l'agent ; ca-certificates pour le TLS vers l'API modèle.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /runner
COPY package.json ./
RUN npm install --omit=dev

COPY entrypoint.mjs ./

# Utilisateur non-root ; /workspace est bind-monté au runtime.
RUN useradd --create-home --uid 1001 agent \
	&& mkdir -p /workspace && chown agent:agent /workspace
USER agent

WORKDIR /workspace
ENTRYPOINT ["node", "/runner/entrypoint.mjs"]
```

- [ ] **Step 4: Construire l'image**

Run: `docker build -t dotweaver-runner docker/runner`
Expected: build réussi, image `dotweaver-runner` créée. (Nécessite Docker démarré.)

- [ ] **Step 5: Commit**

```bash
git add docker/runner/Dockerfile docker/runner/package.json docker/runner/entrypoint.mjs
git commit -m "feat(runner): agent container image (Agent SDK entrypoint) (DOT-16 P2A)"
```

---

### Task 6: Config env + smoke test d'intégration (manuel)

**Files:**

- Modify: `.env.example`
- Create: `docs/runner-smoke.md`

- [ ] **Step 1: Ajouter les variables à `.env.example`**

Ajouter à la fin de `.env.example` :

```
# DOT-16 runner (Phase 2)
WORKSPACE_ROOT=/tmp/dotweaver-workspaces
RUNNER_IMAGE=dotweaver-runner
# Token d'abonnement Claude Code (généré via `claude setup-token`). Ne JAMAIS committer la vraie valeur.
CLAUDE_CODE_OAUTH_TOKEN=
```

- [ ] **Step 2: Écrire la procédure de smoke `docs/runner-smoke.md`**

```markdown
# Smoke test du runner (DOT-16 Phase 2A)

Vérifie de bout en bout : workspace → conteneur → agent → commit. Manuel (nécessite
Docker démarré et un `CLAUDE_CODE_OAUTH_TOKEN` valide).

## 1. Prérequis
- `docker build -t dotweaver-runner docker/runner` (déjà fait en Task 5).
- `export CLAUDE_CODE_OAUTH_TOKEN=...` (via `claude setup-token`).
- S'assurer qu'aucun `ANTHROPIC_API_KEY` n'est exporté (sinon il écrase l'abonnement ;
  l'entrypoint le supprime côté conteneur, mais vérifier l'intention).

## 2. Préparer un workspace de test
\`\`\`bash
TMP=$(mktemp -d)
git init -b main "$TMP/src" && (cd "$TMP/src" && \
  git config user.email t@t.t && git config user.name t && \
  echo "# demo" > README.md && git add -A && git commit -m init)
git clone --mirror "$TMP/src" "$TMP/repo.git"
git clone --no-checkout "$TMP/repo.git" "$TMP/wt"
(cd "$TMP/wt" && git checkout -b claude/smoke main)
\`\`\`

## 3. Lancer l'agent
\`\`\`bash
docker run --rm \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 4g --cpus 2 --pids-limit 512 \
  -v "$TMP/wt:/workspace" -w /workspace \
  -e RUN_PROMPT="Create a file HELLO.md containing the word 'hi', then stop." \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  dotweaver-runner
\`\`\`

## 4. Attendu
- stdout : des lignes JSON (messages SDK : `system`/init avec `session_id`,
  `assistant`, `result`), puis une ligne finale `runner_summary` avec `head` + `session_id`.
- Le commit est dans le **checkout** (bind-monté), pas dans le miroir :
  \`git -C "$TMP/wt" log --oneline claude/smoke\` montre un nouveau commit au-dessus de
  `init`, et `HELLO.md` existe (\`ls "$TMP/wt/HELLO.md"\`).

## 5. Nettoyage
\`\`\`bash
rm -rf "$TMP"
\`\`\`
```

- [ ] **Step 3: Exécuter le smoke test**

Suivre `docs/runner-smoke.md`. Confirmer : lignes JSON sur stdout, `runner_summary` final, et un commit `HELLO.md` sur `claude/smoke`.
Si l'agent ne commit pas lui-même, le commit de sécurité de l'entrypoint doit quand même produire le commit — vérifier qu'il existe.

- [ ] **Step 4: Commit**

```bash
git add .env.example docs/runner-smoke.md
git commit -m "docs(runner): env vars + integration smoke procedure (DOT-16 P2A)"
```

---

### Task 7: Vérification finale

- [ ] **Step 1: Suite unitaire complète**

Run: `bun run test:unit -- --run`
Expected: tous verts (nouveaux : workspace-paths, git, workspace, docker + existants).

- [ ] **Step 2: Lint des fichiers touchés**

Run: `bunx eslint src/lib/server/workspace-paths.ts src/lib/server/git.ts src/lib/server/workspace.ts src/lib/server/docker.ts`
Expected: 0 erreur. (L'image `docker/runner/*` n'est pas couverte par l'eslint de l'app — c'est un projet conteneur séparé.)

- [ ] **Step 3: Format**

Run: `bunx prettier --write src/lib/server/workspace-paths.ts src/lib/server/git.ts src/lib/server/workspace.ts src/lib/server/docker.ts src/lib/server/workspace-paths.test.ts src/lib/server/git.test.ts src/lib/server/workspace.test.ts src/lib/server/docker.test.ts`
Then: `git add -A && git commit -m "chore: format (DOT-16 P2A)"` (si des fichiers ont changé).

---

## Couverture du périmètre Phase 2A

- ✅ Chemins workspace (Task 1)
- ✅ Wrapper git (Task 2)
- ✅ Miroir + checkout autonome par run sur `claude/<id>` (Task 3)
- ✅ Args `docker run` durcis (MVP) + spawn/kill (Task 4)
- ✅ Image conteneur + entrypoint Agent SDK + commit de sécurité (Task 5)
- ✅ Smoke test bout-en-bout + config env (Task 6)
- ⏭️ Dette documentée : egress Anthropic-only, rootfs read-only (Phase 5).

## Phase 2B (prochain plan — orchestration & déclenchement)

Construit sur 2A. Tâches prévues :
1. **Dépendance pg-boss** + script `bun run runner` (worker process séparé).
2. **Persistance des events** : `appendRunEvent(runId, message)` avec `seq` monotone → table `RunEvent`.
3. **Machine à états du run** (pur, TDD) : transitions `queued → preparing → running → awaiting_review` (+ `failed`/`canceled`/`timed_out`).
4. **Orchestrateur** (worker) : sur job → `ensureMirror` + `createRunCheckout` (token GitHub injecté via askpass éphémère pour repos privés) → `runContainer` (image `RUNNER_IMAGE`, env `CLAUDE_CODE_OAUTH_TOKEN` + `RUN_PROMPT`/`RUN_MODEL`/`RUN_RESUME_SESSION`) → parser stdout en `RunEvent` + capter `session_id`/`head` → `awaiting_review`. Récupération au démarrage des runs orphelins.
5. **Remote functions** `runs.remote.ts` : `startRun({ projectId, prompt })` (crée `Run` + enqueue, dans la même transaction), `cancelRun(id)` (`killContainer`), `getRun(id)`, `listRuns(projectId)`.
6. **UI minimale** : formulaire « Run » (prompt) sur la page projet → `startRun` ; affichage du statut final + résumé (pas de live stream — Phase 3).
7. **Quota MVP** : refus d'enqueue si trop de runs actifs pour l'org.
