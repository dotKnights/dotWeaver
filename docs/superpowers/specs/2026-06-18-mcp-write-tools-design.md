# MCP write tools - Design

**Date**: 2026-06-18
**Statut**: Valide en brainstorming
**Perimetre**: v2 write tools pour projets GitHub et runs

## Objectif

Permettre a un client MCP distant authentifie de piloter dotWeaver en ecriture:
importer un projet GitHub, lancer un run, l'annuler, repondre a un run en attente,
puis approuver le resultat en ouvrant une pull request ou l'abandonner.

La v2 reste une facade fine au-dessus de la logique metier existante. Les outils
MCP ne doivent pas dupliquer les regles de l'UI SvelteKit.

## Decisions de cadrage

| Sujet              | Decision                                                                      |
| ------------------ | ----------------------------------------------------------------------------- |
| Activation         | Pas de feature flag: utilisateur OAuth MCP connecte + membre de la team       |
| Mutations exposees | Import GitHub, start run, cancel run, reply to run, approve run               |
| Approbation MCP    | `push_pr` et `abandon` uniquement                                             |
| Push direct        | Hors perimetre MCP v2                                                         |
| GitHub token       | Recupere cote serveur pour `ctx.userId`, jamais fourni par le client MCP      |
| Multi-tenant       | Parametre `team?` et resolution via `resolveOrgContext` comme les outils read |
| Source de verite   | Services serveur purs partages entre remote functions et MCP                  |

## Surface d'outils MCP

Les outils retournent des resultats JSON via `content: [{ type: "text", text }]`
comme la v1 read-only. Les erreurs metier retournent `isError: true` avec un
message concis et sans stack.

| Outil                   | Input                                                                       | Effet                                                                                   | Retour                       |
| ----------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------- |
| `import_github_project` | `{ owner, name, team? }`                                                    | Re-fetch le repo GitHub puis upsert le projet dans la team                              | `{ id }`                     |
| `start_run`             | `{ projectId, prompt, baseBranch?, model?, useProjectAgentConfig?, team? }` | Cree un run `queued` et l'enqueue                                                       | `{ runId }`                  |
| `cancel_run`            | `{ runId, team? }`                                                          | Passe un run cancelable a `canceled`, annule les interactions pending, tue le conteneur | `{ canceled }`               |
| `reply_to_run`          | `{ runId, message, team? }`                                                 | Repond a un run en `awaiting_review` et relance la session existante                    | `{ ok: true }`               |
| `approve_run`           | `{ runId, action, team? }` avec `action` parmi `push_pr`, `abandon`         | Ouvre une PR depuis la branche agent ou abandonne le run                                | `{ status, pullRequestUrl }` |

`approve_run` n'expose pas l'action existante `push`. Le chemin MCP doit garder
un resultat reviewable: branche agent poussee + pull request.

## Architecture

### Principe

Les remote functions et les outils MCP deviennent deux adaptateurs autour des
memes services. Chaque adaptateur s'occupe de son contexte d'authentification,
puis appelle la logique metier pure.

```
UI SvelteKit remote function       MCP tool
        |                            |
        | headers + active org       | OAuth userId + team?
        | GitHub token via headers   | GitHub token via userId
        v                            v
      services serveur purs partages
        |
        v
      Prisma, GitHub, queue, Docker, git
```

### Services projets

`src/lib/server/projects-service.ts` garde les fonctions read-only existantes et
ajoute:

```ts
importGithubProjectForOrg(input: {
	organizationId: string;
	userId: string;
	token: string | null;
	owner: string;
	name: string;
}): Promise<{ id: string }>;
```

Responsabilites:

- verifier que le token GitHub existe;
- recuperer le repo via `getRepo`;
- mapper via `mapRepoToProjectInput`;
- upsert par `(organizationId, githubRepoId)`.

### Services runs

`src/lib/server/runs-service.ts` garde les fonctions read-only existantes et
centralise les mutations:

```ts
startRunForOrg(input: {
	organizationId: string;
	userId: string;
	githubToken: string | null;
	projectId: string;
	prompt: string;
	baseBranch?: string;
	model?: "sonnet" | "opus" | "haiku";
	useProjectAgentConfig: boolean;
	timeoutAt: Date;
}): Promise<{ runId: string }>;

cancelRunForOrg(organizationId: string, runId: string): Promise<{ canceled: boolean }>;

approveRunForOrg(input: {
	organizationId: string;
	githubToken: string | null;
	runId: string;
	action: "push_pr" | "abandon";
}): Promise<{ status: string; pullRequestUrl: string | null }>;
```

`replyToRunForOrg` existe deja dans `run-reply-service.ts`; le tool MCP peut
l'appeler directement ou `runs-service.ts` peut le re-exporter pour garder une
surface runs unique. Le choix d'implementation doit favoriser le plus petit
changement coherent avec les imports actuels.

Responsabilites de `startRunForOrg`:

- verifier que le projet existe dans `organizationId`;
- choisir `baseBranch ?? project.defaultBranch`;
- valider l'existence de la branche via `assertProjectBranchExists`;
- valider la config agent si `useProjectAgentConfig` est active;
- creer le run avec `agentBranch(id)`, `queued`, `timeoutAt`;
- enqueue le run;
- si l'enqueue echoue apres creation, marquer le run `failed` comme aujourd'hui.

