# Design : Project agent config for Claude Code runs

**Date** : 2026-06-13  
**Statut** : Approuve en brainstorming  
**Perimetre** : configuration projet MCP + skills + secrets nommes, projetee au runtime

## Objectif

Permettre a chaque projet dotWeaver de declarer les serveurs MCP et les skills Claude Code
que les runs doivent utiliser par defaut. La configuration est stockee dans dotWeaver, scopee
a l'organisation, puis projetee dans le checkout temporaire du run avant de lancer Claude Code.

La v1 ne modifie pas automatiquement le repo GitHub. Elle prepare toutefois un modele hybride :
dotWeaver pilote l'execution maintenant, et pourra plus tard exporter/synchroniser une version
partageable vers `.mcp.json` et `.claude/skills` sans inclure de secrets.

## Decisions cadrees

| Sujet              | Decision                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Source d'execution | dotWeaver stocke la config et la projette au runtime dans le checkout de run               |
| Mode produit       | Hybride : sync/export repo possible plus tard, hors chemin critique v1                     |
| Edition            | Editeur structure + import JSON/markdown                                                   |
| MCP v1             | Support `http`, `sse` et `stdio`                                                           |
| Skills v1          | Skills projet Claude Code sous forme de `SKILL.md` stockes en DB                           |
| Secrets            | Secrets nommes stockes dans dotWeaver, jamais inline dans la config versionnable           |
| Activation         | Config activee par defaut sur tous les runs du projet, opt-out ponctuel au lancement       |
| Profil             | Un seul profil implicite "Project default" en v1, modele extensible vers profils multiples |

## Sources techniques verifiees

- Claude Code charge les skills projet depuis `.claude/skills/<name>/SKILL.md`.
- Claude Code peut lire les MCP projet depuis `.mcp.json`; `enabledMcpjsonServers` permet
  d'approuver les serveurs issus de `.mcp.json`.
- Le SDK TypeScript accepte `settingSources`, `mcpServers`, `skills` et `strictMcpConfig`.
- Les remote functions SvelteKit conviennent aux queries/commands type-safe qui restent
  executees cote serveur et peuvent appeler les modules `$lib/server`.

References :

- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/agent-sdk/typescript
- Documentation officielle SvelteKit via MCP : `kit/remote-functions`, `kit/$app-server`,
  `kit/server-only-modules`

## Architecture

dotWeaver ajoute une configuration agent par projet, separee du modele `Project` principal.
Cette configuration contient trois familles : serveurs MCP, skills Claude Code et secrets
nommes. Elle est geree via services serveur et remote functions, avec la meme discipline
multi-tenant que les projets et runs existants.

Au lancement d'un run :

1. `startRun` enregistre `useProjectAgentConfig` sur le run, par defaut `true`.
2. `executeRun` clone/fetch le repo puis cree le checkout de run comme aujourd'hui.
3. Avant de lancer Docker, l'orchestrateur resout la configuration active du projet.
4. Il ecrit une couche Claude Code generee dans le checkout du run :
   - `.mcp.json` pour les MCP actifs ;
   - `.claude/settings.json` pour approuver les MCP projetes ;
   - `.claude/skills/<skill-name>/SKILL.md` pour les skills actifs.
5. Il injecte les valeurs secretes requises dans l'environnement du conteneur.
6. Le runner Claude Code continue de charger `settingSources: ['project']` et conserve le MCP
   interne programmatique `dotweaver` pour `AskUserQuestion`.

La config generee vit uniquement dans le checkout du run. Elle n'est pas ecrite dans le miroir
projet, pas poussee vers GitHub et pas conservee comme source de verite.

## Modele de donnees

### `ProjectMcpServer`

Serveur MCP configure sur un projet.

Champs :

- `id`
- `projectId`
- `organizationId`
- `name` unique par projet
- `transport` : `http | sse | stdio`
- `enabled`
- `config` JSON non secret
- `env` JSON de references de secrets
- `createdAt`
- `updatedAt`

`config` contient uniquement des donnees partageables :

