# Serveur MCP distant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exposer dotWeaver à des clients MCP distants via un endpoint Streamable HTTP `/mcp` authentifié en OAuth (better-auth), avec 7 outils read-only et le streaming des events de run.

**Architecture:** Un endpoint SvelteKit `/mcp` enveloppé par `withMcpAuth` (better-auth) délègue à `createMcpHandler` (mcp-handler, basé sur le SDK MCP officiel). Les outils sont une fine façade au-dessus de **services partagés** extraits des remote functions ; le scoping multi-tenant est centralisé dans `context.ts`. Le streaming réutilise un async generator partagé avec l'endpoint SSE web existant.

**Tech Stack:** SvelteKit (adapter-node), better-auth + plugin `mcp`, `mcp-handler`, `@modelcontextprotocol/sdk`, Prisma/Postgres, Zod, Vitest.

---

## Référence — patterns existants à respecter

- Résolution org web : `requireActiveOrg(headers)` dans `src/lib/server/org.ts` (vérifie l'appartenance, lève 401/400/403).
- Garde multi-tenant : toujours `prisma.X.findFirst({ where: { id, organizationId } })`.
- Streaming SSE actuel : `src/routes/api/runs/[id]/events/+server.ts` (curseur `seq`, `formatSseEvent`, `isTerminalStatus`, abort listener, `POLL_MS=1000`, `PING_EVERY=15`).
- Tests co-localisés `*.test.ts` ; intégration `*.integration.test.ts`. Lancer : `bun run test:unit -- --run <fichier>`.

## Structure des fichiers

**Créés :**
- `src/lib/server/projects-service.ts` — accès projets par `organizationId` (pur, sans `getRequestEvent`).
- `src/lib/server/runs-service.ts` — accès runs/diff par `organizationId` (pur).
- `src/lib/server/teams-service.ts` — orgs d'un `userId` (pur).
- `src/lib/server/mcp/context.ts` — `resolveOrgContext(userId, teamSlug?)` + erreurs typées.
- `src/lib/server/mcp/tools.ts` — `registerTools(server, ctx)` : enregistre les 7 outils.
- `src/lib/server/mcp/server.ts` — `createDotweaverMcpHandler(session)` : construit le handler fetch.
- `src/routes/mcp/+server.ts` — endpoint Streamable HTTP (`withMcpAuth` → handler).
- `src/routes/.well-known/oauth-protected-resource/+server.ts` — discovery RFC 9728.
- `src/routes/.well-known/oauth-authorization-server/+server.ts` — discovery AS.
- Tests : `*.test.ts` à côté de chaque service + `mcp/context.test.ts`, `mcp/tools.test.ts`, `mcp/mcp.integration.test.ts`.

**Modifiés :**
- `src/lib/server/auth.ts` — ajout du plugin `mcp({...})`.
- `prisma/schema.prisma` — tables OAuth générées par better-auth + migration.
- `src/lib/server/run-stream.ts` — ajout du generator `streamRunEvents`.
- `src/routes/api/runs/[id]/events/+server.ts` — consomme le generator.
- `src/lib/rfc/runs.remote.ts`, `projects.remote.ts` — délèguent aux services.

---

## Task 1 : Dépendances, plugin MCP, migration OAuth

**Files:**
- Modify: `src/lib/server/auth.ts`
- Modify: `prisma/schema.prisma` (généré)
- Modify: `package.json` (deps)

- [ ] **Step 1 : Installer les dépendances**

```bash
bun add mcp-handler @modelcontextprotocol/sdk
```

Expected : `mcp-handler` et `@modelcontextprotocol/sdk` ajoutés à `dependencies`.

- [ ] **Step 2 : Ajouter le plugin `mcp()` à l'auth**

Dans `src/lib/server/auth.ts`, importer le plugin et l'ajouter au tableau `plugins`. Le `resource` doit être l'URL absolue de l'endpoint `/mcp` ; `loginPage` réutilise `/login`.

```ts
import { organization, mcp } from 'better-auth/plugins';
// ...
	plugins: [
		organization(),
		mcp({
			loginPage: '/login',
			resource: new URL('/mcp', env.BETTER_AUTH_URL).toString()
		})
	]
```

- [ ] **Step 3 : Générer le schéma OAuth better-auth dans Prisma**

Le plugin `mcp` active le provider OAuth de better-auth, qui requiert de nouvelles tables (`oauthApplication`, `oauthAccessToken`, `oauthConsent`). Générer leur définition Prisma :

```bash
bunx @better-auth/cli generate
```

Expected : `prisma/schema.prisma` mis à jour avec les 3 modèles OAuth. Si la CLI échoue (pas de config détectée), ajouter les modèles manuellement d'après la doc better-auth « MCP / OIDC Provider — Prisma schema » (champs : `oauthApplication`{clientId, clientSecret, name, redirectURLs, metadata, type, disabled, userId, createdAt, updatedAt}, `oauthAccessToken`{accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, clientId, userId, scopes, createdAt, updatedAt}, `oauthConsent`{clientId, userId, scopes, consentGiven, createdAt, updatedAt}).

- [ ] **Step 4 : Appliquer la migration + régénérer le client**

```bash
bunx prisma migrate dev --name add_oauth_mcp_tables
bunx prisma generate
```

Expected : migration créée et appliquée ; `@prisma/client` régénéré (rappel mémoire : prisma generate après tout changement de schéma).

- [ ] **Step 5 : Vérifier le typecheck**

Run : `bun run check`
Expected : 0 erreur (auth.ts compile, types Prisma à jour).

- [ ] **Step 6 : Commit**

```bash
git add package.json bun.lock src/lib/server/auth.ts prisma/
git commit -m "feat(mcp): add better-auth mcp plugin + OAuth tables + deps"
```

---

## Task 2 : Service partagé projets

**Files:**
- Create: `src/lib/server/projects-service.ts`
- Test: `src/lib/server/projects-service.test.ts`
- Modify: `src/lib/rfc/projects.remote.ts`

- [ ] **Step 1 : Écrire le test qui échoue**

`src/lib/server/projects-service.test.ts` :

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		project: { findMany: vi.fn(), findFirst: vi.fn() }
	}
}));

import { prisma } from '$lib/server/prisma';
import { listProjectsForOrg, getProjectForOrg } from './projects-service';

