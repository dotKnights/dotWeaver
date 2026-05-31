# DOT-16 Phase 1 — Import & modèle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre à un membre d'une équipe d'importer un repo GitHub (scopé à l'organisation active) et de le voir listé, en posant tout le schéma de données de DOT-16.

**Architecture:** On ajoute les modèles Prisma `Project`, `Run`, `RunEvent`, `PullRequest` (+ enums) en une migration. L'import lit les repos de l'utilisateur via l'API GitHub (token better-auth, scope `repo`), puis upsert un `Project` scopé à l'`activeOrganizationId`. Lecture/écriture via remote functions (`src/lib/rfc/projects.remote.ts`) suivant le pattern teams existant. UI en composants shadcn.

**Tech Stack:** SvelteKit 5 (remote functions), Prisma 7 + PostgreSQL, better-auth (`organization` plugin + GitHub social), zod 4, sveltekit-superforms, vitest.

**Prérequis (déjà dans `main`):** plugin `organization` better-auth, `Session.activeOrganizationId`, remote functions activées (`svelte.config.js`). Cette branche est rebasée sur `ec78da8`.

**Périmètre Phase 1 :** import + listing de projets uniquement. Les `Run`/`RunEvent`/`PullRequest` sont **créés en base** (migration) mais ne sont ni écrits ni lus ici — ils arrivent en Phase 2+. On les pose maintenant pour une seule migration de schéma cohérente.

---

### Task 1: Schéma Prisma — modèles & enums

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Ajouter la relation inverse sur `User` et les enums + modèles**

Dans `prisma/schema.prisma`, ajouter `projects` et `runs` à `User` (relations inverses) :

```prisma
model User {
  id            String    @id
  name          String
  email         String    @unique
  emailVerified Boolean
  image         String?
  createdAt     DateTime
  updatedAt     DateTime
  sessions      Session[]
  accounts      Account[]
  members       Member[]
  invitations   Invitation[]
  projects      Project[]
  runs          Run[]

  @@map("user")
}
```

Puis ajouter à la fin du fichier les enums et modèles applicatifs (on contrôle ces tables → `cuid()` + timestamps gérés par Prisma) :

```prisma
enum RunStatus {
  queued
  preparing
  running
  awaiting_review
  pushing
  completed
  failed
  canceled
  timed_out
}

enum RunEventType {
  system
  assistant
  tool_use
  tool_result
  result
  error
}

model Project {
  id             String   @id @default(cuid())
  organizationId String
  githubRepoId   String
  owner          String
  name           String
  defaultBranch  String
  cloneUrl       String
  private        Boolean  @default(false)
  importedById   String
  importedBy     User     @relation(fields: [importedById], references: [id], onDelete: Cascade)
  lastClonedAt   DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  runs           Run[]

  @@unique([organizationId, githubRepoId])
  @@index([organizationId])
  @@map("project")
}

model Run {
  id             String       @id @default(cuid())
  projectId      String
  project        Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  organizationId String
  createdById    String
  createdBy      User         @relation(fields: [createdById], references: [id], onDelete: Cascade)
  status         RunStatus    @default(queued)
  prompt         String
  agentBranch    String
  sessionId      String?
  parentRunId    String?
  parentRun      Run?         @relation("RunFork", fields: [parentRunId], references: [id])
  forks          Run[]        @relation("RunFork")
  baseCommitSha  String?
  headCommitSha  String?
  model          String?
  error          String?
  exitReason     String?
  containerId    String?
  timeoutAt      DateTime?
  queuedAt       DateTime     @default(now())
  startedAt      DateTime?
  finishedAt     DateTime?
  events         RunEvent[]
  pullRequest    PullRequest?

  @@index([organizationId, status])
  @@index([projectId, status])
  @@map("run")
}

model RunEvent {
  id        String       @id @default(cuid())
  runId     String
  run       Run          @relation(fields: [runId], references: [id], onDelete: Cascade)
  seq       Int
  type      RunEventType
  payload   Json
  createdAt DateTime     @default(now())

  @@unique([runId, seq])
  @@map("run_event")
}

model PullRequest {
  id        String   @id @default(cuid())
  runId     String   @unique
  run       Run      @relation(fields: [runId], references: [id], onDelete: Cascade)
  number    Int
  url       String
  state     String
  createdAt DateTime @default(now())

  @@map("pull_request")
}
```

