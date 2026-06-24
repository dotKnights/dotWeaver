# Project environment services -- Design

**Date** : 2026-06-24
**Statut** : Valide en brainstorming, en attente de relecture
**Perimetre** : v3 -- services d'environnement modulaires, Postgres et Redis

## Objectif

Ajouter un systeme modulaire de services persistants attaches a un projet, afin
qu'un onboarding puisse provisionner Postgres et Redis une seule fois, injecter
leurs variables dans l'environnement projet, puis les reutiliser dans tous les
runs suivants.

Le but est de rapprocher dotWeaver d'une experience cloud agent complete :
l'utilisateur importe un projet, configure runtime + variables + services, puis
les agents demarrent dans un environnement deja pret et connecte aux services
necessaires.

## Decisions

| Sujet | Decision |
| --- | --- |
| Services v1 | Postgres et Redis |
| Mode de provisionnement | Docker local automatique avec volumes persistants |
| Portee | Services durables par projet et profil d'environnement |
| Isolation | Pas de service cree par run en v1 |
| Extensibilite | Providers modulaires avec interface commune |
| Variables | Generees par provider puis materialisees dans `.env` |
| Secrets | Valeurs sensibles chiffrees ou stockees dans un champ prive |
| Fingerprint | Les services actifs participent a l'invalidation du template |
| Services externes | Hors scope v1, mais modele pret a les accueillir |

## Contexte

Le socle actuel couvre deja :

- un profil `ProjectEnvironmentProfile` par projet ;
- la detection runtime/package manager ;
- une preparation durable dans un template ;
- l'hydratation des runs depuis ce template ;
- la materialisation des variables projet dans `.env` ;
- une page setup avec checklist modulaire ;
- des updates live pour la preparation d'environnement.

La checklist contient deja une etape `Services`, mais elle affiche seulement
`No services configured`. Cette iteration transforme cette reservation UI en
vrai module d'environnement.

## Approches envisagees

### Option A -- Services Docker provisionnes par dotWeaver

dotWeaver cree et gere les conteneurs, volumes et variables de connexion. C'est
l'option retenue pour la v1 parce qu'elle donne une experience complete :
ajouter Postgres ou Redis suffit pour que les prochains agents aient un service
durable disponible.

### Option B -- URLs externes uniquement

dotWeaver stocke seulement des URLs fournies par l'utilisateur, comme
`DATABASE_URL` ou `REDIS_URL`. Cette option est plus simple, mais elle ne resout
pas le besoin principal : provisionner un environnement reutilisable sans travail
manuel externe.

### Option C -- Hybride complet

Supporter a la fois provisionnement Docker et services externes dans la meme
iteration. Cette option est plus puissante, mais elle double la surface UI/API
et complexifie la validation. Le modele restera compatible, mais l'UI externe
arrivera plus tard.

## Modele conceptuel

Un service d'environnement est un module rattache a un projet et a un profil :

- `kind` : `postgres` ou `redis` ;
- `name` : nom utilisateur stable, unique dans le projet ;
- `status` : etat de provisionnement ;
- `enabled` : determine si le service est injecte dans les runs ;
- `config` : configuration non sensible ;
- `runtime` : metadata Docker et healthcheck ;
- `outputs` : variables produites, avec distinction sensible/non sensible ;
- `lastError` : erreur de provision/start/healthcheck si applicable.

Le systeme doit etre concu pour ajouter plus tard `mysql`, `s3`, `meilisearch`,
`rabbitmq` ou un provider `external` sans changer l'orchestrateur des runs.

## Schema Prisma

Ajouter deux modeles :

