# Design : Lancer un agent Claude sur un repo GitHub importé

**Date** : 2026-06-01
**Issue** : DOT-16
**Statut** : Approuvé (en attente de relecture finale)

## Objectif

Construire une web app où un membre d'une équipe peut **importer un repo GitHub**, puis
**lancer un agent Claude** dessus. L'agent accède au code, charge les **skills** et **serveurs
MCP** du repo, **édite / commit** sur une branche isolée, et sa sortie est **streamée en direct**
dans l'UI. Après revue du diff par l'utilisateur, le **push et l'ouverture de PR** se font depuis
l'hôte. Le tout dans la stack existante : SvelteKit 5 (runes + remote functions), better-auth
(GitHub social, scope `repo`), Prisma + PostgreSQL, zod + superforms, shadcn-svelte.

## Décisions cadrées

| Sujet             | Décision                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mécanisme d'agent | **Claude Agent SDK (TypeScript)** exécuté **dans** le conteneur jetable, via `query()`.                                                                              |
| Auth Claude       | **Abonnement Claude Code** via `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` (jamais en DB).                                                                      |
| Isolation         | Conteneur Docker **jetable par run**, auto-hébergé. `--cap-drop ALL`, no-new-privileges, seccomp, rootfs read-only, limites CPU/RAM/PID, workspace bind-monté en RW. |
| Réseau conteneur  | **Egress allowlisté à l'API Anthropic uniquement** (proxy/iptables) — _pas_ `--network none`. Aucun accès internet pour les deps tierces du repo.                    |
| Queue de jobs     | **pg-boss** (Postgres). Pas de Redis : profil = peu de jobs, longs ; enqueue transactionnel avec la table `Run`.                                                     |
| Runner            | **Process worker séparé** (hors cycle de requête HTTP).                                                                                                              |
| Workspace         | Clone **miroir** par projet (cache) + **git worktree** par run.                                                                                                      |
| Branche           | L'agent commit sur `claude/<runId>`, jamais sur la branche par défaut.                                                                                               |
| Push / PR         | **Depuis l'hôte**, après validation du diff par l'utilisateur. Le conteneur ne push pas.                                                                             |
| Streaming         | **SSE**, événements persistés en DB d'abord (`RunEvent`), bus worker→SSE via `LISTEN/NOTIFY`.                                                                        |
| Skills            | `settingSources: ['project']` (lit `.claude/` du repo + `CLAUDE.md`).                                                                                                |
| MCP               | Option `mcpServers`, **stdio** embarqué dans l'image. Aucun requis au premier jet (YAGNI).                                                                           |
| Reprise           | `session_id` stocké sur `Run` → `resume` ; `forkSession: true` + `parentRunId` → fork.                                                                               |

### Hôte d'exécution

Conçu pour un **hôte Linux auto-hébergé** (production), mais exécutable en dev sur Mac via
Docker Desktop. Les détails conteneur (cgroups, seccomp, `--pids-limit`) ciblent Linux.

## Tension résolue : `--network none` vs. agent dans le conteneur

