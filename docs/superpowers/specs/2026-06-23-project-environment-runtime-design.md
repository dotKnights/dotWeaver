# Project environment runtime -- Design

**Date** : 2026-06-23
**Statut** : Valide en brainstorming, en attente de relecture
**Perimetre** : v1 -- config runtime durable, detection modulaire, prepare step et caches durables

## Objectif

Harmoniser la facon dont dotWeaver prepare et execute les runs d'un projet en
ajoutant une source de verite durable pour l'environnement projet. Cette couche
decrit le runtime, le package manager, les commandes utiles, l'etat de
preparation et les caches a reutiliser entre runs.

La v1 ne cree pas encore de services persistants comme Postgres ou Redis, ne
construit pas d'image Docker par projet et ne persiste pas `node_modules` ou un
virtualenv complet. Elle pose le socle pour que les agents travaillent dans un
environnement previsible, rapide a preparer et extensible vers d'autres stacks.

## Decisions de cadrage

| Sujet | Decision |
| --- | --- |
| Modele produit | Un profil unique `default` par projet en v1 |
| Detection | Automatique, puis validation humaine |
| Runtime v1 | Node.js, Python, Custom |
| Extensibilite | Adapters runtime modulaires |
| Preparation | Commande d'installation executee avant l'agent si necessaire |
| Prepare hors run | Action dediee `Prepare environment` |
| Caches | Caches de dependances par projet, pas de dossiers installes persistants |
| Import GitHub | Detection et proposition possibles, pas d'installation automatique |
| Secrets | Aucune valeur secrete dans snapshots, logs persistants ou fingerprints |

## Contexte actuel

dotWeaver sait deja importer un repo GitHub, lancer des agents Claude Code ou
Codex dans Docker, materialiser la config agent projet et conserver les
workspaces de run pour la reprise.

La config projet actuelle couvre :

- serveurs MCP ;
- skills ;
- secrets MCP ;
- variables d'environnement chiffrees ;
- materialisation `.mcp.json`, `.claude`, `.agents` et `.env` au moment du run.

La piece manquante est une couche explicite qui dit comment le projet doit etre
prepare : runtime, package manager, commandes, caches, statut de readiness et
diagnostics. Aujourd'hui, l'agent doit souvent deviner lui-meme s'il faut lancer
`bun install`, `npm install`, `pip install`, ou autre.

## Approches envisagees

### Option A -- Config durable seulement

dotWeaver stocke runtime, package manager et commandes, mais le runner ne les
execute pas automatiquement. C'est simple, mais les runs restent peu
deterministes car l'agent doit encore preparer l'environnement lui-meme.

### Option B -- Config, prepare step et caches durables

dotWeaver stocke la config, monte des caches durables et execute la commande
d'installation avant l'agent quand le profil le demande. C'est l'option retenue :
elle ameliore la fiabilite et la vitesse sans introduire la complexite des
images par projet.

### Option C -- Image ou volume prepare par projet

dotWeaver maintient un environnement presque pret a l'emploi par projet. C'est
puissant, mais lourd pour la v1 : invalidation, stockage, securite, rebuilds et
compatibilite multi-runtime deviennent des sujets centraux.

## Architecture

Ajouter un domaine serveur `project-environments` separe de
`project-agent-config`. Le premier decrit comment preparer le repo, le second
continue de decrire ce que l'agent recoit comme contexte.

Flux de run v1 :

1. `executeRun` prepare le miroir Git et le checkout du run.
2. `materializeRunAgentConfig` ecrit MCP, skills et `.env` comme aujourd'hui.
3. `prepareRunEnvironment` verifie le profil `default`.
4. Si le profil a besoin d'etre prepare, le runner execute `installCommand` dans
   un conteneur avec caches durables montes.
5. Si la preparation reussit, l'agent est lance dans le meme checkout.
6. Le run stocke un snapshot d'environnement non secret.

Le prepare standalone reutilise la meme logique que le prepare avant run, mais
il n'attache pas d'agent et n'ecrit pas de `RunEvent`.

## Modele de donnees

### `ProjectEnvironmentProfile`

Profil d'environnement durable pour un projet. La v1 cree toujours un profil
`default`, mais le modele autorise plusieurs profils plus tard.

