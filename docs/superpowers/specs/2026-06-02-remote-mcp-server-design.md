# Serveur MCP distant (Streamable HTTP) — Design

**Date** : 2026-06-02
**Statut** : Validé en brainstorming, en attente de relecture
**Périmètre** : v1 read-only

## Objectif

Exposer les capacités de pilotage de dotWeaver à des clients MCP distants
(Claude.ai, Claude Desktop, MCP Inspector…) via un endpoint **Streamable HTTP**
authentifié en **OAuth 2.0**. La v1 est **read-only** : consultation des projets,
runs et diffs, plus streaming de la progression des runs. Les mutations
(`start_run`, `cancel_run`, `approve_run`) sont reportées en v2.

## Décisions de cadrage

| Sujet | Décision |
|---|---|
| But | Piloter dotWeaver (façade sur la couche métier existante) |
| Auth | Plugin `mcp()` de better-auth (OAuth 2.0 + PKCE + DCR) |
| Transport | Streamable HTTP (spec MCP 2025-03+), un seul endpoint `/mcp` |
| Périmètre v1 | Read-only : projets, runs, diffs, streaming |
| Implémentation | `mcp-handler` (adapter fetch-native basé sur le SDK officiel) |
| Scoping org | Paramètre `team` optionnel + défaut si une seule org |
| Page de consent | Réutilise `/login` existant |
| Couche métier | Extraction de **services partagés** (consommés par remote functions ET outils MCP) |

## Architecture

```
Client MCP distant (Claude.ai / Desktop / Inspector)
        │  Streamable HTTP (POST JSON-RPC, GET stream SSE)
        │  Authorization: Bearer <token OAuth>
        ▼
┌─────────────────────────────────────────────────────┐
│ SvelteKit (adapter-node, process persistant)         │
│                                                       │
│  hooks.server.ts → svelteKitHandler(auth)            │
│    └─ plugin mcp() : endpoints OAuth + discovery     │
│                                                       │
│  src/routes/.well-known/...        (métadonnées OAuth)│
│  src/routes/mcp/+server.ts         (POST + GET)       │
│    └─ withMcpAuth(auth, handler)   (valide le token)  │
│         └─ createMcpHandler(server => …)  (mcp-handler)│
│              └─ outils read-only                      │
│                   └─ src/lib/server/mcp/tools.ts      │
│                        └─ services partagés           │
│                           (prisma, org, run-stream…)  │
└─────────────────────────────────────────────────────┘
```

**Principe directeur** : les outils MCP ne réimplémentent aucune logique métier.
Ils sont une fine façade au-dessus de services partagés, qui restent la source de
vérité côté autorisation et accès données — à côté de l'UI et des remote functions.

### Nouveaux fichiers

- `src/lib/server/mcp/server.ts` — construit l'instance MCP (via mcp-handler),
  enregistre les outils. Pur, testable.
- `src/lib/server/mcp/tools.ts` — définitions des outils (nom, description,
  schéma Zod, handler). Chaque handler reçoit le contexte auth résolu.
- `src/lib/server/mcp/context.ts` — résout `{ userId, organizationId }` à partir
  de la session MCP + garde-fous multi-tenant (centralisés).
- `src/routes/mcp/+server.ts` — endpoint Streamable HTTP : `withMcpAuth` →
  `createMcpHandler`.
- `src/routes/.well-known/oauth-protected-resource/+server.ts`
  (+ éventuellement `oauth-authorization-server`) — métadonnées de discovery via
  les helpers better-auth (`oAuthProtectedResourceMetadata`, `oAuthDiscoveryMetadata`).
- Services partagés extraits depuis les remote functions (ex.
  `src/lib/server/runs-service.ts`, `projects-service.ts`).

### Modifications

- `src/lib/server/auth.ts` — ajouter le plugin `mcp({ loginPage: '/login', resource: <url /mcp> })`.
- `src/lib/server/run-stream.ts` — extraire un async generator partagé
  `streamRunEvents(runId, { fromSeq })`.
- `src/routes/api/runs/[id]/events/+server.ts` — consommer le generator partagé.
- `src/lib/rfc/*.remote.ts` — déléguer aux services partagés (read-only de la v1).

## Authentification & scoping multi-tenant

### Flow OAuth (géré par le plugin `mcp()`)

1. `POST /mcp` sans token → **401** + `WWW-Authenticate` pointant vers
   `/.well-known/oauth-protected-resource`.
2. Le client lit la discovery → découvre l'Authorization Server (better-auth) →
   lance un flow OAuth 2.0 + PKCE (Dynamic Client Registration supportée).
3. L'utilisateur arrive sur `/login` (consent), se connecte.
4. Le client reçoit un access token scopé utilisateur, porté en
   `Authorization: Bearer …` à chaque requête `/mcp`.

### Validation

`withMcpAuth(auth, (req, mcpSession) => handler)` valide le token (401 +
`WWW-Authenticate` automatique si invalide). Si valide, `mcpSession` fournit
`userId` + scopes. Bearer pur, pas de cookie — adapté au remote/headless.

### Scoping org (`context.ts`)

Le token MCP ne porte pas d'« active team ». Résolution par outil :

- Paramètre **`team` optionnel** (slug).
- `team` fourni → vérifier l'appartenance (`member.findFirst`) ; sinon refus.
- `team` absent → si l'utilisateur a **une seule** org, la prendre par défaut ;
  sinon erreur d'ambiguïté listant les slugs disponibles.
- Outil `list_teams` (read-only, réutilise `listMyTeams`) ajouté pour permettre
  au client de découvrir ses orgs.