- pour `http`/`sse` : `url`, headers non sensibles, options non secretes ;
- pour `stdio` : `command`, `args`, options non secretes.

`env` reference des secrets par nom ou id, par exemple :

```json
{
	"LINEAR_API_KEY": { "secretName": "linear_api_key" }
}
```

### `ProjectSkill`

Skill Claude Code disponible pour un projet.

Champs :

- `id`
- `projectId`
- `organizationId`
- `name` unique par projet
- `enabled`
- `description`
- `body` markdown complet du `SKILL.md`
- `source` : `manual | imported | synced`
- `createdAt`
- `updatedAt`

La v1 stocke le markdown complet pour garder le format Claude Code natif. Si l'utilisateur
fournit un corps sans frontmatter, dotWeaver peut generer un frontmatter minimal depuis
`name` et `description`.

### `ProjectSecret`

Secret nomme utilisable par les MCP du projet.

Champs :

- `id`
- `projectId`
- `organizationId`
- `name` unique par projet
- `valueEncrypted`
- `createdById`
- `createdAt`
- `updatedAt`

Les queries UI retournent uniquement les metadonnees et un indicateur d'existence. Elles ne
renvoient jamais la valeur en clair ni le ciphertext.

### `Run`

Ajouter :

- `useProjectAgentConfig Boolean @default(true)`
- `agentConfigSnapshot Json?`

`agentConfigSnapshot` ne contient jamais de secret. Il capture les noms/ids/versions actives des
MCP et skills utilises par le run, afin de comprendre a posteriori quelle config etait active
si le projet change ensuite.

## Secrets et chiffrement

Les secrets sont chiffres avec une cle applicative, par exemple
`PROJECT_SECRET_ENCRYPTION_KEY`. Si la cle manque, les commands de creation ou remplacement de
secret refusent l'operation avec un message clair. Les runs qui exigent un secret manquant ou
indechiffrable echouent avant le lancement du conteneur.

Principes :

- aucune valeur secrete dans `.mcp.json`, `.claude/settings*.json` ou `SKILL.md` ;
- aucune valeur secrete dans `RunEvent` ou `agentConfigSnapshot` ;
- les secrets sont injectes uniquement dans l'env Docker du run ;
- un secret enregistre ne peut pas etre relu dans l'UI, seulement remplace ou supprime.

## Services serveur

Creer une couche dediee, par exemple
`src/lib/server/project-agent-config-service.ts`.

Responsabilites :

- `listProjectAgentConfigForOrg(organizationId, projectId)` : retourne MCP, skills et secrets
  masques pour l'UI.
- `upsertProjectMcpServerForOrg(...)`, `deleteProjectMcpServerForOrg(...)`,
  `setProjectMcpServerEnabledForOrg(...)`.
- `upsertProjectSkillForOrg(...)`, `deleteProjectSkillForOrg(...)`,
  `setProjectSkillEnabledForOrg(...)`.
- `upsertProjectSecretForOrg(...)`, `deleteProjectSecretForOrg(...)`.
- `buildRunAgentConfig(organizationId, projectId, { useProjectAgentConfig })` :
  retourne la projection non secrete, les valeurs d'env a injecter et le snapshot du run.
- `materializeRunAgentConfig(checkoutPath, projection)` :
  ecrit les fichiers Claude Code dans le checkout.

Ces services doivent verifier que le projet appartient a `organizationId`. Les remote functions
continuent d'utiliser `requireActiveOrg(headers)`.

## Validation

Creer `src/lib/schemas/project-agent-config.ts`.

Regles principales :

- noms MCP, skill et secret stricts : lettres, chiffres, `_`, `-`, pas d'espace ;
- transport MCP limite a `http | sse | stdio` ;
- `http`/`sse` exige `url` ;
- `stdio` exige `command`; `args` est un tableau optionnel ;
- valeurs sensibles refusees dans `config`/headers non secrets ;
- toute cle ressemblant a `authorization`, `token`, `api_key`, `secret`, `password` doit passer
  par une reference `ProjectSecret` ;