```prisma
enum ProjectEnvironmentServiceKind {
  postgres
  redis
}

enum ProjectEnvironmentServiceStatus {
  configured
  provisioning
  ready
  failed
  disabled
}

enum ProjectEnvironmentServiceEventType {
  system
  output
  error
  result
}

model ProjectEnvironmentService {
  id             String                          @id @default(cuid())
  projectId      String
  project        Project                         @relation(fields: [projectId, organizationId], references: [id, organizationId], onDelete: Cascade)
  organizationId String
  profileId      String
  profile        ProjectEnvironmentProfile       @relation(fields: [profileId], references: [id], onDelete: Cascade)
  kind           ProjectEnvironmentServiceKind
  name           String
  enabled        Boolean                         @default(true)
  status         ProjectEnvironmentServiceStatus @default(configured)
  config         Json                            @default("{}")
  outputs        Json                            @default("[]")
  runtime        Json                            @default("{}")
  lastError      String?
  lastReadyAt    DateTime?
  createdById    String
  createdBy      User                            @relation(fields: [createdById], references: [id], onDelete: Cascade)
  createdAt      DateTime                        @default(now())
  updatedAt      DateTime                        @updatedAt
  events         ProjectEnvironmentServiceEvent[]

  @@unique([projectId, name])
  @@index([organizationId, projectId, profileId])
  @@map("project_environment_service")
}

model ProjectEnvironmentServiceEvent {
  id             String                             @id @default(cuid())
  serviceId      String
  service        ProjectEnvironmentService          @relation(fields: [serviceId], references: [id], onDelete: Cascade)
  projectId      String
  organizationId String
  seq            Int
  type           ProjectEnvironmentServiceEventType
  payload        Json
  createdAt      DateTime                           @default(now())

  @@unique([serviceId, seq])
  @@index([organizationId, projectId, serviceId])
  @@map("project_environment_service_event")
}
```

`outputs` contient des descriptors, pas uniquement des strings, pour pouvoir
representer proprement les collisions, la sensibilite et les origines. Les
valeurs sensibles sont chiffrees dans le domaine service et ne sont jamais
stockees en clair :

```ts
type ServiceOutput =
	| {
			key: string;
			value: string;
			sensitive: false;
			description?: string;
	  }
	| {
			key: string;
			valueEncrypted: string;
			sensitive: true;
			description?: string;
	  };
```

Le builder runtime dechiffre uniquement au moment de materialiser le `.env`.
Les variables service ne sont pas ecrites en `ProjectEnvVar`, afin de garder une
frontiere claire entre :

```ts
type ProjectEnvVarSource = {
	kind: 'manual';
	key: string;
	value: string;
};

type ProjectEnvironmentServiceOutputSource = {
	kind: 'service';
	serviceId: string;
	key: string;
	value: string;
};
```

## Interface provider

Chaque provider expose une interface stable :

```ts
type EnvironmentServiceProvider = {
	kind: 'postgres' | 'redis';
	defaultName: string;
	defaultConfig(input: ProviderDefaultsInput): Record<string, unknown>;
	validateConfig(config: unknown): ProviderValidation;
	provision(input: ProvisionServiceInput): Promise<ProvisionServiceResult>;
	start(input: StartServiceInput): Promise<void>;
	stop(input: StopServiceInput): Promise<void>;
	healthcheck(input: HealthcheckServiceInput): Promise<HealthcheckResult>;
	buildOutputs(input: BuildOutputsInput): ServiceOutput[];
	fingerprint(input: FingerprintServiceInput): Record<string, unknown>;
};
```

Le service metier ne connait pas les details Postgres/Redis. Il selectionne le
provider par `kind`, verifie l'acces org/project/profile, puis delegue.

## Docker lifecycle

Les providers Docker utilisent des noms deterministes et courts :

```text
dotweaver-p-<projectId>-svc-<serviceName>
dotweaver-p-<projectId>-vol-<serviceName>
```

Le provider doit :

1. creer ou reutiliser le volume ;
2. creer ou remplacer le conteneur si sa config Docker a change ;
3. demarrer le conteneur ;
4. attendre le healthcheck ;
5. produire les outputs ;
6. passer le service en `ready`.