describe('projects-service', () => {
	beforeEach(() => vi.clearAllMocks());

	it('listProjectsForOrg scope par organizationId, trié récent', async () => {
		(prisma.project.findMany as any).mockResolvedValue([{ id: 'p1' }]);
		const res = await listProjectsForOrg('org1');
		expect(prisma.project.findMany).toHaveBeenCalledWith({
			where: { organizationId: 'org1' },
			orderBy: { createdAt: 'desc' }
		});
		expect(res).toEqual([{ id: 'p1' }]);
	});

	it('getProjectForOrg renvoie le projet si trouvé dans l’org', async () => {
		(prisma.project.findFirst as any).mockResolvedValue({ id: 'p1' });
		expect(await getProjectForOrg('org1', 'p1')).toEqual({ id: 'p1' });
		expect(prisma.project.findFirst).toHaveBeenCalledWith({
			where: { id: 'p1', organizationId: 'org1' }
		});
	});

	it('getProjectForOrg renvoie null si absent/hors org', async () => {
		(prisma.project.findFirst as any).mockResolvedValue(null);
		expect(await getProjectForOrg('org1', 'nope')).toBeNull();
	});
});
```

- [ ] **Step 2 : Lancer le test (échec attendu)**

Run : `bun run test:unit -- --run src/lib/server/projects-service.test.ts`
Expected : FAIL (`listProjectsForOrg is not a function` / module introuvable).

- [ ] **Step 3 : Implémenter le service**

`src/lib/server/projects-service.ts` :

```ts
import { prisma } from '$lib/server/prisma';

/** Projets d'une organisation, du plus récent au plus ancien. */
export function listProjectsForOrg(organizationId: string) {
	return prisma.project.findMany({
		where: { organizationId },
		orderBy: { createdAt: 'desc' }
	});
}

/** Projet par id, scopé à l'org. `null` si absent ou hors org. */
export function getProjectForOrg(organizationId: string, id: string) {
	return prisma.project.findFirst({ where: { id, organizationId } });
}
```

- [ ] **Step 4 : Lancer le test (succès attendu)**

Run : `bun run test:unit -- --run src/lib/server/projects-service.test.ts`
Expected : PASS (3 tests).

- [ ] **Step 5 : Refactorer les remote functions pour déléguer**

Dans `src/lib/rfc/projects.remote.ts`, remplacer le corps prisma de `listProjects` et `getProject` par un appel au service (la résolution d'org reste identique) :

```ts
import { listProjectsForOrg, getProjectForOrg } from '$lib/server/projects-service';
// ...
export const listProjects = query(async () => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	return await listProjectsForOrg(organizationId);
});

export const getProject = query(z.string(), async (id) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const project = await getProjectForOrg(organizationId, id);
	if (!project) error(404, 'Project not found');
	return project;
});
```

- [ ] **Step 6 : Vérifier que tout reste vert**

Run : `bun run test:unit -- --run src/lib/server/projects-service.test.ts && bun run check`
Expected : PASS + 0 erreur de type.

- [ ] **Step 7 : Commit**

```bash
git add src/lib/server/projects-service.ts src/lib/server/projects-service.test.ts src/lib/rfc/projects.remote.ts
git commit -m "refactor(projects): extract shared projects-service consumed by remote functions"
```

---

## Task 3 : Service partagé runs (+ diff)

**Files:**
- Create: `src/lib/server/runs-service.ts`
- Test: `src/lib/server/runs-service.test.ts`
- Modify: `src/lib/rfc/runs.remote.ts`

- [ ] **Step 1 : Écrire le test qui échoue**

`src/lib/server/runs-service.test.ts` :

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: { run: { findMany: vi.fn(), findFirst: vi.fn() } }
}));
vi.mock('$lib/server/diff', () => ({ computeDiff: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));

import { prisma } from '$lib/server/prisma';
import { computeDiff } from '$lib/server/diff';
import { existsSync } from 'node:fs';
import {
	listRunsForOrg,
	getRunForOrg,
	getRunDiffForOrg,
	RunWorkspaceUnavailableError
} from './runs-service';

describe('runs-service', () => {
	beforeEach(() => vi.clearAllMocks());

	it('listRunsForOrg scope projet + org, trié queuedAt desc', async () => {
		(prisma.run.findMany as any).mockResolvedValue([{ id: 'r1' }]);
		await listRunsForOrg('org1', 'p1');
		expect(prisma.run.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { projectId: 'p1', organizationId: 'org1' } })
		);
	});

	it('getRunForOrg inclut les events ordonnés', async () => {
		(prisma.run.findFirst as any).mockResolvedValue({ id: 'r1' });
		await getRunForOrg('org1', 'r1');
		expect(prisma.run.findFirst).toHaveBeenCalledWith({
			where: { id: 'r1', organizationId: 'org1' },
			include: { events: { orderBy: { seq: 'asc' } } }
		});
	});

	it('getRunForOrg renvoie null hors org', async () => {
		(prisma.run.findFirst as any).mockResolvedValue(null);
		expect(await getRunForOrg('org1', 'x')).toBeNull();
	});

	it('getRunDiffForOrg renvoie diff vide si pas de SHAs', async () => {
		(prisma.run.findFirst as any).mockResolvedValue({ id: 'r1', baseCommitSha: null });
		expect(await getRunDiffForOrg('org1', 'r1')).toEqual({ files: [], patch: '', truncated: false });
	});

	it('getRunDiffForOrg lève RunWorkspaceUnavailableError si checkout absent', async () => {
		(prisma.run.findFirst as any).mockResolvedValue({
			id: 'r1', projectId: 'p1', baseCommitSha: 'a', headCommitSha: 'b'
		});
		(existsSync as any).mockReturnValue(false);
		await expect(getRunDiffForOrg('org1', 'r1')).rejects.toBeInstanceOf(
			RunWorkspaceUnavailableError
		);
	});

	it('getRunDiffForOrg calcule le diff si checkout présent', async () => {
		(prisma.run.findFirst as any).mockResolvedValue({
			id: 'r1', projectId: 'p1', baseCommitSha: 'a', headCommitSha: 'b'
		});
		(existsSync as any).mockReturnValue(true);
		(computeDiff as any).mockResolvedValue({ files: [], patch: 'x', truncated: false });
		const res = await getRunDiffForOrg('org1', 'r1');
		expect(res).toEqual({ files: [], patch: 'x', truncated: false });
	});
});
```