Responsabilites de `cancelRunForOrg`:

- trouver le run dans `organizationId`;
- transitionner depuis `RUN_STATUS_GROUPS.CANCELABLE` vers `canceled`;
- annuler les interactions pending;
- tuer le conteneur si la transition a vraiment eu lieu.

Responsabilites de `approveRunForOrg`:

- trouver le run et son projet dans `organizationId`;
- refuser si le run n'est pas `awaiting_review`;
- `abandon`: transition vers `canceled`, supprimer le checkout, retourner
  `{ status: "canceled", pullRequestUrl: null }`;
- `push_pr`: verifier le token GitHub, transitionner vers `pushing`, pousser la
  branche agent, ouvrir la PR, creer `PullRequest`, transitionner vers
  `completed`;
- en cas d'erreur pendant le push/PR, transitionner vers `failed` comme l'UI.

## Adaptateurs

### Remote functions

Les remote functions existantes gardent leurs schemas et leur API publique. Elles
ne contiennent plus la logique metier detaillee:

1. lire `headers`;
2. resoudre `organizationId` via `requireActiveOrg`;
3. lire `locals.user!.id`;
4. recuperer le token GitHub quand necessaire;
5. appeler le service;
6. rafraichir les queries SvelteKit concernees.

### MCP tools

`src/lib/server/mcp/tools.ts` ajoute les 5 tools write. Pour chaque outil:

1. valider l'input avec les schemas Zod existants quand possible;
2. resoudre `organizationId` via `resolveOrgContext(ctx.userId, args.team)`;
3. recuperer le token GitHub pour `ctx.userId` cote serveur;
4. appeler le service partage;
5. mapper les erreurs en `ToolResult`.

Le contexte MCP reste minimal:

```ts
export interface McpToolContext {
	userId: string;
}
```

Pas besoin d'ajouter de session state: le serveur MCP reste stateless par
requete, comme la v1.

## Erreurs et securite

Messages attendus cote MCP:

| Cas                                     | Message                                   |
| --------------------------------------- | ----------------------------------------- |
| Plusieurs teams sans `team`             | Message existant avec la liste des slugs  |
| Team absente ou non autorisee           | `Access denied to the requested team`     |
| Aucune team                             | `You are not a member of any team`        |
| GitHub non connecte                     | `Connect your GitHub account to continue` |
| Projet absent ou hors team              | `Project not found`                       |
| Run absent ou hors team                 | `Run not found`                           |
| Branche invalide ou absente             | Message de `assertProjectBranchExists`    |
| Run pas en review lors de l'approbation | `Run is not awaiting review (...)`        |
| Push/PR echoue                          | Message utile sans stack ni secret        |

Garde-fous:

- filtrage systematique par `organizationId`;
- pas de fuite cross-tenant: absent et hors team restent indistinguables;
- aucun token GitHub dans les inputs ou outputs MCP;
- pas de `push` direct via MCP;
- transitions de run conditionnelles conservees pour eviter les races.

## Tests

### Unitaires services

- `projects-service.test.ts`
  - importe un repo avec token et upsert le projet;
  - refuse sans token;
  - propage une erreur GitHub utile.

- `runs-service.test.ts`
  - `startRunForOrg` scope le projet par org, valide la branche, cree et enqueue;
  - `startRunForOrg` marque `failed` si l'enqueue echoue apres creation;
  - `cancelRunForOrg` transitionne, annule interactions et tue le conteneur;
  - `approveRunForOrg` refuse hors `awaiting_review`;
  - `approveRunForOrg(abandon)` annule et supprime le checkout;
  - `approveRunForOrg(push_pr)` pousse, ouvre la PR et complete le run;
  - `approveRunForOrg(push_pr)` marque `failed` si le push/PR echoue.

### Unitaires MCP

- `tools.test.ts`
  - enregistre les 12 outils attendus: 7 read-only + 5 write;
  - chaque write tool resout la team puis appelle le service;
  - `approve_run` refuse schema-level l'action `push`;
  - erreurs org, GitHub, not found et validation sont mappees en `isError`.

### Verification manuelle

Mettre a jour `docs/mcp.md` avec:

- le passage de "v1 read-only" a "read + write tools";
- la table des 5 nouveaux outils;
- un scenario MCP Inspector:
  1. `import_github_project`;
  2. `start_run`;
  3. `stream_run_events`;
  4. `reply_to_run` si le run attend une reprise;
  5. `approve_run` avec `push_pr` ou `abandon`.

## Hors perimetre

- Ecriture de configuration projet MCP, secrets, env vars ou skills;
- creation ou gestion de teams;
- action `push` directe;
- nouveau systeme de permission ou feature flag;
- resources/prompts MCP;
- changement du transport Streamable HTTP.

## Plan de migration attendu

1. Ajouter les tests rouges sur les services write.
2. Extraire/importer les services partages.
3. Adapter les remote functions aux services sans changer leur API.
4. Ajouter les tools MCP write et leurs tests.
5. Mettre a jour la documentation MCP.
6. Executer `bun run test:unit -- --run`, `bun run check`, puis une verification
   manuelle avec MCP Inspector si l'environnement OAuth/GitHub est disponible.