- [ ] **Step 2: Générer la migration**

Run: `bunx prisma migrate dev --name add_projects_runs`
Expected: une nouvelle migration sous `prisma/migrations/`, tables `project`, `run`, `run_event`, `pull_request` créées, enums `RunStatus`/`RunEventType` créés. Sortie « Your database is now in sync ».

- [ ] **Step 3: Régénérer le client Prisma**

Run: `bunx prisma generate`
Expected: « Generated Prisma Client ». (Mémo projet : toujours régénérer après un changement de schéma.)

- [ ] **Step 4: Vérifier la compilation des types**

Run: `bun run check`
Expected: 0 erreur (le client Prisma expose désormais `prisma.project`, `prisma.run`, etc.).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): add Project/Run/RunEvent/PullRequest models (DOT-16)"
```

---

### Task 2: Scope GitHub `repo` sur le provider

**Files:**
- Modify: `src/lib/server/auth.ts`

- [ ] **Step 1: Ajouter le scope `repo` au provider GitHub**

Dans `src/lib/server/auth.ts`, remplacer le bloc `github` par :

```ts
github: {
  clientId: env.GITHUB_CLIENT_ID!,
  clientSecret: env.GITHUB_CLIENT_SECRET!,
  scope: ['repo']
},
```

- [ ] **Step 2: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 3: Commit**

```bash
git add src/lib/server/auth.ts
git commit -m "feat(auth): request GitHub repo scope for clone/push (DOT-16)"
```

> Note d'exécution : les comptes GitHub déjà liés devront se re-connecter pour que le nouveau scope `repo` soit accordé (re-consent OAuth). Rien à coder.

---

### Task 3: Client GitHub — mapping pur (TDD)

**Files:**
- Create: `src/lib/server/github.ts`
- Test: `src/lib/server/github.test.ts`

On isole la **logique pure** (mapping d'une réponse GitHub vers nos formes) du fetch réseau, pour la tester. Le fetch lui-même est testé manuellement / e2e.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// src/lib/server/github.test.ts
import { describe, it, expect } from 'vitest';
import { mapRepoListItem, mapRepoToProjectInput, type GithubRepo } from './github';

const repo: GithubRepo = {
  id: 12345,
  name: 'my-repo',
  full_name: 'octocat/my-repo',
  private: true,
  default_branch: 'main',
  clone_url: 'https://github.com/octocat/my-repo.git',
  owner: { login: 'octocat' }
};

describe('mapRepoListItem', () => {
  it('projects a GitHub repo into a list item', () => {
    expect(mapRepoListItem(repo)).toEqual({
      githubRepoId: '12345',
      owner: 'octocat',
      name: 'my-repo',
      fullName: 'octocat/my-repo',
      private: true,
      defaultBranch: 'main'
    });
  });
});

describe('mapRepoToProjectInput', () => {
  it('builds a Prisma create input scoped to org + importer', () => {
    expect(mapRepoToProjectInput(repo, 'org_1', 'user_1')).toEqual({
      organizationId: 'org_1',
      githubRepoId: '12345',
      owner: 'octocat',
      name: 'my-repo',
      defaultBranch: 'main',
      cloneUrl: 'https://github.com/octocat/my-repo.git',
      private: true,
      importedById: 'user_1'
    });
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/server/github.test.ts`
Expected: FAIL — `mapRepoListItem`/`mapRepoToProjectInput` introuvables.

- [ ] **Step 3: Implémenter le client**