- references de secrets resolues fail-closed : absent, supprime ou hors projet = erreur ;
- skill body sans frontmatter peut etre normalise avec un frontmatter minimal.

Les erreurs doivent etre exploitables dans l'UI et dans le run :

- "MCP `linear` references missing secret `linear_api_key`"
- "MCP `github` has a sensitive header; store it as a project secret"
- "Skill name must contain only letters, numbers, `_` and `-`"

## Remote functions

Ajouter un fichier remote dedie, par exemple
`src/lib/rfc/project-agent-config.remote.ts`.

Queries :

- `getProjectAgentConfig(projectId)`

Commands :

- `upsertProjectMcpServer(input)`
- `deleteProjectMcpServer({ projectId, id })`
- `setProjectMcpServerEnabled({ projectId, id, enabled })`
- `upsertProjectSkill(input)`
- `deleteProjectSkill({ projectId, id })`
- `setProjectSkillEnabled({ projectId, id, enabled })`
- `upsertProjectSecret({ projectId, name, value })`
- `deleteProjectSecret({ projectId, id })`
- `importProjectMcpJson({ projectId, json })`
- `importProjectSkillMarkdown({ projectId, name?, markdown })`

Chaque command refresh `getProjectAgentConfig(projectId)` et, si necessaire, `getProject(projectId)`.

## UI

La page projet ajoute une zone `Agent config` sous les metadonnees repo et avant le formulaire de
run. Elle reste compacte et orientee operation :

### MCP

- Liste des serveurs avec nom, transport, statut enabled/disabled.
- Badges de probleme : secret manquant, config invalide, stdio potentiellement indisponible.
- Actions : ajouter, editer, activer/desactiver, supprimer, importer depuis `.mcp.json`.
- Formulaire structure :
  - nom ;
  - transport ;
  - URL pour `http`/`sse` ;
  - command + args pour `stdio` ;
  - headers/env avec choix entre valeur publique et reference secret.

### Skills

- Liste des skills avec nom, description, source et statut.
- Actions : ajouter, editer markdown, activer/desactiver, supprimer, importer markdown.
- Editeur v1 simple : textarea markdown, nom, description. Pas d'editeur riche.

### Secrets

- Liste des noms de secrets, jamais les valeurs.
- Actions : creer/remplacer, supprimer.
- Apres enregistrement, la valeur ne peut pas etre affichee.

### Lancement de run

Le formulaire `Run an agent` ajoute `Use project agent config`, active par defaut. Si l'utilisateur
desactive l'option, le run ignore MCP, skills et secrets dotWeaver, mais continue d'utiliser le
MCP interne `AskUserQuestion`.

Si la config active a des erreurs bloquantes, `startRun` refuse avec un message clair quand
`useProjectAgentConfig` vaut `true`. `executeRun` revalide aussi par securite et marque le run
`failed` avant Docker si la config est devenue invalide entre l'enqueue et l'execution.

## Import et export

### Import `.mcp.json`

L'import parse un JSON compatible Claude Code :

- chaque entree devient un `ProjectMcpServer` desactive ou actif selon le choix UI ;
- les champs clairement sensibles sont convertis en references de secrets a creer/remplacer ;
- les valeurs non sensibles restent dans `config`.

La v1 peut commencer par un textarea "Paste `.mcp.json`" plutot qu'un scan automatique du repo.

### Import skill markdown

La v1 accepte un `SKILL.md` colle dans l'UI. dotWeaver extrait ou demande `name` et `description`,
puis cree un `ProjectSkill`.

Le scan automatique du repo (`.claude/skills/**/SKILL.md`) est une extension naturelle, mais pas
necessaire pour livrer la v1.

### Export/sync repo

Hors chemin critique v1. Le modele doit toutefois permettre un futur bouton "Export config to
repo" qui genere :

- `.mcp.json` avec references symboliques, sans valeurs secretes ;
- `.claude/skills/<name>/SKILL.md` ;
- eventuellement `.claude/settings.json` avec `enabledMcpjsonServers`.