- [ ] **Step 2 : Lancer le test (échec attendu)**

Run : `bun run test:unit -- --run src/lib/server/runs-service.test.ts`
Expected : FAIL (module/exports introuvables).

- [ ] **Step 3 : Implémenter le service**

`src/lib/server/runs-service.ts` :

```ts
import { existsSync } from 'node:fs';
import { prisma } from '$lib/server/prisma';
import { computeDiff } from '$lib/server/diff';
import { runWorktreePath, workspaceRoot } from '$lib/server/workspace-paths';

/** Levée quand le checkout d'un run n'existe plus sur l'hôte (mappée 409 côté web). */
export class RunWorkspaceUnavailableError extends Error {
	constructor() {
		super(
			'Run workspace is no longer available (cleaned up, or this server uses a different WORKSPACE_ROOT than the worker).'
		);
		this.name = 'RunWorkspaceUnavailableError';
	}
}

/** Runs d'un projet (scopé org), du plus récent au plus ancien. */
export function listRunsForOrg(organizationId: string, projectId: string) {
	return prisma.run.findMany({
		where: { projectId, organizationId },
		orderBy: { queuedAt: 'desc' },
		select: {
			id: true, status: true, prompt: true,
			queuedAt: true, finishedAt: true, error: true
		}
	});
}

/** Détail d'un run (scopé org) avec events ordonnés. `null` si absent/hors org. */
export function getRunForOrg(organizationId: string, runId: string) {
	return prisma.run.findFirst({
		where: { id: runId, organizationId },
		include: { events: { orderBy: { seq: 'asc' } } }
	});
}

/** Diff base..head du run (scopé org). `null` si run absent/hors org. */
export async function getRunDiffForOrg(organizationId: string, runId: string) {
	const run = await prisma.run.findFirst({ where: { id: runId, organizationId } });
	if (!run) return null;
	if (!run.baseCommitSha || !run.headCommitSha) {
		return { files: [], patch: '', truncated: false };
	}
	const checkout = runWorktreePath(workspaceRoot(), run.projectId, runId);
	if (!existsSync(checkout)) throw new RunWorkspaceUnavailableError();
	return computeDiff(checkout, run.baseCommitSha, run.headCommitSha);
}
```

- [ ] **Step 4 : Lancer le test (succès attendu)**

Run : `bun run test:unit -- --run src/lib/server/runs-service.test.ts`
Expected : PASS (6 tests).

- [ ] **Step 5 : Refactorer les remote functions read-only**

Dans `src/lib/rfc/runs.remote.ts`, remplacer les corps de `listRuns`, `getRun`, `getRunDiff` par des appels au service (résolution d'org inchangée ; conserver le mapping d'erreurs SvelteKit) :

```ts
import {
	listRunsForOrg, getRunForOrg, getRunDiffForOrg, RunWorkspaceUnavailableError
} from '$lib/server/runs-service';
// ...
export const listRuns = query(z.string(), async (projectId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	return await listRunsForOrg(organizationId, projectId);
});

export const getRun = query(z.string(), async (runId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const run = await getRunForOrg(organizationId, runId);
	if (!run) error(404, 'Run not found');
	return run;
});

export const getRunDiff = query(z.string(), async (runId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	try {
		const diff = await getRunDiffForOrg(organizationId, runId);
		if (!diff) error(404, 'Run not found');
		return diff;
	} catch (e) {
		if (e instanceof RunWorkspaceUnavailableError) error(409, e.message);
		throw e;
	}
});
```

Laisser `startRun`, `cancelRun`, `approveRun` **inchangés** (mutations hors périmètre v1).

- [ ] **Step 6 : Vérifier que tout reste vert**

Run : `bun run test:unit -- --run src/lib/server/runs-service.test.ts && bun run check`
Expected : PASS + 0 erreur de type.

- [ ] **Step 7 : Commit**

```bash
git add src/lib/server/runs-service.ts src/lib/server/runs-service.test.ts src/lib/rfc/runs.remote.ts
git commit -m "refactor(runs): extract shared runs-service (list/get/diff) for reuse by MCP"
```

---

## Task 4 : Service teams + résolution du contexte org (garde multi-tenant)

**Files:**
- Create: `src/lib/server/teams-service.ts`
- Create: `src/lib/server/mcp/context.ts`
- Test: `src/lib/server/mcp/context.test.ts`

- [ ] **Step 1 : Écrire le test qui échoue**

`src/lib/server/mcp/context.test.ts` :

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: { member: { findMany: vi.fn() } }
}));

import { prisma } from '$lib/server/prisma';
import { resolveOrgContext, AmbiguousTeamError, TeamAccessError, NoTeamError } from './context';

const membership = (slug: string, orgId: string, role = 'member') => ({
	role,
	organization: { id: orgId, slug, name: slug }
});

describe('resolveOrgContext', () => {
	beforeEach(() => vi.clearAllMocks());

	it('une seule org, pas de team → défaut sur cette org', async () => {
		(prisma.member.findMany as any).mockResolvedValue([membership('acme', 'org1')]);
		expect(await resolveOrgContext('u1')).toBe('org1');
	});

	it('team fourni et membre → cette org', async () => {
		(prisma.member.findMany as any).mockResolvedValue([
			membership('acme', 'org1'), membership('globex', 'org2')
		]);
		expect(await resolveOrgContext('u1', 'globex')).toBe('org2');
	});

	it('team fourni mais non membre → TeamAccessError', async () => {
		(prisma.member.findMany as any).mockResolvedValue([membership('acme', 'org1')]);
		await expect(resolveOrgContext('u1', 'globex')).rejects.toBeInstanceOf(TeamAccessError);
	});

	it('plusieurs orgs sans team → AmbiguousTeamError listant les slugs', async () => {
		(prisma.member.findMany as any).mockResolvedValue([
			membership('acme', 'org1'), membership('globex', 'org2')
		]);
		const err = await resolveOrgContext('u1').catch((e) => e);
		expect(err).toBeInstanceOf(AmbiguousTeamError);
		expect(err.slugs).toEqual(['acme', 'globex']);
	});

	it('aucune org → NoTeamError', async () => {
		(prisma.member.findMany as any).mockResolvedValue([]);
		await expect(resolveOrgContext('u1')).rejects.toBeInstanceOf(NoTeamError);
	});
});
```

- [ ] **Step 2 : Lancer le test (échec attendu)**

Run : `bun run test:unit -- --run src/lib/server/mcp/context.test.ts`
Expected : FAIL (module introuvable).

- [ ] **Step 3 : Implémenter le service teams**

`src/lib/server/teams-service.ts` :

```ts
import { prisma } from '$lib/server/prisma';

