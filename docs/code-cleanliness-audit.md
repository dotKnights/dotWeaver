# Audit de proprete du projet

Date: 2026-06-29

## Objectif

Identifier les principaux problemes de structure, duplication, code mort et outillage avant de lancer des refactors. Ce document privilegie les constats verifiables et les actions a faible regret.

## Skills et outils pertinents

Recherche effectuee avec `npx skills find "code quality audit refactor dead code duplication architecture typescript"`.

Skills externes trouves:

- `doodledood/codex-workflow@review-maintainability`: le plus proche pour un audit maintenabilite global.
- `manastalukdar/claude-devstudio@duplication-detect`: utile si on veut industrialiser la detection des duplications.
- `sebkay/skills@audit-dead-code`: utile pour un passage dedie code mort.
- `carvalab/k-skills@refactor-cleaner` et `tartinerlabs/skills@refactor`: plutot utiles au moment de corriger.

Recommendation: ne pas installer de skill tout de suite. Pour ce repo, les outils concrets `knip`, `jscpd`, `eslint`, `prettier`, `svelte-check` et `vitest` donnent deja un signal exploitable. Installer `review-maintainability` deviendrait interessant si cet audit doit devenir un rituel recurrent.

## Commandes executees

- `bun run check`: succes, `svelte-check found 0 errors and 0 warnings`.
- `bun run lint`: succes apres nettoyage ESLint, politique Prettier et formatage applicatif.
- `bun run test:unit -- --run`: succes, 87 fichiers de test et 730 tests passes. Le bruit SvelteKit/Vitest `wrapDynamicImport` a ete supprime en isolant les tests navigateur dans une config client dediee.
- `bun run quality:audit`: succes. `knip` sort un rapport informatif sur les exports/types restants, et `jscpd` trouve 12 clones / 380 lignes dupliquees, soit 0,85 % sous le seuil configure.
- `bun run test:unit -- --run ...runs...`: succes apres regroupement du domaine runs, 10 fichiers et 111 tests passes.

## Constats prioritaires

### P1 - Le signal qualite local est maintenant vert

`bun run lint`, `bun run check` et `bun run test:unit -- --run` passent.

Corrections deja appliquees:

- `.prettierignore` ignore explicitement `.agents/`, `.claude/` et `docs/superpowers/`.
- Les fichiers applicatifs signales par Prettier ont ete formates.
- Les 9 erreurs ESLint initiales ont ete corrigees.
- Le parametre `agent` ignore dans `startRun` a revele un vrai bug: l'agent choisi n'etait pas persiste. Le flux est maintenant couvert par tests et transmet `codex`/`claude` jusqu'a la creation du run.

Reste a traiter: le warning Prisma `driverAdapters` deprecated.

### P1 - `src/lib/server` est devenu un tiroir trop large

Mesures:

- 63 fichiers sous `src/lib/server`.
- 4 fichiers directement a la racine de `src/lib/server` apres extraction des domaines `runs`, `integrations/*`, `runtime`, `projects`, `auth` et `teams`.
- Les sous-domaines `runs`, `integrations/*`, `runtime`, `projects`, `auth`, `teams`, `project-environments` et `project-environment-services` sont deja organises, mais la racine contient encore les services transverses ou trop volumineux a traiter ensuite.

Regroupement propose:

- Fait: `src/lib/server/auth/`: `index.ts`, `org.ts`, `connectors.ts`, `request.ts`.
- Fait: `src/lib/server/integrations/github/`: `service.ts`, `git-auth.ts`, `pull-requests.ts`.
- Fait: `src/lib/server/integrations/gmail/`: `client.ts`, `service.ts`.
- Fait: `src/lib/server/integrations/poke/`: `sdk.ts`, `service.ts`.
- Fait: `src/lib/server/runs/`: `orchestrator.ts`, `service.ts`, `events.ts`, `stream.ts`, `state.ts`, `transitions.ts`, `recovery.ts`, `reply-service.ts`, `interactions-service.ts`, `interaction-answer-parser.ts`.
- Fait: `src/lib/server/projects/`: `service.ts`, `branches.ts`, `workspace.ts`, `workspace-paths.ts`, `diff.ts`.
- Fait: `src/lib/server/runtime/`: `docker.ts`, `docker-network.ts`, `git.ts`, `queue.ts`, `process-safety.ts`, `dotenv.ts`.
- Fait: `src/lib/server/teams/`: `service.ts`, `slug.ts`.

Action recommandee: faire ce rangement par domaine, un domaine par PR/commit, avec imports mis a jour et tests unitaires du domaine concernes.

### P1 - Plusieurs fichiers concentrent trop de responsabilites

Fichiers sources les plus volumineux:

- `src/lib/server/project-environment-services/service.ts`: 1020 lignes.
- `src/lib/server/project-agent-config-service.ts`: 1012 lignes.
- `src/lib/rfc/project-agent-config.remote.ts`: 582 lignes.
- `src/lib/server/integrations/gmail/client.ts`: 569 lignes.
- `src/lib/server/project-environments/service.ts`: 549 lignes.
- `src/lib/server/runs/orchestrator.ts`: 489 lignes.

Exemples de decoupage:

- `project-agent-config-service.ts`: separer acces projet, secrets/env vars, MCP runtime, skill materialization, import/export `.env`, materialisation runtime.
- `project-environment-services/service.ts`: separer config chiffree/sanitisation, validation env mapping, CRUD, provisionnement Docker, outputs/fingerprint.
- `project-agent-config.remote.ts`: sortir le parsing/import `.mcp.json` et skill markdown vers des helpers serveur testes, garder la remote function comme adaptateur HTTP/SvelteKit.
- `run-orchestrator.ts`: isoler preparation du workspace, construction env/runtime, execution conteneur, gestion messages/interactions, transitions d'etat.