```ts
// src/lib/server/github.ts
import { auth } from '$lib/server/auth';

export interface GithubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
  owner: { login: string };
}

export interface RepoListItem {
  githubRepoId: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export function mapRepoListItem(repo: GithubRepo): RepoListItem {
  return {
    githubRepoId: String(repo.id),
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch
  };
}

export function mapRepoToProjectInput(repo: GithubRepo, organizationId: string, importedById: string) {
  return {
    organizationId,
    githubRepoId: String(repo.id),
    owner: repo.owner.login,
    name: repo.name,
    defaultBranch: repo.default_branch,
    cloneUrl: repo.clone_url,
    private: repo.private,
    importedById
  };
}

/** Récupère un access token GitHub frais via better-auth (jamais persisté ailleurs). */
export async function getGithubToken(headers: Headers): Promise<string> {
  const res = await auth.api.getAccessToken({ body: { providerId: 'github' }, headers });
  if (!res?.accessToken) throw new Error('No GitHub access token');
  return res.accessToken;
}

async function githubFetch(token: string, path: string): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
}

/** Liste les repos accessibles à l'utilisateur (page par page, 100/page). */
export async function listUserRepos(token: string, page = 1): Promise<RepoListItem[]> {
  const res = await githubFetch(
    token,
    `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`
  );
  if (!res.ok) throw new Error(`GitHub list repos failed: ${res.status}`);
  const repos = (await res.json()) as GithubRepo[];
  return repos.map(mapRepoListItem);
}

/** Détail d'un repo précis (source de vérité côté serveur lors de l'import). */
export async function getRepo(token: string, owner: string, name: string): Promise<GithubRepo> {
  const res = await githubFetch(token, `/repos/${owner}/${name}`);
  if (!res.ok) throw new Error(`GitHub get repo failed: ${res.status}`);
  return (await res.json()) as GithubRepo;
}
```

- [ ] **Step 4: Lancer le test pour vérifier le succès**

Run: `bun run test:unit -- --run src/lib/server/github.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/github.ts src/lib/server/github.test.ts
git commit -m "feat(github): repo listing client + pure mappers (DOT-16)"
```

---

### Task 4: Helper d'organisation active (TDD)

**Files:**
- Create: `src/lib/server/org.ts`
- Test: `src/lib/server/org.test.ts`

Logique pure `resolveActiveOrgId(session)` (testable) + wrapper `requireActiveOrg()` (utilise `getRequestEvent`, comme `requireHeaders`).

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// src/lib/server/org.test.ts
import { describe, it, expect } from 'vitest';
import { resolveActiveOrgId } from './org';

