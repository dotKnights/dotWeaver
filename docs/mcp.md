# Serveur MCP distant — Référence

**Transport** : Streamable HTTP (spec MCP 2025-03+)  
**Périmètre** : outils read + write pour projets et runs  
**Statut auth** : OAuth 2.0 via better-auth plugin `mcp()`

---

## 1. Vue d'ensemble

dotWeaver expose un endpoint **Streamable HTTP MCP** à `/mcp`. Il permet aux clients
MCP distants (Claude Desktop, Claude.ai, MCP Inspector…) de consulter projets, runs
et diffs, de streamer la progression des runs en cours, puis d'importer des projets
GitHub et de piloter le cycle de vie des runs.

URL de base : `<BETTER_AUTH_URL>` (variable d'environnement).

| Environnement | Endpoint MCP                |
| ------------- | --------------------------- |
| Développement | `http://localhost:5173/mcp` |
| Production    | `<BETTER_AUTH_URL>/mcp`     |

Le serveur fonctionne en mode **stateless** : chaque requête crée une instance MCP
fraîche scopée à l'utilisateur authentifié (`userId`). Aucun `Mcp-Session-Id` n'est
requis ni renvoyé.

---

## 2. Authentification

### Flow OAuth 2.0

1. `POST /mcp` sans token Bearer → **401** + header `WWW-Authenticate` pointant vers
   `/.well-known/oauth-protected-resource`.
2. Le client lit le metadata de discovery, découvre l'Authorization Server, et lance
   un flow **OAuth 2.0 + PKCE**. La **Dynamic Client Registration** est supportée
   (pas besoin d'enregistrer le client à l'avance).
3. L'utilisateur est redirigé vers la page `/login` existante pour se connecter et
   donner son consentement.
4. Le client reçoit un access token qu'il joint à chaque requête :
   `Authorization: Bearer <token>`.

### Endpoints de discovery

Tous retournent 200 JSON.

| Endpoint                                  | Contenu                                                                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/.well-known/oauth-protected-resource`   | `{ resource: "<base>/mcp", authorization_servers: ["<base>"], scopes_supported: ["openid","profile","email","offline_access"], … }` |
| `/.well-known/oauth-authorization-server` | `{ issuer: "<base>", authorization_endpoint: "<base>/api/auth/mcp/authorize", token_endpoint, registration_endpoint, … }`           |

### Scopes supportés

`openid`, `profile`, `email`, `offline_access`.

---

## 3. Référence des outils

Les outils de lecture sont read-only. Les outils d'écriture permettent d'importer
des projets GitHub et de piloter le cycle de vie des runs avec les mêmes garde-fous
multi-tenant que l'interface web. Les retours sont sérialisés en
`content: [{ type: "text", text: "<JSON>" }]`.

### Résolution de l'argument `team`

La plupart des outils acceptent un argument optionnel **`team`** (slug de
l'organisation) :

- `team` fourni → l'appartenance de l'utilisateur à cette org est vérifiée ; accès
  refusé si non membre.
- `team` absent, **une seule org** → l'org est prise par défaut.
- `team` absent, **plusieurs orgs** → erreur d'ambiguïté listant les slugs
  disponibles ; utiliser `list_teams` pour les obtenir.
- `team` absent, **aucune org** → erreur.

Sécurité multi-tenant : chaque outil valide l'appartenance à l'org, puis que la
ressource demandée appartient bien à cette org. "Introuvable" et "hors org" sont
indiscernables côté client (pas de fuite cross-tenant).

### Table des outils

| Outil                   | Arguments                                                                   | Description                                                                                                                                                        | Retour                           |
| ----------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `list_teams`            | —                                                                           | Liste les organisations (teams) auxquelles l'utilisateur appartient.                                                                                               | `[{ id, slug, name, role }]`     |
| `list_projects`         | `{ team? }`                                                                 | Projets de l'organisation.                                                                                                                                         | `[{ id, name, … }]`              |
| `get_project`           | `{ projectId, team? }`                                                      | Détail d'un projet.                                                                                                                                                | `{ id, name, … }`                |
| `import_github_project` | `{ owner, name, team? }`                                                    | Importe ou met à jour un repo GitHub comme projet dotWeaver.                                                                                                       | `{ id }`                         |
| `list_runs`             | `{ projectId, team? }`                                                      | Runs d'un projet, du plus récent au plus ancien.                                                                                                                   | `[{ id, status, createdAt, … }]` |
| `start_run`             | `{ projectId, prompt, baseBranch?, model?, useProjectAgentConfig?, team? }` | Crée un run et l'ajoute à la file d'exécution.                                                                                                                     | `{ runId }`                      |
| `get_run`               | `{ runId, team? }`                                                          | Détail d'un run avec ses events ordonnés.                                                                                                                          | `{ id, status, events: […] }`    |
| `cancel_run`            | `{ runId, team? }`                                                          | Annule un run annulable.                                                                                                                                           | `{ canceled }`                   |
| `reply_to_run`          | `{ runId, message, team? }`                                                 | Répond à un run en attente de reprise.                                                                                                                             | `{ ok: true }`                   |
| `approve_run`           | `{ runId, action: "push_pr" \| "abandon", team? }`                          | Ouvre une PR depuis la branche agent ou abandonne le run.                                                                                                          | `{ status, pullRequestUrl }`     |
| `get_run_diff`          | `{ runId, team? }`                                                          | Diff git (base..head) associé à un run.                                                                                                                            | `{ diff: "<patch>" }`            |
| `stream_run_events`     | `{ runId, team? }`                                                          | Stream les events d'un run jusqu'à son statut terminal. Émet des notifications `notifications/progress` pendant l'appel ET retourne `{ status, events }` à la fin. | `{ status, events: […] }`        |

`approve_run` supporte uniquement les actions `push_pr` et `abandon`. Le push direct
via l'action `push` n'est pas exposé par MCP.

### `stream_run_events` — détail

- Pendant l'exécution : chaque batch d'events est émis comme notification MCP
  `notifications/progress` (si le client fournit un `progressToken`).
- À la fin : l'outil retourne `{ status, events }` (résumé complet), utilisable par
  les clients qui n'affichent pas les notifications en direct.
- L'abort du client (signal) interrompt la boucle de streaming.

---

## 4. Configuration client

### Claude Desktop (et tout client avec `mcp-remote`)

Ajouter dans `~/Library/Application Support/Claude/claude_desktop_config.json` :

```json
{
	"mcpServers": {
		"dotweaver": {
			"command": "npx",
			"args": ["-y", "mcp-remote", "https://<votre-domaine>/mcp"]
		}
	}
}
```

En développement local :

```json
{
	"mcpServers": {
		"dotweaver": {
			"command": "npx",
			"args": ["-y", "mcp-remote", "http://localhost:5173/mcp"]
		}
	}
}
```

`mcp-remote` gère le flow OAuth (DCR + PKCE + refresh) automatiquement.

### MCP Inspector

```bash
bunx @modelcontextprotocol/inspector
```

Dans l'interface :

1. Transport type : **Streamable HTTP**
2. URL : `http://localhost:5173/mcp` (ou l'URL de production)
3. Cliquer **Connect** → le flow OAuth s'ouvre dans le navigateur → `/login` →
   consentement → retour dans l'Inspector.

---

## 5. Limites connues (v1)

### Notifications de progression live

Tous les clients MCP ne consomment pas encore les notifications `notifications/progress`
en temps réel. Certains les agrègent et les affichent uniquement à la fin de l'appel.

**Fallback garanti** : appeler `get_run` répétitivement (polling) pour suivre la
progression d'un run en cours sans dépendre du streaming live.

### Hors périmètre

- Gestion teams au-delà de `list_teams` (création, invitations).
- Écriture de configuration projet MCP, secrets, variables d'environnement et skills.
- Resources et prompts MCP (uniquement des tools en v1).
- Transport SSE legacy.

---

## 6. Checklist de vérification manuelle

Étapes à exécuter par un humain (le flow OAuth complet ne peut pas être automatisé
par les tests unitaires).

### Prérequis

- Serveur de développement en cours d'exécution : `bun dev`
- Un compte utilisateur existant avec au moins une organisation
- MCP Inspector disponible : `bunx @modelcontextprotocol/inspector`

### Étapes

- [ ] **Discovery** — `curl http://localhost:5173/.well-known/oauth-protected-resource`
      retourne 200 JSON avec `resource` et `authorization_servers`.
- [ ] **Discovery AS** — `curl http://localhost:5173/.well-known/oauth-authorization-server`
      retourne 200 JSON avec `authorization_endpoint`, `token_endpoint`,
      `registration_endpoint`.
- [ ] **401 sans token** — `curl -X POST http://localhost:5173/mcp -H "Content-Type: application/json" -d '{}'`
      retourne 401 avec header `WWW-Authenticate`.
- [ ] **Lancer l'Inspector** — `bunx @modelcontextprotocol/inspector`
- [ ] **Connexion OAuth** — choisir "Streamable HTTP", URL `http://localhost:5173/mcp`,
      cliquer Connect. Le navigateur s'ouvre sur `/login`. Se connecter. Revenir dans
      l'Inspector → statut "Connected".
- [ ] **Liste des outils** — dans l'Inspector, appeler `tools/list` : confirmer que
      les 12 outils sont listés (`approve_run`, `cancel_run`, `get_project`, `get_run`,
      `get_run_diff`, `import_github_project`, `list_projects`, `list_runs`,
      `list_teams`, `reply_to_run`, `start_run`, `stream_run_events`).
- [ ] **`list_teams`** — appeler l'outil sans argument. Vérifier que les organisations
      de l'utilisateur apparaissent avec `id`, `slug`, `name`, `role`.
- [ ] **`list_projects`** — appeler avec `{}` (team déduit automatiquement si une seule
      org, ou avec `{ "team": "<slug>" }` si plusieurs). Vérifier les projets retournés.
- [ ] **`stream_run_events` sur un run terminé** — récupérer un `runId` via `list_runs`,
      appeler `stream_run_events` avec ce `runId`. Confirmer que le retour final contient
      `{ status: "<terminal>", events: […] }` avec tous les events.
- [ ] **Flow write** — appeler `import_github_project`, puis `start_run`, suivre avec
      `stream_run_events`, répondre avec `reply_to_run` si nécessaire, puis terminer avec
      `approve_run` en `push_pr` ou `abandon`.
- [ ] **Multi-tenant** — si possible, tester avec un `runId` appartenant à une autre
      organisation : confirmer que la réponse est "introuvable" (pas une erreur 403
      révélatrice).