/** Organisations dont l'utilisateur est membre (avec son rôle). */
export async function listTeamsForUser(userId: string) {
	const memberships = await prisma.member.findMany({
		where: { userId },
		select: { role: true, organization: { select: { id: true, slug: true, name: true } } }
	});
	return memberships.map((m) => ({
		id: m.organization.id,
		slug: m.organization.slug,
		name: m.organization.name,
		role: m.role
	}));
}
```

- [ ] **Step 4 : Implémenter la résolution de contexte**

`src/lib/server/mcp/context.ts` :

```ts
import { listTeamsForUser } from '$lib/server/teams-service';

/** L'utilisateur a plusieurs orgs et n'a pas précisé `team`. */
export class AmbiguousTeamError extends Error {
	constructor(public slugs: string[]) {
		super(`Multiple teams available — specify one of: ${slugs.join(', ')}`);
		this.name = 'AmbiguousTeamError';
	}
}
/** `team` fourni mais l'utilisateur n'en est pas membre (ou n'existe pas). */
export class TeamAccessError extends Error {
	constructor() {
		super('Access denied to the requested team');
		this.name = 'TeamAccessError';
	}
}
/** L'utilisateur n'appartient à aucune org. */
export class NoTeamError extends Error {
	constructor() {
		super('You are not a member of any team');
		this.name = 'NoTeamError';
	}
}

/**
 * Résout l'organizationId pour un appel MCP.
 * - `teamSlug` fourni → doit correspondre à une org dont l'user est membre.
 * - sinon → défaut si une seule org ; AmbiguousTeamError si plusieurs ; NoTeamError si zéro.
 * Fail-closed : aucune valeur permissive par défaut.
 */
export async function resolveOrgContext(userId: string, teamSlug?: string): Promise<string> {
	const teams = await listTeamsForUser(userId);
	if (teamSlug) {
		const match = teams.find((t) => t.slug === teamSlug);
		if (!match) throw new TeamAccessError();
		return match.id;
	}
	if (teams.length === 0) throw new NoTeamError();
	if (teams.length === 1) return teams[0].id;
	throw new AmbiguousTeamError(teams.map((t) => t.slug));
}
```

- [ ] **Step 5 : Lancer le test (succès attendu)**

Run : `bun run test:unit -- --run src/lib/server/mcp/context.test.ts`
Expected : PASS (5 tests).

- [ ] **Step 6 : Commit**

```bash
git add src/lib/server/teams-service.ts src/lib/server/mcp/context.ts src/lib/server/mcp/context.test.ts
git commit -m "feat(mcp): teams-service + multi-tenant org context resolution"
```

---

## Task 5 : Generator de streaming partagé

**Files:**
- Modify: `src/lib/server/run-stream.ts`
- Test: `src/lib/server/run-stream.test.ts` (étendre)
- Modify: `src/routes/api/runs/[id]/events/+server.ts`

- [ ] **Step 1 : Écrire le test qui échoue**

Ajouter à `src/lib/server/run-stream.test.ts` :

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: { runEvent: { findMany: vi.fn() }, run: { findUnique: vi.fn() } }
}));
import { prisma } from '$lib/server/prisma';
import { streamRunEvents } from './run-stream';

describe('streamRunEvents', () => {
	beforeEach(() => vi.clearAllMocks());

	it('émet les events par seq croissant puis termine sur statut terminal', async () => {
		(prisma.runEvent.findMany as any)
			.mockResolvedValueOnce([{ seq: 0, payload: { a: 1 } }, { seq: 1, payload: { a: 2 } }])
			.mockResolvedValue([]);
		(prisma.run.findUnique as any).mockResolvedValue({ status: 'completed' });

		const items: any[] = [];
		for await (const it of streamRunEvents('r1', { pollMs: 0, pingEvery: 1000 })) items.push(it);

		expect(items[0]).toEqual({ kind: 'event', seq: 0, payload: { a: 1 } });
		expect(items[1]).toEqual({ kind: 'event', seq: 1, payload: { a: 2 } });
		expect(items.at(-1)).toEqual({ kind: 'done', status: 'completed' });
	});

	it('reprend après fromSeq (curseur)', async () => {
		(prisma.runEvent.findMany as any).mockResolvedValue([]);
		(prisma.run.findUnique as any).mockResolvedValue({ status: 'completed' });
		const it = streamRunEvents('r1', { fromSeq: 5, pollMs: 0 });
		await it.next();
		expect(prisma.runEvent.findMany).toHaveBeenCalledWith({
			where: { runId: 'r1', seq: { gt: 5 } },
			orderBy: { seq: 'asc' }
		});
	});

	it('s’arrête immédiatement si signal déjà aborté', async () => {
		const ac = new AbortController();
		ac.abort();
		const items: any[] = [];
		for await (const it of streamRunEvents('r1', { signal: ac.signal, pollMs: 0 })) items.push(it);
		expect(items).toEqual([]);
	});
});
```

- [ ] **Step 2 : Lancer le test (échec attendu)**

Run : `bun run test:unit -- --run src/lib/server/run-stream.test.ts`
Expected : FAIL (`streamRunEvents` introuvable). Les tests existants de ce fichier doivent rester verts.

- [ ] **Step 3 : Implémenter le generator**