L'issue demande à la fois `--network none` **et** que l'agent (qui a l'outil `Bash`) tourne dans
le conteneur. Or l'agent doit joindre `api.anthropic.com` pour parler au modèle — incompatible
avec `--network none`. **Résolution** : le conteneur est attaché à un bridge dédié dont l'**egress
est restreint à l'API Anthropic** (proxy hôte / iptables). La menace réelle — les dépendances
tierces du repo qui tenteraient un accès réseau arbitraire — reste neutralisée : aucune autre
destination n'est joignable. Le clone et le push Git se font **sur l'hôte**, donc le token GitHub
n'entre jamais dans le conteneur.

## Choix du mécanisme d'agent (Option A retenue)

- **A — Agent SDK dans le conteneur (retenu)** : un entrypoint Node appelle `query()` de
  `@anthropic-ai/claude-agent-sdk` avec `cwd` = workspace monté, `settingSources: ['project']`,
  `mcpServers` (stdio embarqués), gating d'outils, `resume`/`forkSession`. Auth via
  `CLAUDE_CODE_OAUTH_TOKEN`. Le SDK émet des `SDKMessage` (JSON-lines) sur stdout. _Pourquoi_ :
  streaming, resume/fork, `settingSources`, `mcpServers` natifs ; TypeScript = stack ; abonnement
  supporté via OAuth token.
- **B — CLI `claude -p --output-format stream-json` dans le conteneur** : plus simple mais moins
  de contrôle programmatique (gating dynamique, fork). **Fallback** si une option SDK bloque.
- **C — SDK sur l'hôte, sandbox des seuls outils** (_rejeté_) : le SDK ne sépare pas proprement
  sa boucle modèle de l'exécution d'outils à travers une frontière conteneur ; risque de fuite de
  code tiers sur l'hôte ; frontière de sécurité plus faible.

## Architecture

### 1. Modèle de données (Prisma)

S'appuie sur l'existant : `User`/`Account` (le token GitHub social à scope `repo` vit dans
`Account.accessToken`) et `Organization`/`Member` (spec équipes). Nouveaux modèles, **tous
scopés à une organisation** :

- **`Project`** — repo GitHub importé. `id`, `organizationId`, `githubRepoId`, `owner`, `name`,
  `defaultBranch`, `cloneUrl`, `private` (bool), `importedById`, `lastClonedAt?`, `createdAt`.
  `@@unique([organizationId, githubRepoId])`. Le chemin du cache workspace est **dérivé de `id`**,
  pas stocké. Relations : `runs Run[]`.
- **`Run`** — une exécution d'agent. `id`, `projectId`, `organizationId`, `createdById`,
  `status` (enum `queued | preparing | running | awaiting_review | pushing | completed | failed
| canceled | timed_out`), `prompt`, `agentBranch` (`claude/<shortId>`), `sessionId?`,
  `parentRunId?`, `baseCommitSha?`, `headCommitSha?`, `model?`, `error?`, `exitReason?`,
  `containerId?`, `timeoutAt`, `queuedAt`, `startedAt?`, `finishedAt?`.
  Index : `(organizationId, status)`, `(projectId, status)`.
- **`RunEvent`** — messages de stream persistés (source de vérité pour replay/reconnexion).
  `id`, `runId`, `seq` (entier monotone par run), `type` (`system | assistant | tool_use |
tool_result | result | error`), `payload` (Json), `createdAt`. `@@unique([runId, seq])`.
  La reconnexion SSE utilise `Last-Event-ID = seq`.
- **`PullRequest`** — résultat d'un run poussé. `id`, `runId` (`@unique`), `number`, `url`,
  `state`, `createdAt`. Nullable par run (on peut pousser une branche sans PR).

Migration : `prisma migrate dev` (datasource PostgreSQL via `prisma.config.ts`).

### 2. Gestion des secrets

- **Anthropic** : `CLAUDE_CODE_OAUTH_TOKEN` (abonnement, mint via `claude setup-token`) est un
  secret **app-level** depuis l'env/secret store de l'hôte — **jamais en DB** — injecté par run
  dans l'env du conteneur.
- **GitHub** : récupéré **frais par opération** via better-auth (`Account.accessToken`),
  **n'entre jamais dans le conteneur**. Pour clone/push sur l'hôte, passé via `http.extraHeader`
  / askpass **éphémère**, jamais écrit dans `.git/config` ni dans l'URL du remote → aucune fuite
  dans le repo.

### 3. Queue de jobs & runner

- **Queue = Postgres via pg-boss**. La création d'un `Run` (status `queued`) enqueue un job
  pg-boss portant `runId`, **dans la même transaction** (pas de désync queue/DB).
- **Worker** (`src/runner/`, process séparé, `bun run runner`) : claim un job et pilote une
  **machine à états** : `preparing` (workspace + branche) → `running` (conteneur + stream) →
  `awaiting_review` (commits prêts) → sur validation, `pushing` (hôte) → `completed`. Erreurs →
  `failed` / `timed_out` / `canceled`.
- **Concurrence** : sémaphore worker global + cap **par organisation** ; surplus reste `queued`.

### 4. Cycle de vie du conteneur

- Par run : `docker run --rm` avec `--cap-drop ALL`, `--security-opt no-new-privileges`, seccomp
  par défaut, rootfs read-only + `--tmpfs` scratch, limites CPU/RAM (`--memory`, `--cpus`),
  `--pids-limit`, réseau egress-allowlisté (Anthropic), bind-mount RW du worktree du run.
- L'image embarque Node + Claude CLI/SDK + serveurs MCP stdio éventuels.
- `containerId` stocké sur `Run` pour kill/cancel.
- **Annulation** : intent en DB + pg-boss ; le worker `docker kill` le conteneur → `canceled`.
- **Timeout** : `timeoutAt` → kill mural dur.
- **Crash recovery** : au démarrage du worker, tout `Run` en `running`/`preparing` sans conteneur
  vivant est requeué ou marqué `failed` (idempotent : branche + commits durables dans le
  workspace). L'expiration de lease pg-boss gère la re-livraison si le worker meurt en cours.

### 5. Cycle de vie des workspaces & concurrence

- **Cache par projet** sur l'hôte : `…/workspaces/<projectId>/repo.git` = **clone miroir**
  (`git clone --mirror`, bare). Import initial → clone complet ; runs suivants → `git fetch`.
  `lastClonedAt` sur `Project`. `fetch` protégé par un **lock court par projet**.
- **Checkout par run** : `git worktree add …/runs/<runId> <baseSha>` depuis le miroir, puis
  création de `claude/<runId>`. Ce worktree est bind-monté dans le conteneur. Pas de `.git`
  partagé en écriture → runs concurrents isolés ; checkout quasi-instantané.
- **Nettoyage** : à l'état terminal (succès / échec / push / abandon) → `git worktree remove
--force` + suppression branche locale. GC périodique des worktrees orphelins. Le miroir
  persiste comme cache.
- **Cas limites** : repo vide (pas de `defaultBranch` → commit vide initial sur `claude/<id>`) ;
  gros repo (clone miroir = job en file, status `preparing`, streamé) ; échec de clone
  (run `failed`, message clair) ; repo privé (le token `repo` couvre clone + push).

### 6. Streaming SSE & persistance

- **Source de vérité = `RunEvent`**. Le conteneur émet des `SDKMessage` JSON-lines sur stdout ;
  le worker les parse, **persiste** (`seq` monotone) **puis** publie. Rien n'est streamé sans
  être persisté d'abord → aucun message perdu au refresh/reconnexion.
- **Endpoint** : `GET /api/runs/[id]/events` en **SSE**. À la connexion, **replay** depuis
  `Last-Event-ID` (tous les `seq >` curseur), puis live.
- **Bus worker → SSE** : `LISTEN/NOTIFY` Postgres. Le worker `NOTIFY run:<id>` après chaque
  insert d'event ; l'endpoint `LISTEN` et relit les nouveaux `seq`. _Fallback_ : polling `seq`
  ~1 s si on diffère LISTEN/NOTIFY.
- **Backpressure** : pas de buffer infini. L'event étant persisté, on peut _drop_ le live et
  laisser le client rattraper via `Last-Event-ID`. Le conteneur n'est jamais bloqué par un client
  lent (découplage via la DB).
- **Fin de stream** : event terminal `result`/`error` ferme le SSE proprement ; le front bascule
  vers la vue diff.
- **Reconnexion** : EventSource se reconnecte seul ; replay par `seq` idempotent, sans trou.

### 7. Flux commit → diff → validation → push → PR

L'agent **commit dans le conteneur** sur `claude/<runId>` mais **ne push pas** (réseau Git coupé).

1. **`awaiting_review`** : le worker lit `headCommitSha`. Le diff (`baseCommitSha…headCommitSha`)
   est calculé **à la demande** côté hôte et rendu dans l'UI (fichiers, patch). Rien chez GitHub.
2. **Validation** : l'utilisateur relit. Actions : **Push & PR**, **Push branche seule**, ou
   **Abandonner** (cleanup worktree, aucune trace distante).
3. **Push depuis l'hôte** (`pushing`) : token GitHub frais (better-auth) ; `git push
--force-with-lease` de `claude/<runId>`, token via `http.extraHeader`/askpass éphémère
   (jamais dans `.git/config` ni l'URL).
4. **PR** : `POST /repos/{owner}/{name}/pulls` (base = `defaultBranch`, head = `claude/<runId>`).
   Stockage `PullRequest`.
5. **Cas limites** : `--force-with-lease` refusé (branche distante a bougé) → `failed`, message
   clair, pas de force aveugle ; collision `claude/<id>` distant → suffixe (improbable car id
   unique) ; PR déjà ouverte pour ce head → réutilisée/affichée ; token expiré/permission →
   message clair, pas de push partiel.

### 8. Skills, MCP, reprise de session, quotas

- **Skills** : `settingSources: ['project']` charge `.claude/` du repo + `CLAUDE.md`
  automatiquement (comportement SDK, rien à coder). Implication : ces instructions viennent du
  repo (périmètre deps tierces) → d'où la frontière conteneur.
- **MCP** : `mcpServers` en **stdio**, binaires embarqués (réseau coupé). **Aucun requis** au
  premier jet (YAGNI) ; un MCP distant n'est ouvert que via l'allowlist d'egress, au cas par cas.
- **Reprise** : `session_id` (message init) stocké sur `Run`. **Resume** : nouveau run avec
  `resume: sessionId`. **Fork** : `resume: sessionId` + `forkSession: true` + `parentRunId` ;
  le worktree repart du `headCommitSha` du parent.
- **Quotas** : à l'enqueue, refus si l'org/user dépasse **N runs concurrents** (sémaphore +
  check DB) ; cap mensuel optionnel via comptage `Run`. Par conteneur : CPU / RAM / PID / temps
  mural (`timeoutAt`), quota disque du worktree. Config en app settings, pas en schéma.

### 9. Routes / remote functions / UI

- **Remote functions** (`src/routes/(app)/projects/*.remote.ts`) suivant le pattern existant
  (`query`/`command`/`form`, `getRequestEvent()`, autorisation déléguée à better-auth + scope org) :
  - `listGithubRepos()` (via token), `importProject(repo)`, `listProjects()`, `getProject(id)`.
  - `startRun({ projectId, prompt })` → crée `Run` + enqueue. `cancelRun(id)`.
  - `getRun(id)`, `getRunDiff(id)`, `approveRun({ id, action })` (push & PR / push seul / abandon).
  - `resumeRun(id)`, `forkRun(id)`.
- **Endpoint SSE** : `GET /api/runs/[id]/events` (non remote — flux long).
- **UI** (shadcn existant) : liste de projets + import ; page projet ; page run avec stream live ;
  vue diff + actions de validation ; historique des runs ; resume/fork.

### 10. Gestion des erreurs

Messages exploitables pour : échec/permission de clone, repo vide, timeout, conteneur tué,
`--force-with-lease` refusé, token expiré, quota dépassé, PR déjà ouverte. Tout état terminal d'un
run porte `error`/`exitReason`. Les remote functions remontent les erreurs better-auth/GitHub en
messages côté form.

### 11. Tests

- **Unit (vitest)** : machine à états du run (transitions valides), parsing des `SDKMessage` →
  `RunEvent`, dérivation `seq`/replay, slug de branche, logique de quota, construction des args
  `docker run`.
- **Intégration** : workspace miroir + worktree (clone, fetch, worktree add/remove) sur repo local
  de test ; push `--force-with-lease` (refus simulé).
- **E2E (playwright)** _(optionnel)_ : importer un repo de test → lancer un run → voir le stream →
  valider le diff → push. Auth réutilise les gotchas E2E existants (port preview = `BETTER_AUTH_URL`).

## Découpage en phases (un plan d'implémentation par phase)

1. **Import & modèle** — schéma Prisma (`Project`, `Run`, `RunEvent`, `PullRequest`), remote
   functions d'import GitHub, UI liste de projets. _Démontrable : importer un repo._
2. **Runner & exécution** — worker pg-boss, image Docker (Node + Claude SDK), entrypoint
   `query()`, lifecycle conteneur, miroir + worktree, auth OAuth abonnement. _Démontrable : run →
   commits sur `claude/<id>`._
3. **Streaming** — `RunEvent` + `LISTEN/NOTIFY` + endpoint SSE + UI live. _Démontrable : sortie en
   direct._
4. **Diff → push → PR** — vue diff, validation, push hôte `--force-with-lease`, ouverture PR.
   _Démontrable : boucle complète._
5. **Robustesse** — annulation, timeout, crash recovery, quotas, resume/fork, cas limites.

## Hors périmètre (YAGNI)

- Serveurs MCP custom au premier jet (architecture prête, mais aucun requis).
- Auto-merge / review automatique de PR.
- Tokens OAuth Anthropic par-utilisateur (un secret abonnement partagé suffit au contexte équipe).
- Orchestration multi-hôte / autoscaling (un seul hôte Docker au départ).
- Édition collaborative temps réel d'un même run.