Action recommandee: ne pas extraire pour extraire; commencer par les frontieres qui existent deja dans les tests et les fonctions internes.

### P1 - Code mort ou declarations inutiles a confirmer

`knip` est maintenant configure via `knip.json` et lance par `bun run audit:dead-code`. Les vrais nettoyages simples deja faits:

- `src/lib/index.ts` supprime.
- `@sveltejs/adapter-auto` retire.
- `dotenv` ajoute explicitement en devDependency.
- Les fichiers runner Docker et `vite.runner.config.ts` sont traites comme entrypoints.
- Les barrels UI shadcn sont ignores pour exports/types, car ils forment une API de design system.

Signal restant:

- 24 exports inutilises.
- 16 types exportes inutilises.
- 1 duplicate export semantique: `projectEnvironmentProjectIdSchema` / `projectEnvironmentDetectSchema`.

Action recommandee: passer ces exports un par un. Supprimer seulement ceux qui ne sont ni API publique interne, ni contrat schema, ni reserve volontaire.

### P2 - Duplications exploitables

Signal filtre `jscpd`: 12 clones / 380 lignes, soit 0,85 %.

Duplications les plus utiles a traiter:

- `src/lib/server/project-environment-services/providers/postgres.ts:10` et `redis.ts:10`: helpers identiques pour `password`, `asConfigRecord`, `validPort`, `hasWhitespaceOrControl`, `validImageReference`, `image`. Extraire vers `providers/common.ts`.
- `src/lib/server/project-environment-services/stream.ts:114` et `src/lib/server/project-environments/stream.ts:109`: logique de streaming/polling tres proche. Extraire un helper generique de stream d'evenements.
- `src/routes/(auth)/login/+page.svelte:62` et `src/routes/(auth)/register/+page.svelte:77`: markup auth commun. Extraire un composant de shell auth si l'ecran continue d'evoluer.
- Tests RFC: plusieurs fichiers repettent les memes mocks `requireHeaders`, `requireActiveOrg`, remote command/query refresh. Extraire des factories de test.
- `docker/runner/entrypoint.mjs` et `docker/runner/dotweaver-mcp-server.mjs`: duplication interaction request/response. A traiter seulement si le protocole d'interaction doit encore evoluer.

Action recommandee: commencer par providers et streams. Ce sont des duplications metier, pas seulement du markup ou du setup de test.

### P2 - Pages et composants Svelte trop charges

Fichiers UI les plus volumineux:

- `src/lib/components/projects/ProjectEnvironmentServicesPanel.svelte`: 553 lignes.
- `src/lib/components/projects/AgentConfigPanel.svelte`: 436 lignes.
- `src/routes/(app)/mail/+page.svelte`: 411 lignes.
- `src/routes/(app)/settings/connectors/+page.svelte`: 360 lignes.
- `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`: 338 lignes.

Points SvelteKit/Svelte 5:

- Le projet est bien en runes mode et `svelte-check` est propre.
- La doc Svelte recommande d'extraire la logique testable hors composants quand le test porte surtout sur la logique interne. C'est pertinent pour `ProjectEnvironmentServicesPanel.svelte` et `AgentConfigPanel.svelte`.
- `src/routes/(app)/settings/connectors/+page.svelte` utilise `onMount` pour des listeners `window` et `document`; pour les listeners globaux, la doc Svelte recommande plutot `<svelte:window>` et `<svelte:document>`. L'intervalle peut rester dans une logique de cycle de vie, mais les listeners peuvent etre declaratifs.

Action recommandee: extraire d'abord les fonctions pures et les types d'etat, puis seulement ensuite decouper les sous-composants.

### P2 - Configuration obsolete ou bruyante

- `svelte.config.js` a ete migre de `csrf.checkOrigin: false` vers `csrf.trustedOrigins: ['*']`, equivalent documente par SvelteKit pour ce cas.
- `prisma generate` affiche: `Preview feature "driverAdapters" is deprecated`.
- Le bruit SvelteKit `wrapDynamicImport` des tests unitaires a ete corrige en faisant sortir les tests navigateur du plugin SvelteKit serveur.

Action recommandee: traiter ces warnings comme dette d'outillage, pas comme refactor metier.

## Feuille de route proposee

1. Fait: remettre le signal qualite au vert.
2. Fait: ajouter une config d'audit `knip` + `jscpd` et un script `quality:audit`.
3. En cours: ranger `src/lib/server` par domaines sans modifier le comportement. `runs`, `integrations/*`, `runtime`, `projects`, `auth` et `teams` sont faits; poursuivre avec les services transverses restants.
4. Scinder `project-agent-config-service.ts` et `project-environment-services/service.ts` par responsabilites.
5. Factoriser les duplications metier: providers common, stream common, factories de tests.
6. Nettoyer le code mort valide par `knip`.
7. Extraire la logique lourde des composants Svelte projets/connecteurs en modules testables.

## Definition de done pour les refactors

- `bun run check` passe.
- `bunx eslint .` passe.
- `bun run test:unit -- --run` passe sans nouveau bruit.
- `knip` n'a plus que des ignores documentes.
- `jscpd` filtre reste stable ou baisse, sans factoriser du code genere.
- Les imports `$lib/server/...` suivent les nouveaux domaines.