Ajouter à `src/lib/server/run-stream.ts` (garder l'existant) :

```ts
import { prisma } from '$lib/server/prisma';

export type RunStreamItem =
	| { kind: 'event'; seq: number; payload: unknown }
	| { kind: 'ping' }
	| { kind: 'done'; status: RunStatus };

export interface StreamRunEventsOptions {
	fromSeq?: number;
	pollMs?: number;
	pingEvery?: number;
	signal?: AbortSignal;
}

/**
 * Generator partagé : émet les RunEvent par `seq` croissant (curseur), un `ping`
 * périodique, et un `done` final sur statut terminal. Consommé par l'endpoint SSE
 * web ET l'outil MCP. S'arrête sur abort.
 */
export async function* streamRunEvents(
	runId: string,
	opts: StreamRunEventsOptions = {}
): AsyncGenerator<RunStreamItem> {
	const pollMs = opts.pollMs ?? 1000;
	const pingEvery = opts.pingEvery ?? 15;
	let cursor = opts.fromSeq ?? -1;
	let tick = 0;

	while (!opts.signal?.aborted) {
		const events = await prisma.runEvent.findMany({
			where: { runId, seq: { gt: cursor } },
			orderBy: { seq: 'asc' }
		});
		for (const ev of events) {
			yield { kind: 'event', seq: ev.seq, payload: ev.payload };
			cursor = ev.seq;
		}
		const current = await prisma.run.findUnique({
			where: { id: runId },
			select: { status: true }
		});
		if (current && isTerminalStatus(current.status)) {
			yield { kind: 'done', status: current.status };
			return;
		}
		if (++tick % pingEvery === 0) yield { kind: 'ping' };
		if (opts.signal?.aborted) return;
		await new Promise((r) => setTimeout(r, pollMs));
	}
}
```

- [ ] **Step 4 : Lancer le test (succès attendu)**

Run : `bun run test:unit -- --run src/lib/server/run-stream.test.ts`
Expected : PASS (anciens + 3 nouveaux).

- [ ] **Step 5 : Refactorer l'endpoint SSE web pour consommer le generator**

Dans `src/routes/api/runs/[id]/events/+server.ts`, remplacer la boucle `while` interne par la consommation de `streamRunEvents`. Conserver toute la partie auth/garde au-dessus inchangée. Le corps du `ReadableStream.start` devient :

```ts
import { formatSseEvent, streamRunEvents } from '$lib/server/run-stream';
// ... (auth/garde inchangés) ...
	const lastEventId = Number(request.headers.get('last-event-id'));
	const fromSeq = Number.isFinite(lastEventId) ? lastEventId : -1;

	const stream = new ReadableStream({
		async start(controller) {
			const enc = new TextEncoder();
			let closed = false;
			const close = () => {
				if (closed) return;
				closed = true;
				try { controller.close(); } catch { /* déjà fermé */ }
			};
			request.signal.addEventListener('abort', close);
			try {
				for await (const item of streamRunEvents(runId, { signal: request.signal })) {
					if (closed) break;
					if (item.kind === 'event') controller.enqueue(enc.encode(formatSseEvent(item.seq, item.payload)));
					else if (item.kind === 'ping') controller.enqueue(enc.encode(': ping\n\n'));
					else if (item.kind === 'done') controller.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify({ status: item.status })}\n\n`));
				}
			} finally {
				close();
			}
		}
	});
```

- [ ] **Step 6 : Vérifier que tout reste vert**

Run : `bun run test:unit -- --run src/lib/server/run-stream.test.ts && bun run check`
Expected : PASS + 0 erreur. (Si des tests d'intégration SSE existent — `run-stream.integration` ou e2e — les lancer aussi.)

- [ ] **Step 7 : Commit**

```bash
git add src/lib/server/run-stream.ts src/lib/server/run-stream.test.ts "src/routes/api/runs/[id]/events/+server.ts"
git commit -m "refactor(run-stream): shared streamRunEvents generator; web SSE consumes it"
```

---

## Task 6 : Outils MCP (registre)

**Files:**
- Create: `src/lib/server/mcp/tools.ts`
- Test: `src/lib/server/mcp/tools.test.ts`

- [ ] **Step 1 : Écrire le test qui échoue**

`src/lib/server/mcp/tools.test.ts` — on teste le registre via un faux `server` qui capture les outils enregistrés, et on mocke services + context.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/mcp/context', () => ({
	resolveOrgContext: vi.fn(),
	AmbiguousTeamError: class extends Error { slugs: string[] = []; },
	TeamAccessError: class extends Error {},
	NoTeamError: class extends Error {}
}));
vi.mock('$lib/server/projects-service', () => ({
	listProjectsForOrg: vi.fn(), getProjectForOrg: vi.fn()
}));
vi.mock('$lib/server/runs-service', () => ({
	listRunsForOrg: vi.fn(), getRunForOrg: vi.fn(), getRunDiffForOrg: vi.fn(),
	RunWorkspaceUnavailableError: class extends Error {}
}));
vi.mock('$lib/server/teams-service', () => ({ listTeamsForUser: vi.fn() }));

import { resolveOrgContext } from '$lib/server/mcp/context';
import { listProjectsForOrg } from '$lib/server/projects-service';
import { getRunForOrg } from '$lib/server/runs-service';
import { registerTools } from './tools';

/** Faux McpServer : capture les handlers enregistrés par nom. */
function fakeServer() {
	const tools: Record<string, (args: any, extra?: any) => Promise<any>> = {};
	return {
		tools,
		tool(name: string, _desc: string, _schema: any, handler: any) { tools[name] = handler; }
	};
}

describe('registerTools', () => {
	beforeEach(() => vi.clearAllMocks());

	it('enregistre les 7 outils read-only', () => {
		const s = fakeServer();
		registerTools(s as any, { userId: 'u1' });
		expect(Object.keys(s.tools).sort()).toEqual([
			'get_project', 'get_run', 'get_run_diff',
			'list_projects', 'list_runs', 'list_teams', 'stream_run_events'
		]);
	});

	it('list_projects résout l’org puis appelle le service', async () => {
		const s = fakeServer();
		registerTools(s as any, { userId: 'u1' });
		(resolveOrgContext as any).mockResolvedValue('org1');
		(listProjectsForOrg as any).mockResolvedValue([{ id: 'p1' }]);
		const res = await s.tools.list_projects({ team: 'acme' });
		expect(resolveOrgContext).toHaveBeenCalledWith('u1', 'acme');
		expect(JSON.parse(res.content[0].text)).toEqual([{ id: 'p1' }]);
		expect(res.isError).toBeFalsy();
	});

	it('get_run renvoie isError si ressource introuvable', async () => {
		const s = fakeServer();
		registerTools(s as any, { userId: 'u1' });
		(resolveOrgContext as any).mockResolvedValue('org1');
		(getRunForOrg as any).mockResolvedValue(null);
		const res = await s.tools.get_run({ runId: 'x' });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/not found/i);
	});

	it('mappe AmbiguousTeamError en isError listant les slugs', async () => {
		const s = fakeServer();
		registerTools(s as any, { userId: 'u1' });
		const { AmbiguousTeamError } = await import('$lib/server/mcp/context');
		const err = new (AmbiguousTeamError as any)();
		err.slugs = ['acme', 'globex'];
		(resolveOrgContext as any).mockRejectedValue(err);
		const res = await s.tools.list_projects({});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/acme/);
	});
});
```