## Runner

`executeRun` evolue sans changer le cycle de vie global :

1. charger le run avec `project` ;
2. preparer le miroir et le checkout ;
3. si `useProjectAgentConfig`, construire et materialiser la config agent ;
4. ajouter les variables secretes resolues a l'env Docker ;
5. lancer `runContainer` comme aujourd'hui.

Le conteneur garde :

- `settingSources: ['project']` pour charger CLAUDE.md, `.mcp.json`, `.claude/settings.json`
  et `.claude/skills` depuis le checkout ;
- `mcpServers: { dotweaver: askUserQuestionServer }` pour le MCP interne ;
- `toolAliases: { AskUserQuestion: 'mcp__dotweaver__AskUserQuestion' }`.

`strictMcpConfig` reste `false` en v1 afin que Claude Code combine les MCP projetes et le MCP
interne programmatique. Si un conflit de nom apparait, dotWeaver reserve le nom `dotweaver`.

## Securite

Garde-fous v1 :

- tous les acces sont scopes par `organizationId` et `projectId` ;
- les noms de skills et MCP sont nettoyes pour eviter path traversal ;
- les fichiers generes sont ecrits uniquement sous le checkout du run ;
- les secrets ne quittent jamais la couche serveur sauf en env Docker ;
- les erreurs de validation echouent avant le conteneur ;
- le snapshot de run ne contient aucune valeur secrete ;
- les logs et `RunEvent` ne serialisent pas l'env injecte.

Limitations connues :

- un MCP `stdio` peut echouer si sa commande n'existe pas dans l'image runner ;
- un MCP remote peut necessiter l'egress reseau du conteneur ;
- les valeurs secretes existent dans l'environnement du processus MCP/Claude Code pendant le run.

## Tests

### Unitaires schemas

- accepte MCP `http`, `sse`, `stdio` valides ;
- rejette noms invalides ;
- rejette URL absente pour `http`/`sse` ;
- rejette command absente pour `stdio` ;
- force les cles sensibles vers des references de secrets ;
- normalise ou rejette un skill markdown invalide.

### Unitaires services

- liste la config uniquement pour un projet de l'organisation ;
- masque les secrets ;
- resout les secrets pour la projection runtime ;
- echoue si un secret requis manque ;
- genere un snapshot non secret ;
- refuse le nom reserve `dotweaver`.

### Generation de fichiers runtime

Sur un tmpdir :

- ecrit `.mcp.json` valide ;
- ecrit `.claude/settings.json` avec `enabledMcpjsonServers` ;
- ecrit `.claude/skills/<name>/SKILL.md` ;
- n'ecrit jamais les valeurs secretes.

### Orchestrateur

- un run avec config active materialise la config avant `runContainer` ;
- l'env Docker contient les secrets resolus ;
- un run avec opt-out n'appelle pas la materialisation ;
- une config invalide marque le run `failed` avant Docker.

### UI et Svelte

- `bun run check` doit passer ;
- si la page projet devient substantielle, ajouter des tests unitaires de helpers UI ou un
  scenario Playwright cible ;
- utiliser `svelte-autofixer` sur les composants Svelte modifies jusqu'a 0 issue.

## Hors perimetre v1

- profils multiples par projet ;
- scan automatique complet du repo pour importer toutes les skills ;
- sync/export repo avec commit ou PR ;
- marketplace de MCP/skills ;
- installation automatique de binaires `stdio` dans l'image runner ;
- audit UI avance des usages secrets par run.

## Plan de migration incrementale

1. Ajouter schemas et services de validation/projection sans UI.
2. Ajouter migration Prisma + tests de services.
3. Integrer `useProjectAgentConfig` dans `startRun` et `executeRun`.
4. Ajouter l'UI projet pour MCP, skills, secrets et opt-out run.
5. Ajouter import `.mcp.json` et import `SKILL.md`.
6. Verifier un run manuel avec un MCP simple et un skill minimal.
