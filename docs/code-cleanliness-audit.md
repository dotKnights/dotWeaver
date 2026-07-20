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
- `bun run test:unit -- --run`: succes, 93 fichiers de test et 750 tests passes. Le bruit SvelteKit/Vitest `wrapDynamicImport` a ete supprime en isolant les tests navigateur dans une config client dediee.
- `bun run quality:audit`: succes. `knip` ne signale plus d'exports/types inutilises, et `jscpd` trouve 2 clones / 43 lignes dupliquees, soit 0,10 % sous le seuil configure.
- `bun run test:unit -- --run ...runs...`: succes apres regroupement du domaine runs, 10 fichiers et 111 tests passes.
- `bun vitest --run --project server tests/unit/lib/server/project-environments/service.test.ts tests/unit/lib/server/run-orchestrator.test.ts`: succes apres extraction de `project-environments/run-config.ts`, 2 fichiers et 54 tests passes.

## Constats prioritaires

### P1 - Le signal qualite local est maintenant vert

`bun run lint`, `bun run check` et `bun run test:unit -- --run` passent.

Corrections deja appliquees:

- `.prettierignore` ignore explicitement `.agents/`, `.claude/` et `docs/superpowers/`.
- Les fichiers applicatifs signales par Prettier ont ete formates.
- Les 9 erreurs ESLint initiales ont ete corrigees.
- Le parametre `agent` ignore dans `startRun` a revele un vrai bug: l'agent choisi n'etait pas persiste. Le flux est maintenant couvert par tests et transmet `codex`/`claude` jusqu'a la creation du run.

Le warning Prisma `driverAdapters` deprecated a ete nettoye en retirant la preview feature obsolete.

### P1 - `src/lib/server` est devenu un tiroir trop large

Mesures:

- 64 fichiers sous `src/lib/server`.
- 1 fichier directement a la racine de `src/lib/server`: `prisma.ts`.
- Les sous-domaines `runs`, `integrations/*`, `runtime`, `projects`, `auth`, `teams`, `project-agent-config`, `project-environments` et `project-environment-services` sont maintenant organises. Le prochain chantier n'est plus le rangement de racine, mais le decoupage des gros services.

Regroupement propose:

- Fait: `src/lib/server/auth/`: `index.ts`, `org.ts`, `connectors.ts`, `request.ts`.
- Fait: `src/lib/server/integrations/github/`: `service.ts`, `git-auth.ts`, `pull-requests.ts`.
- Fait: `src/lib/server/integrations/gmail/`: `client.ts`, `service.ts`.
- Fait: `src/lib/server/integrations/poke/`: `sdk.ts`, `service.ts`.
- Fait: `src/lib/server/integrations/skills-sh/`: `service.ts`.
- Fait: `src/lib/server/runs/`: `orchestrator.ts`, `service.ts`, `events.ts`, `stream.ts`, `transitions.ts`, `recovery.ts`, `reply-service.ts`, `interactions-service.ts`, `interaction-answer-parser.ts`.
- Fait: `src/lib/server/projects/`: `service.ts`, `branches.ts`, `workspace.ts`, `workspace-paths.ts`, `diff.ts`.
- Fait: `src/lib/server/project-agent-config/`: facade `service.ts`, modules `encryption.ts`, `errors.ts`, `env-vars.ts`, `mcp-servers.ts`, `overview.ts`, `project-access.ts`, `runtime-builder.ts`, `secrets.ts`, `skills.ts`.
- Fait: `src/lib/server/project-environment-services/`: facade `service.ts`, modules `config.ts`, `crud.ts`, `env-mapping-guards.ts`, `errors.ts`, `lifecycle.ts`, `outputs.ts`, `prisma-json.ts`, `provider-utils.ts`, `provisioning.ts`.
- Fait: `src/lib/server/runtime/`: `docker.ts`, `docker-network.ts`, `git.ts`, `queue.ts`, `process-safety.ts`, `dotenv.ts`.
- Fait: `src/lib/server/teams/`: `service.ts`, `slug.ts`.

Action recommandee: faire ce rangement par domaine, un domaine par PR/commit, avec imports mis a jour et tests unitaires du domaine concernes.

### P1 - Plusieurs fichiers concentrent trop de responsabilites

Fichiers sources les plus volumineux:

- `src/lib/server/integrations/gmail/client.ts`: 569 lignes.
- `src/lib/server/runs/orchestrator.ts`: 423 lignes.
- `src/routes/(app)/mail/+page.svelte`: 411 lignes.
- `src/lib/server/project-environments/prepare.ts`: 394 lignes.
- `src/routes/(app)/settings/connectors/+page.svelte`: 360 lignes.
- `src/lib/server/project-environments/service.ts`: 360 lignes.
- `src/lib/server/mcp/tools.ts`: 355 lignes.
- `src/lib/server/project-environment-services/config.ts`: 346 lignes.
- `src/lib/server/project-agent-config/runtime-builder.ts`: 342 lignes.
- `src/lib/server/integrations/skills-sh/service.ts`: 342 lignes.
- `src/lib/server/project-agent-config/mcp-import.ts`: 301 lignes.
- `src/lib/rfc/project-agent-config.remote.ts`: 298 lignes.
- `src/lib/components/projects/ProjectEnvironmentServiceCard.svelte`: 278 lignes.
- `src/routes/(app)/projects/[id]/+page.svelte`: 274 lignes.
- `src/lib/server/project-environment-services/env-mapping.ts`: 267 lignes.
- `src/lib/server/integrations/poke/service.ts`: 256 lignes.
- `src/lib/components/projects/ProjectSetupChecklist.svelte`: 253 lignes.
- `src/lib/server/runs/interactions-service.ts`: 250 lignes.
- `src/lib/components/projects/ProjectEnvironmentServicesPanel.svelte`: 236 lignes.
- `src/lib/components/projects/EnvironmentEditor.svelte`: 210 lignes.

Exemples de decoupage:

- Fait: `project-agent-config/service.ts`: erreurs, acces projet, vue globale, secrets, env vars/import `.env`, CRUD MCP, import/CRUD skills, validation de noms/chemins, types runtime, build MCP runtime et materialisation des fichiers agent extraits vers `project-agent-config/errors.ts`, `project-access.ts`, `overview.ts`, `secrets.ts`, `env-vars.ts`, `mcp-servers.ts`, `skills.ts`, `validation.ts`, `runtime-types.ts`, `runtime-builder.ts` et `materialization.ts`. Le fichier facade est descendu a 22 lignes.
- Fait: `project-environment-services/service.ts`: config chiffree, CRUD, outputs stockes, outputs/fingerprint runtime, sanitisation publique, erreurs, garde-fous env mappings, lifecycle notifications/events, helpers provider/JSON et provisionnement Docker extraits vers `project-environment-services/config.ts`, `crud.ts`, `env-mapping-guards.ts`, `outputs.ts`, `errors.ts`, `lifecycle.ts`, `provider-utils.ts`, `prisma-json.ts` et `provisioning.ts`. Le fichier facade est descendu a 10 lignes.
- Fait: `project-environments/service.ts`: erreur commune et construction de la configuration runtime d'un run extraites vers `project-environments/errors.ts` et `project-environments/run-config.ts`. La facade est descendue de 549 a 360 lignes.
- Fait: `project-agent-config.remote.ts`: parsing/import `.mcp.json` extrait vers `project-agent-config/mcp-import.ts`, avec tests serveur dedies. La remote garde l'orchestration DB/SvelteKit.
- Fait: `run-orchestrator.ts`: normalisation agent, garde-fou credentials provider et construction env/mounts du conteneur extraits vers `runs/execution-config.ts`, avec tests dedies. Le fichier est descendu de 497 a 423 lignes.

Action recommandee: ne pas extraire pour extraire; commencer par les frontieres qui existent deja dans les tests et les fonctions internes.

### P1 - Code mort nettoye

`knip` est maintenant configure via `knip.json` et lance par `bun run audit:dead-code`. Les vrais nettoyages simples deja faits:

- `src/lib/index.ts` supprime.
- `@sveltejs/adapter-auto` retire.
- `dotenv` ajoute explicitement en devDependency.
- Les fichiers runner Docker et `vite.runner.config.ts` sont traites comme entrypoints.
- Les barrels UI shadcn sont ignores pour exports/types, car ils forment une API de design system.
- Les exports/types inutilises detectes par `knip` ont ete supprimes ou rendus prives.
- Les remotes non branchees `getMailConnectionStatus` et `importProjectSkillMarkdown` ont ete retirees avec leurs mocks.
- L'ancien re-export `src/lib/server/runs/state.ts` a ete supprime; les consommateurs utilisent directement `$lib/domain/run-status`.

Signal restant:

- Aucun signal `knip` hors ignores documentes.

Action recommandee: garder `bun run audit:dead-code` dans la verification de refactor, et ne rajouter des ignores que pour des API publiques volontaires.

### P2 - Duplications exploitables

Signal filtre `jscpd`: 2 clones / 43 lignes, soit 0,10 %.

Duplications les plus utiles a traiter:

- Fait: `src/lib/server/project-environment-services/providers/postgres.ts` et `redis.ts`: helpers communs extraits vers `providers/common.ts`.
- Fait: `src/lib/server/project-environment-services/stream.ts` et `src/lib/server/project-environments/stream.ts`: primitives SSE/Postgres extraites vers `runtime/event-stream.ts`.
- Fait: auth login/register: shell et champs communs extraits vers `components/auth/AuthCard.svelte` et `AuthField.svelte`.
- Fait: tests RFC: mocks remote command/query/refresh partages extraits vers `tests/unit/lib/rfc/remote-test-helpers.ts`.
- Fait: `AppSidebar.svelte` / `AppTopbar.svelte`: types et navigation primaire extraits vers `components/layout/navigation.ts`.
- Fait: `tests/unit/lib/server/run-orchestrator.test.ts`: helpers de simulation interaction/cleanup extraits dans le fichier de test.
- `docker/runner/entrypoint.mjs` et `docker/runner/dotweaver-mcp-server.mjs`: duplication interaction request/response. A traiter seulement si le protocole d'interaction doit encore evoluer.
- `src/lib/server/project-agent-config/materialization.ts` et `src/lib/server/project-environments/hydrate.ts`: duplication proche autour de helpers de materialisation/hydratation. A traiter seulement si l'on unifie explicitement ces deux chemins.

Action recommandee: laisser les deux duplications restantes tant qu'elles ne bloquent pas une evolution; les extraire maintenant risquerait de creer une abstraction prematuree.

### P2 - Pages et composants Svelte trop charges

Fichiers UI les plus volumineux:

- `src/routes/(app)/mail/+page.svelte`: 411 lignes.
- `src/routes/(app)/settings/connectors/+page.svelte`: 360 lignes.
- `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`: 338 lignes.
- `src/lib/components/projects/AgentConfigPanel.svelte`: 330 lignes.
- `src/lib/components/projects/ProjectEnvironmentServiceCard.svelte`: 278 lignes.
- `src/lib/components/projects/ProjectEnvironmentServicesPanel.svelte`: 236 lignes.
- `src/lib/components/projects/EnvironmentEditor.svelte`: 210 lignes.

Points SvelteKit/Svelte 5:

- Le projet est bien en runes mode et `svelte-check` est propre.
- Fait: logique testable de `ProjectEnvironmentServicesPanel.svelte`, `EnvironmentEditor.svelte` et `AgentConfigPanel.svelte` extraite vers des modules `.ts` couverts par tests.
- Fait: rendu detaille des services et section `.env` d'agent config extraits vers des sous-composants Svelte.
- `src/routes/(app)/settings/connectors/+page.svelte` utilise `onMount` pour des listeners `window` et `document`; pour les listeners globaux, la doc Svelte recommande plutot `<svelte:window>` et `<svelte:document>`. L'intervalle peut rester dans une logique de cycle de vie, mais les listeners peuvent etre declaratifs.

Action recommandee: extraire d'abord les fonctions pures et les types d'etat, puis seulement ensuite decouper les sous-composants.

### P2 - Configuration obsolete ou bruyante

- `svelte.config.js` a ete migre de `csrf.checkOrigin: false` vers `csrf.trustedOrigins: ['*']`, equivalent documente par SvelteKit pour ce cas.
- Fait: `prisma generate` ne signale plus `Preview feature "driverAdapters" is deprecated`; la preview feature obsolete a ete retiree du schema.
- Le bruit SvelteKit `wrapDynamicImport` des tests unitaires a ete corrige en faisant sortir les tests navigateur du plugin SvelteKit serveur.

Action recommandee: traiter les prochains warnings d'outillage comme dette qualite, pas comme refactor metier.

## Feuille de route proposee

1. Fait: remettre le signal qualite au vert.
2. Fait: ajouter une config d'audit `knip` + `jscpd` et un script `quality:audit`.
3. Fait: ranger `src/lib/server` par domaines sans modifier le comportement.
4. En cours: scinder les gros services projet/environnements par responsabilites.
5. Fait: factoriser les duplications utiles: factories de tests, shell auth, navigation layout, test orchestrateur.
6. Fait: nettoyer le code mort valide par `knip`.
7. Fait: extraire la logique lourde des composants Svelte projets en modules testables et sous-composants.

## Definition de done pour les refactors

- `bun run check` passe.
- `bunx eslint .` passe.
- `bun run test:unit -- --run` passe sans nouveau bruit.
- `knip` n'a plus que des ignores documentes.
- `jscpd` filtre reste stable ou baisse, sans factoriser du code genere.
- Les imports `$lib/server/...` suivent les nouveaux domaines.