- [ ] **Step 2 : Lancer le test (échec attendu)**

Run : `bun run test:unit -- --run src/lib/server/mcp/tools.test.ts`
Expected : FAIL (`registerTools` introuvable).

- [ ] **Step 3 : Implémenter le registre d'outils**

`src/lib/server/mcp/tools.ts` :

```ts
import { z } from 'zod';
import {
	resolveOrgContext, AmbiguousTeamError, TeamAccessError, NoTeamError
} from '$lib/server/mcp/context';
import { listTeamsForUser } from '$lib/server/teams-service';
import { listProjectsForOrg, getProjectForOrg } from '$lib/server/projects-service';
import {
	listRunsForOrg, getRunForOrg, getRunDiffForOrg, RunWorkspaceUnavailableError
} from '$lib/server/runs-service';

export interface McpToolContext {
	userId: string;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
	content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
});
const fail = (message: string): ToolResult => ({
	content: [{ type: 'text', text: message }],
	isError: true
});

/** Mappe les erreurs de résolution d'org vers des messages outil non fuitants. */
function mapOrgError(e: unknown): ToolResult | null {
	if (e instanceof AmbiguousTeamError) return fail(e.message);
	if (e instanceof TeamAccessError) return fail('Access denied to the requested team');
	if (e instanceof NoTeamError) return fail('You are not a member of any team');
	return null;
}

const team = z.string().optional().describe('Team slug. Optional if you belong to a single team.');

/** Enregistre les 7 outils read-only sur un McpServer, scopés à `ctx.userId`. */
export function registerTools(server: any, ctx: McpToolContext): void {
	server.tool(
		'list_teams',
		'List the teams (organizations) you belong to.',
		{},
		async (): Promise<ToolResult> => {
			try {
				return ok(await listTeamsForUser(ctx.userId));
			} catch (e) {
				return fail('Failed to list teams');
			}
		}
	);

	server.tool(
		'list_projects',
		'List projects in a team.',
		{ team: team },
		async (args: { team?: string }): Promise<ToolResult> => {
			try {
				const orgId = await resolveOrgContext(ctx.userId, args.team);
				return ok(await listProjectsForOrg(orgId));
			} catch (e) {
				return mapOrgError(e) ?? fail('Failed to list projects');
			}
		}
	);

	server.tool(
		'get_project',
		'Get a project by id.',
		{ projectId: z.string(), team: team },
		async (args: { projectId: string; team?: string }): Promise<ToolResult> => {
			try {
				const orgId = await resolveOrgContext(ctx.userId, args.team);
				const project = await getProjectForOrg(orgId, args.projectId);
				return project ? ok(project) : fail('Project not found');
			} catch (e) {
				return mapOrgError(e) ?? fail('Failed to get project');
			}
		}
	);

	server.tool(
		'list_runs',
		'List runs of a project, most recent first.',
		{ projectId: z.string(), team: team },
		async (args: { projectId: string; team?: string }): Promise<ToolResult> => {
			try {
				const orgId = await resolveOrgContext(ctx.userId, args.team);
				return ok(await listRunsForOrg(orgId, args.projectId));
			} catch (e) {
				return mapOrgError(e) ?? fail('Failed to list runs');
			}
		}
	);

	server.tool(
		'get_run',
		'Get a run with its ordered events.',
		{ runId: z.string(), team: team },
		async (args: { runId: string; team?: string }): Promise<ToolResult> => {
			try {
				const orgId = await resolveOrgContext(ctx.userId, args.team);
				const run = await getRunForOrg(orgId, args.runId);
				return run ? ok(run) : fail('Run not found');
			} catch (e) {
				return mapOrgError(e) ?? fail('Failed to get run');
			}
		}
	);

	server.tool(
		'get_run_diff',
		'Get the git diff (base..head) of a run.',
		{ runId: z.string(), team: team },
		async (args: { runId: string; team?: string }): Promise<ToolResult> => {
			try {
				const orgId = await resolveOrgContext(ctx.userId, args.team);
				const diff = await getRunDiffForOrg(orgId, args.runId);
				return diff ? ok(diff) : fail('Run not found');
			} catch (e) {
				const mapped = mapOrgError(e);
				if (mapped) return mapped;
				if (e instanceof RunWorkspaceUnavailableError) return fail(e.message);
				return fail('Failed to compute diff');
			}
		}
	);

	server.tool(
		'stream_run_events',
		'Stream a run\'s events until it reaches a terminal state. Progress is sent as notifications; the full event list is also returned at the end.',
		{ runId: z.string(), team: team },
		async (args: { runId: string; team?: string }, extra: any): Promise<ToolResult> => {
			try {
				const orgId = await resolveOrgContext(ctx.userId, args.team);
				const run = await getRunForOrg(orgId, args.runId);
				if (!run) return fail('Run not found');

				const { streamRunEvents } = await import('$lib/server/run-stream');
				const progressToken = extra?._meta?.progressToken;
				const collected: { seq: number; payload: unknown }[] = [];
				let finalStatus = run.status;

				for await (const item of streamRunEvents(args.runId, { signal: extra?.signal })) {
					if (item.kind === 'event') {
						collected.push({ seq: item.seq, payload: item.payload });
						if (progressToken !== undefined && extra?.sendNotification) {
							await extra.sendNotification({
								method: 'notifications/progress',
								params: {
									progressToken,
									progress: item.seq,
									message: JSON.stringify(item.payload)
								}
							});
						}
					} else if (item.kind === 'done') {
						finalStatus = item.status;
					}
				}
				return ok({ status: finalStatus, events: collected });
			} catch (e) {
				return mapOrgError(e) ?? fail('Failed to stream run events');
			}
		}
	);
}
```