describe('resolveActiveOrgId', () => {
  it('returns the active org id when present', () => {
    expect(resolveActiveOrgId({ activeOrganizationId: 'org_1' })).toBe('org_1');
  });

  it('throws when no active org is selected', () => {
    expect(() => resolveActiveOrgId({ activeOrganizationId: null })).toThrow('No active team');
  });

  it('throws when session is null', () => {
    expect(() => resolveActiveOrgId(null)).toThrow('No active team');
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/server/org.test.ts`
Expected: FAIL — `resolveActiveOrgId` introuvable.

- [ ] **Step 3: Implémenter le helper**

```ts
// src/lib/server/org.ts
import { error } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { auth } from '$lib/server/auth';

type SessionLike = { activeOrganizationId?: string | null } | null;

export function resolveActiveOrgId(session: SessionLike): string {
  const id = session?.activeOrganizationId;
  if (!id) throw new Error('No active team');
  return id;
}

/** Renvoie l'id de l'organisation active, ou 400 si aucune n'est sélectionnée. */
export async function requireActiveOrg(headers: Headers): Promise<string> {
  const { locals } = getRequestEvent();
  if (!locals.session) error(401, 'Not authenticated');
  const session = await auth.api.getSession({ headers });
  try {
    return resolveActiveOrgId(session?.session ?? null);
  } catch {
    error(400, 'No active team selected');
  }
}
```

- [ ] **Step 4: Lancer le test pour vérifier le succès**

Run: `bun run test:unit -- --run src/lib/server/org.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/org.ts src/lib/server/org.test.ts
git commit -m "feat(org): active organization resolver (DOT-16)"
```

---

### Task 5: Schéma zod d'import (TDD)

**Files:**
- Create: `src/lib/schemas/projects.ts`
- Test: `src/lib/schemas/projects.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// src/lib/schemas/projects.test.ts
import { describe, it, expect } from 'vitest';
import { importProjectSchema } from './projects';

describe('importProjectSchema', () => {
  it('accepts a valid owner/name pair', () => {
    expect(importProjectSchema.safeParse({ owner: 'octocat', name: 'my-repo' }).success).toBe(true);
  });

  it('rejects empty owner', () => {
    expect(importProjectSchema.safeParse({ owner: '', name: 'my-repo' }).success).toBe(false);
  });

  it('rejects missing name', () => {
    expect(importProjectSchema.safeParse({ owner: 'octocat' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `bun run test:unit -- --run src/lib/schemas/projects.test.ts`
Expected: FAIL — module `./projects` introuvable.

- [ ] **Step 3: Implémenter le schéma**

```ts
// src/lib/schemas/projects.ts
import { z } from 'zod';

export const importProjectSchema = z.object({
  owner: z.string().min(1, 'Owner is required'),
  name: z.string().min(1, 'Repository name is required')
});

export type ImportProjectSchema = typeof importProjectSchema;
```

- [ ] **Step 4: Lancer le test pour vérifier le succès**

Run: `bun run test:unit -- --run src/lib/schemas/projects.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/schemas/projects.ts src/lib/schemas/projects.test.ts
git commit -m "feat(projects): import schema (DOT-16)"
```

---

### Task 6: Remote functions projets

**Files:**
- Create: `src/lib/rfc/projects.remote.ts`

Suit exactement le pattern de `src/lib/rfc/teams.remote.ts` : `requireHeaders()`, `auth`, `prisma`, `query`/`command`, `.refresh()` après mutation.

- [ ] **Step 1: Implémenter les remote functions**

```ts
// src/lib/rfc/projects.remote.ts
import { query, command, getRequestEvent } from '$app/server';
import { z } from 'zod';
import { error } from '@sveltejs/kit';
import { requireHeaders } from '$lib/server/utils';
import { requireActiveOrg } from '$lib/server/org';
import { prisma } from '$lib/server/prisma';
import { importProjectSchema } from '$lib/schemas/projects';
import { getGithubToken, listUserRepos, getRepo, mapRepoToProjectInput } from '$lib/server/github';

/** Repos GitHub de l'utilisateur (pour l'écran d'import). */
export const listGithubRepos = query(async () => {
  const headers = requireHeaders();
  const token = await getGithubToken(headers);
  return await listUserRepos(token);
});

/** Projets importés dans l'organisation active. */
export const listProjects = query(async () => {
  const headers = requireHeaders();
  const organizationId = await requireActiveOrg(headers);
  return await prisma.project.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' }
  });
});

export const getProject = query(z.string(), async (id) => {
  const headers = requireHeaders();
  const organizationId = await requireActiveOrg(headers);
  const project = await prisma.project.findFirst({ where: { id, organizationId } });
  if (!project) error(404, 'Project not found');
  return project;
});

/** Importe un repo : on re-fetch le détail côté serveur (source de vérité) puis upsert. */
export const importProject = command(importProjectSchema, async ({ owner, name }) => {
  const headers = requireHeaders();
  const organizationId = await requireActiveOrg(headers);
  const { locals } = getRequestEvent();
  const token = await getGithubToken(headers);
  const repo = await getRepo(token, owner, name);
  const data = mapRepoToProjectInput(repo, organizationId, locals.user!.id);
  const project = await prisma.project.upsert({
    where: { organizationId_githubRepoId: { organizationId, githubRepoId: data.githubRepoId } },
    create: data,
    update: { defaultBranch: data.defaultBranch, cloneUrl: data.cloneUrl, private: data.private }
  });
  await listProjects().refresh();
  return { id: project.id };
});
```

- [ ] **Step 2: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 3: Commit**

```bash
git add src/lib/rfc/projects.remote.ts
git commit -m "feat(projects): import + listing remote functions (DOT-16)"
```

---

### Task 7: UI — liste des projets & import

**Files:**
- Create: `src/routes/(app)/projects/+page.svelte`
- Modify: `src/routes/(app)/+layout.svelte` (lien de nav)

- [ ] **Step 1: Page liste + import**

On suit le pattern réactif du layout (`const q = query(); {#if q.current}`) plutôt que `{#await}` — c'est le style maison documenté dans `(app)/+layout.svelte` (évite la suspense SSR et reflète automatiquement `.refresh()`).

```svelte
<!-- src/routes/(app)/projects/+page.svelte -->
<script lang="ts">
  import { listProjects, listGithubRepos, importProject } from '$lib/rfc/projects.remote';
  import { Button } from '$lib/components/ui/button';
  import * as Card from '$lib/components/ui/card';

  const projects = listProjects();
  let repos = listGithubRepos();

  let showImport = $state(false);
  let importing = $state<string | null>(null);
  let importError = $state<string | null>(null);

  async function handleImport(owner: string, name: string) {
    importError = null;
    importing = `${owner}/${name}`;
    try {
      await importProject({ owner, name });
      showImport = false;
    } catch (e) {
      importError = e instanceof Error ? e.message : 'Import failed';
    } finally {
      importing = null;
    }
  }
</script>

<div class="mx-auto max-w-3xl space-y-6 p-6">
  <div class="flex items-center justify-between">
    <h1 class="text-2xl font-semibold">Projects</h1>
    <Button onclick={() => (showImport = !showImport)}>
      {showImport ? 'Close' : 'Import repository'}
    </Button>
  </div>

  {#if showImport}
    <Card.Root>
      <Card.Header>
        <Card.Title>Import a GitHub repository</Card.Title>
        <Card.Description>Pick one of the repositories you have access to.</Card.Description>
      </Card.Header>
      <Card.Content class="space-y-2">
        {#if importError}
          <p class="text-sm text-red-500">{importError}</p>
        {/if}
        {#if repos.error}
          <p class="text-sm text-red-500">Could not load repositories: {repos.error.message}</p>
        {:else if repos.current}
          <ul class="divide-y">
            {#each repos.current as repo (repo.githubRepoId)}
              <li class="flex items-center justify-between py-2">
                <span class="text-sm">
                  {repo.fullName}
                  {#if repo.private}<span class="ml-2 text-xs text-muted-foreground">private</span>{/if}
                </span>
                <Button
                  variant="outline"
                  disabled={importing === repo.fullName}
                  onclick={() => handleImport(repo.owner, repo.name)}
                >
                  {importing === repo.fullName ? 'Importing…' : 'Import'}
                </Button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-sm text-muted-foreground">Loading repositories…</p>
        {/if}
      </Card.Content>
    </Card.Root>
  {/if}

  {#if projects.current}
    {#if projects.current.length === 0}
      <p class="text-sm text-muted-foreground">No projects yet. Import a repository to get started.</p>
    {:else}
      <ul class="space-y-2">
        {#each projects.current as project (project.id)}
          <li>
            <a href={`/projects/${project.id}`} class="block rounded-md border p-4 hover:bg-accent">
              <span class="font-medium">{project.owner}/{project.name}</span>
              <span class="ml-2 text-xs text-muted-foreground">{project.defaultBranch}</span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  {:else}
    <p class="text-sm text-muted-foreground">Loading projects…</p>
  {/if}
</div>
```

- [ ] **Step 2: Vérifier le composant avec l'autofixer Svelte**

Utiliser le MCP Svelte `svelte-autofixer` sur le contenu de `+page.svelte` et appliquer les corrections jusqu'à 0 issue (exigence projet : AGENTS.md). En particulier, confirmer que l'accès `.error`/`.current` sur une remote query est l'API correcte ; sinon adapter selon ce que renvoie l'autofixer.

- [ ] **Step 3: Ajouter le lien de navigation**

Dans `src/routes/(app)/+layout.svelte`, transformer le logo seul en un petit groupe de nav. Remplacer la ligne 18 :

```svelte
	<a href="/dashboard" class="text-lg font-semibold">dotWeaver</a>
```
par :
```svelte
	<div class="flex items-center gap-4">
		<a href="/dashboard" class="text-lg font-semibold">dotWeaver</a>
		<a href="/projects" class="text-sm font-medium hover:underline">Projects</a>
	</div>
```

- [ ] **Step 4: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 5: Commit**

```bash
git add src/routes/(app)/projects/+page.svelte 'src/routes/(app)/+layout.svelte'
git commit -m "feat(projects): projects list + import UI (DOT-16)"
```

---

### Task 8: Page détail projet (minimale)

**Files:**
- Create: `src/routes/(app)/projects/[id]/+page.svelte`

Phase 1 = placeholder qui affiche le projet ; le bouton « Run » arrivera en Phase 2.

- [ ] **Step 1: Page détail**

```svelte
<!-- src/routes/(app)/projects/[id]/+page.svelte -->
<script lang="ts">
  import { page } from '$app/state';
  import { getProject } from '$lib/rfc/projects.remote';

  const project = getProject(page.params.id);
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
    <p class="text-sm text-muted-foreground">Running agents on this project comes in the next phase.</p>
  {:else}
    <p class="text-sm text-muted-foreground">Loading project…</p>
  {/if}
</div>
```

- [ ] **Step 2: Autofixer Svelte**

Lancer le MCP Svelte `svelte-autofixer` sur le composant jusqu'à 0 issue.

- [ ] **Step 3: Vérifier la compilation**

Run: `bun run check`
Expected: 0 erreur.

- [ ] **Step 4: Commit**

```bash
git add 'src/routes/(app)/projects/[id]/+page.svelte'
git commit -m "feat(projects): project detail page (DOT-16)"
```

---

### Task 9: Vérification finale & lint

- [ ] **Step 1: Suite de tests unitaires complète**

Run: `bun run test:unit -- --run`
Expected: tous les tests passent (github, org, projects + existants teams/slug).

- [ ] **Step 2: Lint & format**

Run: `bun run lint`
Expected: 0 erreur. Si besoin : `bun run format` puis re-lint.

- [ ] **Step 3: Commit si format a modifié des fichiers**

```bash
git add -A
git commit -m "chore: format (DOT-16 phase 1)"
```

---

## Vérification manuelle (smoke test)

1. `bun run dev`, se connecter via GitHub (re-consent pour le scope `repo`).
2. Créer/sélectionner une équipe active (feature teams).
3. Aller sur `/projects` → « Import repository » → la liste des repos GitHub s'affiche.
4. Importer un repo → il apparaît dans la liste des projets.
5. Cliquer le projet → page détail. Ré-importer le même repo → pas de doublon (upsert).

## Couverture du périmètre Phase 1

- ✅ Modèles `Project`/`Run`/`RunEvent`/`PullRequest` + enums (Task 1)
- ✅ Scope `repo` GitHub (Task 2)
- ✅ Listing repos GitHub via token better-auth (Task 3)
- ✅ Org scoping (Task 4)
- ✅ Import (upsert idempotent, source de vérité serveur) + listing (Tasks 5–6)
- ✅ UI liste + import + détail (Tasks 7–8)
- ⏭️ Runs (création/exécution) : Phase 2.