**Double garde** sur chaque accès : token valide (⇒ `userId`) **et** vérification
d'appartenance à l'org pour chaque ressource — parité avec l'endpoint SSE existant.

## Outils MCP (v1 read-only)

Format : `{ name, description, inputSchema (Zod), handler }`. Retour sérialisé en
`content: [{ type: 'text', text }]`.

| Outil | Input | Service | Retour |
|---|---|---|---|
| `list_teams` | — | `listMyTeams` | orgs (id, slug, nom, rôle) |
| `list_projects` | `{ team? }` | `listProjects` | projets de l'org |
| `get_project` | `{ projectId, team? }` | `getProject` | détail projet |
| `list_runs` | `{ projectId, team? }` | `listRuns` | runs du projet |
| `get_run` | `{ runId, team? }` | `getRun` | détail run |
| `get_run_diff` | `{ runId, team? }` | `getRunDiff` | diff git du run |
| `stream_run_events` | `{ runId, team? }` | `streamRunEvents` | streaming (voir ci-dessous) |

Garde-fous communs dans chaque handler via `context.ts` : résolution + validation
de l'org, puis validation que la ressource appartient à `organizationId`.

### Services partagés

Les remote functions `query()`/`command()` lisent l'auth via `getRequestEvent`,
donc inappelables depuis un handler MCP. On extrait la logique pure (accès prisma
+ règles d'autorisation) vers des services `src/lib/server/<domaine>-service.ts`,
consommés par **les deux** (remote functions ET outils MCP). Refactor ciblé aux
seules opérations read-only de la v1. Évite la divergence des règles d'accès.

## Streaming des events de run

En Streamable HTTP, le streaming serveur→client pendant un appel d'outil passe par
une réponse SSE sur le même endpoint `/mcp` (pas d'endpoint séparé).

### Mécanique de `stream_run_events`

1. Le client appelle `tools/call stream_run_events` avec `{ runId, team? }` et un
   `progressToken` (exposé par le SDK dans `extra`/`_meta`).
2. Le handler itère le generator partagé `streamRunEvents(runId, { fromSeq })`
   (curseur `seq`) et émet, par batch, une notification `notifications/progress`
   portant le payload de l'event.
3. À l'atteinte d'un statut terminal (`isTerminalStatus`), résout l'appel d'outil
   avec un résumé final (statut + nombre d'events).
4. `request.signal` / abort client coupe la boucle.

### Réutilisation

Generator partagé `streamRunEvents` consommé par l'endpoint SSE web ET l'outil MCP.
Réutilise `formatSseEvent` / `isTerminalStatus` et le pattern curseur `seq` du
endpoint existant. Keep-alive périodique (réutilise `PING_EVERY`), timeout de stream
max configurable, coupure sur statut terminal — pas de boucle infinie.

### Limite connue (honnête)

Tous les clients MCP ne consomment pas encore les notifications de progression en
« live » (certains les agrègent en fin d'appel). Le serveur expose le streaming
proprement ; le rendu temps réel dépend du client. **Fallback garanti** : `get_run`
+ polling côté client.

## Gestion des erreurs

| Cas | Réponse |
|---|---|
| Token absent/invalide/expiré | 401 + `WWW-Authenticate` (via `withMcpAuth`) |
| `team` ambigu (>1 org) | `isError: true` : « précise `team` parmi : [slugs] » |
| Non membre de l'org | `isError: true` : « accès refusé » (pas de détail cross-tenant) |
| Ressource introuvable **ou** hors org | `isError: true` : « introuvable » (message identique → pas de fuite) |
| Input invalide (Zod) | erreur de validation du SDK avant le handler |
| Erreur interne | `isError: true` générique + log serveur (jamais de stack/secret) |

Principes : **fail-closed** (défaut jamais permissif), parité de vérifs avec
l'endpoint SSE, pas de fuite d'existence cross-tenant, logs serveur avec
`runId`/`userId`.

## Tests (TDD, co-localisés vitest)

**Unitaires :**
- `context.test.ts` — résolution d'org : une seule org → défaut ; `team` membre → ok ;
  non-membre → refus ; >1 org sans `team` → ambiguïté ; ressource hors org →
  « introuvable ». Garde multi-tenant, la plus couverte.
- `tools.test.ts` — chaque outil : appelle le service mocké, sérialise, propage
  les erreurs en `isError`, ne contourne jamais `context`.
- Services partagés extraits — tests sur la logique d'autorisation déplacée ;
  garder verts les tests des remote functions existantes.

**Streaming :**
- `run-stream.test.ts` (étendre) — generator `streamRunEvents` : events par `seq`
  croissant, arrêt sur statut terminal, respect de l'abort. Une seule source pour
  web SSE + MCP.

**Intégration :**
- `mcp.integration.test.ts` — `initialize` → `tools/list` (liste attendue) →
  `tools/call list_projects` avec token mocké via `withMcpAuth` ; + cas 401 sans token.

**Vérification manuelle (hors tests auto) :** flow OAuth complet (DCR/PKCE) avec un
vrai client (MCP Inspector / Claude Desktop) — le flow lui-même est couvert par
better-auth. Noté comme étape de vérif finale.

## Hors périmètre v1

- Mutations : `start_run`, `cancel_run`, `approve_run` (→ v2).
- Gestion teams au-delà de `list_teams` (création, invitations).
- Resources/prompts MCP (uniquement des tools en v1).
- Transport SSE legacy.
- Redis pour resumabilité SSE cross-instance (process persistant unique en v1).