- [ ] **Step 4 : Lancer le test (succès attendu)**

Run : `bun run test:unit -- --run src/lib/server/mcp/tools.test.ts`
Expected : PASS (4 tests).

- [ ] **Step 5 : Commit**

```bash
git add src/lib/server/mcp/tools.ts src/lib/server/mcp/tools.test.ts
git commit -m "feat(mcp): read-only tool registry (projects, runs, diff, teams, stream)"
```

---

## Task 7 : Endpoint Streamable HTTP `/mcp`

**Files:**
- Create: `src/lib/server/mcp/server.ts`
- Create: `src/routes/mcp/+server.ts`

- [ ] **Step 1 : Implémenter le constructeur de handler**

`src/lib/server/mcp/server.ts` :

```ts
import { createMcpHandler } from 'mcp-handler';
import { registerTools } from '$lib/server/mcp/tools';

/**
 * Construit un handler fetch MCP (Streamable HTTP) scopé à un utilisateur.
 * Recréé par requête en fermant sur la session — coût négligeable en process
 * persistant (adapter-node) et évite tout AsyncLocalStorage.
 */
export function createDotweaverMcpHandler(userId: string): (req: Request) => Promise<Response> {
	return createMcpHandler(
		(server) => {
			registerTools(server, { userId });
		},
		{},
		{ basePath: '/mcp' }
	);
}
```

> Note d'exécution : vérifier la signature exacte de `createMcpHandler` dans `node_modules/mcp-handler` (ordre `(setup, serverOptions, config)`, clé `basePath`). Ajuster si l'API installée diffère ; l'intégration de Task 8 le confirme.

- [ ] **Step 2 : Implémenter la route protégée**

`src/routes/mcp/+server.ts` :

```ts
import type { RequestHandler } from './$types';
import { withMcpAuth } from 'better-auth/plugins';
import { auth } from '$lib/server/auth';
import { createDotweaverMcpHandler } from '$lib/server/mcp/server';

/** withMcpAuth valide le Bearer (401 + WWW-Authenticate si invalide) et fournit la session. */
const protectedHandler = withMcpAuth(auth, (req, session) => {
	const handler = createDotweaverMcpHandler(session.userId);
	return handler(req);
});

export const POST: RequestHandler = ({ request }) => protectedHandler(request);
export const GET: RequestHandler = ({ request }) => protectedHandler(request);
export const DELETE: RequestHandler = ({ request }) => protectedHandler(request);
```

> Note d'exécution : confirmer le nom du champ user sur la session retournée par `withMcpAuth` (`session.userId` d'après `OAuthAccessToken`). Ajuster si nécessaire.

- [ ] **Step 3 : Vérifier le typecheck + build**

Run : `bun run check`
Expected : 0 erreur de type. Les `$types` de la nouvelle route sont générés par `svelte-kit sync` (lancé par `check`).

- [ ] **Step 4 : Commit**

```bash
git add src/lib/server/mcp/server.ts src/routes/mcp/+server.ts
git commit -m "feat(mcp): /mcp Streamable HTTP endpoint guarded by withMcpAuth"
```

---

## Task 8 : Routes de discovery OAuth (.well-known)

**Files:**
- Create: `src/routes/.well-known/oauth-protected-resource/+server.ts`
- Create: `src/routes/.well-known/oauth-authorization-server/+server.ts`

- [ ] **Step 1 : Vérifier la signature des helpers**

Lire `node_modules/better-auth/dist/plugins/mcp/index.d.mts` pour confirmer comment invoquer `oAuthProtectedResourceMetadata(auth)` et `oAuthDiscoveryMetadata(auth)` (renvoient-ils une `Response`, une `Promise<Response>`, ou un handler `(req) => Response` ?).

- [ ] **Step 2 : Implémenter la route protected-resource (RFC 9728)**

`src/routes/.well-known/oauth-protected-resource/+server.ts` :

```ts
import type { RequestHandler } from './$types';
import { oAuthProtectedResourceMetadata } from 'better-auth/plugins';
import { auth } from '$lib/server/auth';

export const GET: RequestHandler = () => oAuthProtectedResourceMetadata(auth);
```

> Si le helper renvoie un handler plutôt qu'une Response, adapter : `({ request }) => oAuthProtectedResourceMetadata(auth)(request)`. (Étape 1 tranche.)

- [ ] **Step 3 : Implémenter la route authorization-server**

`src/routes/.well-known/oauth-authorization-server/+server.ts` :

```ts
import type { RequestHandler } from './$types';
import { oAuthDiscoveryMetadata } from 'better-auth/plugins';
import { auth } from '$lib/server/auth';

export const GET: RequestHandler = () => oAuthDiscoveryMetadata(auth);
```

- [ ] **Step 4 : Vérifier manuellement la discovery (dev server)**

```bash
bun run dev
```
Dans un autre terminal :
```bash
curl -s http://localhost:5173/.well-known/oauth-protected-resource | head -c 400
curl -s http://localhost:5173/.well-known/oauth-authorization-server | head -c 400
```
Expected : JSON de métadonnées OAuth (resource, authorization_servers / issuer, endpoints). Arrêter le dev server.

- [ ] **Step 5 : Commit**

```bash
git add "src/routes/.well-known"
git commit -m "feat(mcp): OAuth discovery well-known routes"
```

---

## Task 9 : Test d'intégration de bout en bout

**Files:**
- Create: `src/lib/server/mcp/mcp.integration.test.ts`

- [ ] **Step 1 : Écrire le test d'intégration**

On teste le câblage transport+auth sans client réel : (a) 401 sans token ; (b) handshake `initialize` → `tools/list` → `tools/call list_projects` avec session mockée. On mocke `withMcpAuth` pour injecter une session, et les services pour des données déterministes.