Champs principaux :

- `id`
- `projectId`
- `organizationId`
- `name` : `default` en v1
- `runtime` : `node | python | custom`
- `adapterId` : identifiant de l'adapter, par exemple `node`
- `adapterVersion` : version logique de l'adapter
- `packageManager` : `bun | npm | pnpm | yarn | uv | pip | poetry | custom`
- `installCommand`
- `testCommand`
- `buildCommand`
- `devCommand`
- `status` : `unconfigured | detected | ready | invalid`
- `detection` : JSON non secret, details de detection et score
- `warnings` : JSON non secret
- `currentFingerprint`
- `lastPreparedFingerprint`
- `lastPreparedAt`
- `lastPrepareStatus` : `never | running | succeeded | failed`
- `lastPrepareError`
- `createdAt`
- `updatedAt`

Contraintes :

- unique par `(projectId, name)` ;
- relation scopee par `(projectId, organizationId)` comme les autres configs
  projet ;
- un seul profil actif en v1 : `name = default`.

### `ProjectEnvironmentPrepareEvent`

Journal leger pour les preparations standalone.

Champs principaux :

- `id`
- `profileId`
- `projectId`
- `organizationId`
- `seq`
- `type` : `system | output | error | result`
- `payload` : JSON scrubbe
- `createdAt`

Ces events ne remplacent pas `RunEvent`. Ils existent pour afficher les logs de
`Prepare environment` quand aucun run agent n'existe.

### `Run`

Ajouter un champ :

- `environmentSnapshot Json?`

Ce snapshot contient runtime, package manager, commandes utilisees, adapter
version, fingerprint et decision de preparation. Il ne contient jamais de
valeurs de variables d'environnement.

## Runtime adapters

Creer une couche modulaire sous :

```text
src/lib/server/project-environments/adapters/
```

Interface conceptuelle :

```ts
type RuntimeAdapter = {
	id: string;
	label: string;
	version: string;
	detect(input: DetectionInput): DetectionResult;
	defaultCommands(input: CommandInput): EnvironmentCommands;
	cacheMounts(input: CacheInput): CacheMountSpec[];
	validate(profile: EnvironmentProfileDraft): ValidationResult;
};
```

Responsabilites :

- detecter les fichiers pertinents ;
- produire un score de confiance ;
- proposer package manager et commandes par defaut ;
- declarer les caches durables a monter ;
- valider qu'une config est executable dans l'image runner actuelle.

### Adapter Node

Detection :

- `package.json`
- `bun.lock`
- `package-lock.json`
- `pnpm-lock.yaml`
- `yarn.lock`

Selection package manager :

- `bun.lock` -> `bun`
- `pnpm-lock.yaml` -> `pnpm`
- `yarn.lock` -> `yarn`
- `package-lock.json` -> `npm`
- sinon fallback `npm`, avec warning si aucun lockfile.

Commandes par defaut :

- install : `<pm> install`
- test : script `test` si present
- build : script `build` si present
- dev : script `dev` si present

Caches :

- Bun cache pour `bun`
- npm cache pour `npm`
- pnpm store/cache pour `pnpm`
- Yarn cache pour `yarn`

### Adapter Python

Detection :

- `pyproject.toml`
- `requirements.txt`
- `uv.lock`
- `poetry.lock`

Selection package manager :

- `uv.lock` -> `uv`
- `poetry.lock` -> `poetry`
- `requirements.txt` -> `pip`
- `pyproject.toml` sans lock -> `uv` si disponible, sinon `pip` avec warning

Commandes par defaut :

- install `uv sync` pour `uv`
- install `poetry install` pour `poetry`
- install `pip install -r requirements.txt` pour `pip` si le fichier existe
- test/build/dev seulement si detectables sans ambiguite

Caches :

- cache uv
- cache pip
- cache poetry

### Adapter Custom

Toujours disponible, jamais choisi automatiquement en premier. Il permet de
saisir les commandes manuellement et de desactiver les caches automatiques.

## Detection et validation humaine

La detection peut etre lancee :

- apres import GitHub, pour creer une proposition ;
- depuis la page projet via `Re-detect` ;
- plus tard depuis l'onboarding projet.