Les conteneurs doivent etre attaches au meme reseau Docker que les agents. Si
`RUNNER_NETWORK` est defini, les services l'utilisent aussi. Sinon, dotWeaver
peut utiliser le reseau Docker par defaut en local. Une variable dediee
`ENVIRONMENT_SERVICES_NETWORK` pourra surcharger ce comportement si necessaire.

## Providers v1

### Postgres

Image par defaut : `postgres:17-alpine`.

Config par defaut :

- database : nom derive du projet, par exemple `app`;
- user : `dotweaver`;
- password : genere aleatoirement ;
- port interne : `5432`;
- pas de port hote expose par defaut.

Outputs :

- `DATABASE_URL` sensible ;
- `POSTGRES_HOST` non sensible ;
- `POSTGRES_PORT` non sensible ;
- `POSTGRES_DB` non sensible ;
- `POSTGRES_USER` non sensible ;
- `POSTGRES_PASSWORD` sensible.

Healthcheck : `pg_isready` dans le conteneur.

### Redis

Image par defaut : `redis:7-alpine`.

Config par defaut :

- password : genere aleatoirement ;
- port interne : `6379`;
- persistence AOF activee pour garder l'etat ;
- pas de port hote expose par defaut.

Outputs :

- `REDIS_URL` sensible ;
- `REDIS_HOST` non sensible ;
- `REDIS_PORT` non sensible ;
- `REDIS_PASSWORD` sensible.

Healthcheck : `redis-cli ping` avec auth si un password est configure.

## Cycle de vie utilisateur

### Ajouter un service

Depuis `/projects/:id/setup`, l'utilisateur clique `Add Postgres` ou `Add
Redis`. dotWeaver cree un `ProjectEnvironmentService` en `configured`, puis
lance le provisionnement en background.

Pendant le provisionnement, l'etape Services affiche `provisioning`. Quand le
healthcheck passe, le service devient `ready`.

### Prepare apres service

Ajouter, supprimer, desactiver ou modifier un service actif change le fingerprint
du profil. Le template prepare devient stale et le CTA principal redevient
`Prepare environment`.

La preparation materialise les outputs de services dans le `.env` du template.
Chaque run hydrate ensuite ce `.env` comme les autres fichiers de config projet.

### Lancer un run

Le run ne provisionne pas les services. Il consomme uniquement les services deja
prets. Si un service actif est `configured`, `provisioning` ou `failed`, le setup
reste bloque et le run ne doit pas demarrer.

Un run et le service Docker partagent le meme reseau, donc l'agent peut joindre
les services via les hostnames produits par les providers.

## Regles de fusion des variables

Les variables du `.env` final suivent cet ordre de priorite. Le premier item qui
declare une cle gagne :

1. variables manuelles du projet ;
2. outputs des services actifs ;
3. variables internes non exposees a l'utilisateur.

Les variables manuelles gagnent en cas de collision. Exemple : si l'utilisateur a
deja defini `DATABASE_URL`, l'output Postgres n'ecrase pas cette valeur. La page
setup affiche alors un warning sur le service, parce que le service existe mais
sa variable principale n'est pas celle qui sera injectee.

Les collisions ne doivent jamais exposer la valeur secrete. Les logs et events
mentionnent uniquement les cles.

## Fingerprint

Le fingerprint d'environnement doit inclure pour chaque service actif :

- kind ;
- name ;
- enabled ;
- status consommable ;
- provider version ;
- config publique pertinente ;
- cles d'outputs ;
- hash non reversible des valeurs d'outputs sensibles.

Les valeurs secretes brutes ne doivent jamais etre dans le fingerprint. Un hash
avec salt applicatif ou un hash de ciphertext stable suffit a detecter un
changement sans exposer le secret.

## API serveur

Ajouter :

```text
src/lib/server/project-environment-services/
  providers/postgres.ts
  providers/redis.ts
  providers/index.ts
  docker.ts
  service.ts
  types.ts