`src/lib/server/mcp/mcp.integration.test.ts` :

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Auth : withMcpAuth renvoie un handler ; on simule "pas de token → 401",
// "token de test → session {userId:'u1'}".
vi.mock('better-auth/plugins', () => ({
	withMcpAuth: (_auth: any, fn: any) => (req: Request) => {
		const authz = req.headers.get('authorization');
		if (!authz) {
			return new Response(JSON.stringify({ error: 'unauthorized' }), {
				status: 401,
				headers: { 'WWW-Authenticate': 'Bearer' }
			});
		}
		return fn(req, { userId: 'u1' });
	}
}));
vi.mock('$lib/server/auth', () => ({ auth: {} }));
vi.mock('$lib/server/teams-service', () => ({
	listTeamsForUser: vi.fn().mockResolvedValue([{ id: 'org1', slug: 'acme', name: 'Acme', role: 'owner' }])
}));
vi.mock('$lib/server/projects-service', () => ({
	listProjectsForOrg: vi.fn().mockResolvedValue([{ id: 'p1', name: 'demo' }]),
	getProjectForOrg: vi.fn()
}));
vi.mock('$lib/server/runs-service', () => ({
	listRunsForOrg: vi.fn(), getRunForOrg: vi.fn(), getRunDiffForOrg: vi.fn(),
	RunWorkspaceUnavailableError: class extends Error {}
}));

import { POST } from '../../../routes/mcp/+server';

const rpc = (body: unknown, withAuth = true) =>
	new Request('http://localhost/mcp', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			...(withAuth ? { authorization: 'Bearer test' } : {})
		},
		body: JSON.stringify(body)
	});

// mcp-handler répond en SSE ou JSON ; ce helper extrait le 1er objet JSON-RPC.
async function readRpc(res: Response): Promise<any> {
	const text = await res.text();
	const ct = res.headers.get('content-type') ?? '';
	if (ct.includes('text/event-stream')) {
		const line = text.split('\n').find((l) => l.startsWith('data:'));
		return line ? JSON.parse(line.slice(5).trim()) : null;
	}
	return JSON.parse(text);
}

describe('MCP endpoint (integration)', () => {
	beforeEach(() => vi.clearAllMocks());

	it('401 sans token', async () => {
		const res = await POST({ request: rpc({}, false) } as any);
		expect(res.status).toBe(401);
		expect(res.headers.get('WWW-Authenticate')).toBeTruthy();
	});

	it('initialize → tools/list → tools/call list_projects', async () => {
		const init = await POST({ request: rpc({
			jsonrpc: '2.0', id: 1, method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }
		}) } as any);
		expect(init.status).toBe(200);

		const list = await readRpc(await POST({ request: rpc({
			jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}
		}) } as any));
		const names = list.result.tools.map((t: any) => t.name).sort();
		expect(names).toContain('list_projects');
		expect(names).toContain('stream_run_events');

		const call = await readRpc(await POST({ request: rpc({
			jsonrpc: '2.0', id: 3, method: 'tools/call',
			params: { name: 'list_projects', arguments: { team: 'acme' } }
		}) } as any));
		const payload = JSON.parse(call.result.content[0].text);
		expect(payload).toEqual([{ id: 'p1', name: 'demo' }]);
	});
});
```

- [ ] **Step 2 : Lancer le test**

Run : `bun run test:unit -- --run src/lib/server/mcp/mcp.integration.test.ts`
Expected : PASS. Si mcp-handler exige un état de session entre `initialize` et les appels suivants (header `mcp-session-id`), ajuster le helper pour propager ce header de la réponse `initialize` vers les requêtes suivantes, ou configurer le handler en mode stateless. Itérer jusqu'au vert.

- [ ] **Step 3 : Lancer toute la suite unitaire**

Run : `bun run test:unit -- --run`
Expected : PASS (aucune régression sur les remote functions / SSE).

- [ ] **Step 4 : Commit**

```bash
git add src/lib/server/mcp/mcp.integration.test.ts
git commit -m "test(mcp): integration test for transport + auth wiring"
```

---

## Task 10 : Vérification manuelle + documentation

**Files:**
- Create: `docs/mcp.md`

- [ ] **Step 1 : Vérifier avec MCP Inspector (flow OAuth réel)**

```bash
bun run dev
bunx @modelcontextprotocol/inspector
```
Dans l'Inspector : transport « Streamable HTTP », URL `http://localhost:5173/mcp`. Lancer la connexion → flow OAuth (redirection `/login` → consent) → vérifier `tools/list` (7 outils) puis appeler `list_teams` et `list_projects`.
Expected : connexion authentifiée, outils listés, résultats scopés à l'org de l'utilisateur de test.

- [ ] **Step 2 : Vérifier le streaming**

Avec un run terminé existant, appeler `stream_run_events { runId }` dans l'Inspector.
Expected : résultat final `{ status, events: [...] }` ; notifications de progression visibles si l'Inspector les affiche.

- [ ] **Step 3 : Documenter l'usage**

`docs/mcp.md` : URL de l'endpoint, transport (Streamable HTTP), auth (OAuth via better-auth, page `/login`), liste des 7 outils + paramètres, note sur `team` (optionnel, défaut si une seule org), limite connue sur le streaming live, et exemple de config client (`mcp-remote` / Claude Desktop pointant vers `<BETTER_AUTH_URL>/mcp`).

- [ ] **Step 4 : Commit**

```bash
git add docs/mcp.md
git commit -m "docs(mcp): remote MCP server usage and tools reference"
```

---

## Self-review (couverture de la spec)

- ✅ Architecture & fichiers → Tasks 2–8 (structure respectée).
- ✅ OAuth better-auth + `/login` + discovery → Tasks 1, 8 ; vérif réelle Task 10.
- ✅ Scoping multi-tenant (`team` optionnel + défaut + `list_teams`) → Task 4 (`context.ts`) + Task 6.
- ✅ 7 outils read-only → Task 6.
- ✅ Services partagés (remote functions ET MCP) → Tasks 2, 3, 4.
- ✅ Streaming via generator partagé + fallback (events renvoyés en fin d'appel) → Tasks 5, 6.
- ✅ Gestion d'erreurs fail-closed, pas de fuite cross-tenant (« not found » identique) → Tasks 3, 4, 6.
- ✅ Tests TDD co-localisés + intégration → Tasks 2–9.
- ✅ Hors périmètre (mutations, teams au-delà de list, SSE legacy, Redis) → non implémenté, conforme.

**Incertitudes externes signalées (à confirmer en exécution, notes inline) :** signature exacte de `createMcpHandler`, champ user de la session `withMcpAuth`, forme de retour des helpers `oAuth*Metadata`, gestion de `mcp-session-id` par mcp-handler. Toutes sont tranchées par une étape de vérification ou le test d'intégration.