La detection ne lance aucune commande du repo. Elle lit uniquement une liste
controlee de fichiers et produit une proposition editable.

Etat attendu :

- `unconfigured` : aucun profil valide ;
- `detected` : proposition creee mais non confirmee ;
- `ready` : utilisateur a valide la config ;
- `invalid` : config non executable ou incoherente.

La validation humaine confirme runtime, package manager et commandes. Un profil
`detected` peut etre prepare uniquement apres validation explicite ou action
equivalente dans l'onboarding futur.

## Fingerprint

Le fingerprint indique si la preparation doit etre relancee.

Inclure :

- `adapterId`
- `adapterVersion`
- `runtime`
- `packageManager`
- `installCommand`
- lockfiles pertinents et hash de contenu
- cles d'env actives, sans valeurs

Ne pas inclure :

- valeurs d'env ;
- secrets ;
- logs ;
- chemins absolus host.

Regle :

- si `lastPrepareStatus !== succeeded`, `needsPrepare = true` ;
- si `lastPreparedFingerprint !== currentFingerprint`, `needsPrepare = true` ;
- sinon `needsPrepare = false`.

## Caches durables

Les caches vivent hors repo sous `WORKSPACE_ROOT` :

```text
<WORKSPACE_ROOT>/<projectId>/cache/<profile>/<runtime>/<package-manager>/
```

Ils sont montes dans les conteneurs de preparation et de run selon les specs de
l'adapter. Les caches ne doivent pas apparaitre dans le diff, ne doivent pas etre
commites et ne doivent pas etre copies dans le checkout.

La v1 cache uniquement les stores de dependances. Elle ne persiste pas :

- `node_modules`
- `.venv`
- `vendor`
- dossiers de build

Cette limite evite les incoherences entre checkouts et garde le modele simple.

## Prepare environment standalone

Ajouter une action `prepareProjectEnvironment(profileId)` qui lance une
preparation sans agent.

Comportement :

1. verifier l'organisation et le projet ;
2. verrouiller le profil pour eviter deux preparations concurrentes ;
3. creer ou rafraichir le miroir Git ;
4. creer un checkout de preparation dedie, hors runs agent ;
5. materialiser les `ProjectEnvVar` actives dans `.env` avec la meme logique de
   protection git que les runs, sans ecrire MCP ni skills ;
6. executer `installCommand` dans Docker avec caches montes ;
7. persister les events de preparation ;
8. mettre a jour `lastPrepareStatus`, `lastPreparedAt`,
   `lastPreparedFingerprint` et `lastPrepareError`.

L'action est explicite. Elle n'est pas lancee automatiquement a l'import d'un
repo, car elle execute du code du depot et peut etre longue.

## Prepare avant run

Au lancement d'un run, le runner consulte le profil `default`.

Comportement :

- si aucun profil n'existe, continuer avec le comportement actuel et ajouter un
  warning dans `environmentSnapshot` ;
- si le profil est `invalid`, faire echouer le run avant l'agent avec un message
  clair ;
- si `needsPrepare = true`, executer `installCommand` avant l'agent ;
- si `needsPrepare = false`, sauter l'installation ;
- si `installCommand` est vide, considerer la preparation comme non requise.

Les sorties de preparation pendant un run sont ecrites dans `RunEvent` avec des
payloads systeme lisibles :

- `environment_prepare_started`
- `environment_prepare_output`
- `environment_prepare_completed`
- `environment_prepare_failed`

Si la preparation echoue, le run passe en `failed` avant de lancer l'agent.

## Runner et image

L'image runner actuelle embarque deja Node, git, curl, ripgrep, Claude Code et
Codex. La v1 doit verifier les package managers supportes avant d'executer la
commande.

Exigences :

- Bun doit etre disponible si `packageManager = bun` ;
- npm est disponible via Node ;
- pnpm/yarn/uv/poetry/pip doivent etre soit installes dans l'image, soit marques
  non disponibles par `validate(profile)` ;
- les erreurs doivent etre explicites : `Package manager uv is not available in
  the runner image`.

La v1 peut commencer avec les managers disponibles dans l'image et ajouter les
autres via une evolution du Dockerfile si necessaire.

## UI