```

Fonctions metier principales :

- `listProjectEnvironmentServicesForOrg`
- `createProjectEnvironmentServiceForOrg`
- `provisionProjectEnvironmentServiceForOrg`
- `restartProjectEnvironmentServiceForOrg`
- `setProjectEnvironmentServiceEnabledForOrg`
- `deleteProjectEnvironmentServiceForOrg`
- `buildProjectEnvironmentServiceOutputsForOrg`

Ajouter aussi :

```text
src/lib/rfc/project-environment-services.remote.ts
```

Les remote functions exposent les actions UI et refresh les queries pertinentes :
services, environnement, events et config projet.

## UI setup

La carte `Services` de `ProjectSetupChecklist` devient un panneau actif :

- boutons `Add Postgres` et `Add Redis` ;
- liste de services avec kind, nom, status, warnings et derniere erreur ;
- variables produites affichees comme cles, valeurs masquees si sensibles ;
- actions `Provision/Start`, `Restart`, `Disable`, `Remove`.

Etat de l'etape Services :

- `ready` : aucun service configure, ou tous les services actifs sont ready ;
- `running` : au moins un service provisionne ;
- `failed` : au moins un service actif est failed ;
- `warning` : collision de variable ou service disabled ;
- `todo` : service configured mais pas encore provisionne.

`Open project` reste bloque si un service actif n'est pas consommable.

## Live updates

La v1 peut reutiliser le pattern `LISTEN/NOTIFY` + SSE deja utilise par la
preparation d'environnement :

```text
/api/projects/:id/environment-services/:serviceId/events
```

Les events doivent etre append-only et scrubbes. Les changements de status
doivent aussi refresh la liste de services cote remote query.

## Erreurs et securite

- Ne jamais logguer `DATABASE_URL`, `REDIS_URL` ou passwords.
- Ne jamais exposer de port hote par defaut.
- Les noms Docker doivent etre derives de valeurs sanitizees.
- Un service doit toujours etre scope par organizationId + projectId + profileId.
- Supprimer un service arrete le conteneur, mais la suppression du volume doit
  etre explicite plus tard ; la v1 peut conserver le volume pour eviter une perte
  de donnees accidentelle.
- Un service failed ne doit pas etre injecte dans `.env`.
- Les providers doivent etre idempotents : relancer `Provision` sur un service
  deja ready ne doit pas casser les donnees.

## Tests

Tests unitaires attendus :

- providers Postgres/Redis : config par defaut, outputs, noms Docker, healthcheck ;
- docker helpers : args `docker run`, network, volumes, env sensibles ;
- service metier : create/provision/restart/disable/delete, scope org/projet ;
- collisions env vars : variable manuelle prioritaire et warning ;
- fingerprint : changement quand un service actif change ;
- setup state : services ready/running/failed/warning bloquent ou debloquent ;
- remote functions : actions appellent le service et refresh les queries ;
- UI : ajout Postgres/Redis, liste de services, status et actions ;
- run config : `.env` recoit `DATABASE_URL` et `REDIS_URL` quand les services
  sont ready.

Smoke test manuel :

1. importer un projet Node/Bun ;
2. detecter et preparer l'environnement ;
3. ajouter Postgres et Redis depuis la page setup ;
4. attendre les deux statuts `ready` ;
5. relancer `Prepare environment` ;
6. lancer un agent qui affiche `DATABASE_URL`, `REDIS_URL` masquees et teste une
   connexion simple ;
7. redemarrer le serveur dotWeaver ;
8. verifier que les services restent utilisables par un nouveau run.

## Hors perimetre v1

- service externe renseigne par URL manuelle ;
- creation d'une database isolee par run ;
- UI de backup/restore/suppression definitive des volumes ;
- multi-profils actifs dans l'UI ;
- exposition de ports hote pour debug local ;
- migrations automatiques de schema applicatif ;
- autres services que Postgres et Redis.