Sur la page projet, ajouter une section compacte `Environment` avant ou a cote
de `Agent config`.

Contenu :

- runtime ;
- package manager ;
- statut ;
- indication `needs prepare` ;
- derniere preparation ;
- warnings principaux.

Actions :

- `Edit`
- `Re-detect`
- `Prepare`
- `Force prepare`

L'edition v1 reste structuree et sobre :

- select runtime ;
- select package manager ;
- champs install/test/build/dev ;
- bouton save ;
- liste de warnings.

L'onboarding projet futur reutilisera ces memes commands et composants.

## Integration avec la config agent

`ProjectAgentConfig` reste responsable de MCP, skills, secrets et env vars.
`ProjectEnvironmentProfile` reste responsable de runtime, commandes, caches et
readiness.

Au moment d'un run :

- `agentConfigSnapshot` continue de capturer MCP, skills et env vars actives ;
- `environmentSnapshot` capture l'environnement et la decision de prepare ;
- les deux snapshots sont non secrets.

Cette separation evite de melanger le contexte agent avec la preparation
technique du projet.

## Securite

Principes :

- aucune installation automatique a l'import ;
- `Prepare environment` est une action explicite ou une etape de run ;
- preparation executee dans Docker avec les memes limites de securite que les
  runs agent ;
- pas de token GitHub dans le conteneur ;
- `.env` materialise via le systeme existant et protege contre commit/diff ;
- logs et snapshots scrubbes autant que possible ;
- fingerprints sans valeurs secretes ;
- caches hors repo.

Les commandes restent du code non fiable provenant du depot ou de la
configuration utilisateur. Le prepare step doit donc etre traite comme une
execution agent sans modele : memes limites CPU/RAM/PID, timeout dedie et
kill best-effort.

## Erreurs

Cas attendus :

- detection ambigue : profil `detected` avec warnings ;
- adapter absent : fallback `custom` ;
- package manager indisponible : profil `invalid` ou prepare failed ;
- install command non zero : prepare failed, run failed avant agent ;
- lockfile change : `needsPrepare = true` ;
- prepare concurrent : une seule preparation active par profil.

Les messages doivent etre actionnables :

- `Package manager pnpm is not available in the runner image`
- `Install command failed with exit code 1`
- `Environment profile default is invalid`
- `Project environment changed since the last successful prepare`

## Tests

Unitaires :

- detection Node par lockfile ;
- detection Python par lockfile ;
- fallback Custom ;
- generation de commandes par defaut ;
- validation de package manager indisponible ;
- calcul de fingerprint sans secret ;
- comparaison `needsPrepare` ;
- mapping de cache mounts par adapter ;
- prepare standalone met a jour statut et events ;
- run prepare saute l'installation quand fingerprint identique ;
- run prepare echoue avant agent quand install echoue ;
- `environmentSnapshot` ne contient aucune valeur env.

Integration :

- checkout de preparation sur repo local ;
- execution d'une commande install triviale dans Docker ;
- reutilisation du cache host entre deux preparations ;
- verrouillage concurrent par profil.

UI/Svelte :

- affichage du statut environnement ;
- `Re-detect` remplit une proposition ;
- `Prepare` affiche les logs standalone ;
- le formulaire de run affiche un warning si l'environnement doit etre prepare.

## Hors perimetre v1

- Plusieurs profils visibles (`development`, `test`, `staging`, etc.).
- Services persistants comme Postgres, Redis ou S3 local.
- Injection automatique d'une base de donnees dans `.env`.
- Image Docker par projet.
- Persistance de `node_modules`, `.venv` ou autres dossiers installes.
- Build automatique a l'import GitHub.
- Auto-fix IA sans validation utilisateur.
- Support complet Go, Rust, PHP ou Java.

## Extension future

La suite naturelle est l'onboarding projet :

1. import GitHub ;
2. detection runtime ;
3. validation du profil ;
4. saisie/import des env vars ;
5. option `Prepare now` ;
6. premier run avec environnement deja chaud.

Les services persistants pourront ensuite s'accrocher au profil `default` :
creation d'une base, ajout des variables correspondantes dans `ProjectEnvVar`,
prepare/healthcheck, puis reutilisation par les runs.
