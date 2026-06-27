# Project environment service env mapping -- Design

**Date** : 2026-06-25
**Statut** : Valide en brainstorming, en attente de relecture
**Perimetre** : mappings editables pour les variables generees par les services

## Objectif

Permettre a chaque projet de choisir les variables d'environnement exposees par
ses services persistants. Les providers Postgres et Redis continuent de
provisionner les services et de produire des champs de connexion stables, mais
l'utilisateur peut composer les noms et valeurs finales injectees dans les
prepares et les runs agents.

Le besoin principal est de couvrir les conventions propres aux projets :
`DATABASE_URL`, `DIRECT_URL`, `POSTGRES_URL`, `DB_HOST`, `KV_URL`, etc. Un
projet ne doit pas etre force d'adopter la nomenclature par defaut de dotWeaver.

## Decisions

| Sujet         | Decision                                                              |
| ------------- | --------------------------------------------------------------------- |
| Modele        | Champs sources canoniques + mappings editables                        |
| Composition   | Templates avec placeholders, pas expressions JS                       |
| UI            | Edition manuelle par service, avec presets comme point de depart      |
| Compatibilite | Preset `standard` cree les variables actuelles par defaut             |
| Secrets       | Sensibilite deduite automatiquement des sources utilisees             |
| Stockage      | On stocke les templates, jamais les valeurs resolues en clair         |
| Injection     | Les mappings sont resolus au moment du prepare et du run              |
| Collisions    | Les variables projet manuelles restent prioritaires et sont signalees |

## Contexte

Les services d'environnement produisent aujourd'hui directement des outputs qui
sont deja des variables `.env` :

```text
DATABASE_URL
POSTGRES_HOST
POSTGRES_PORT
POSTGRES_DB
POSTGRES_USER
POSTGRES_PASSWORD
REDIS_URL
REDIS_HOST
REDIS_PORT
REDIS_PASSWORD
```

Ce modele fonctionne pour les conventions les plus communes, mais il melange
deux responsabilites :

- le provider connait les champs techniques du service ;
- le projet connait les noms de variables attendus par son code.

Le mapping doit separer ces responsabilites pour rendre le systeme modulaire.

## Approches envisagees

### Option A -- Alias simples

Chaque output service peut etre expose sous un ou plusieurs noms :
`postgres.url -> DATABASE_URL`, `postgres.url -> DIRECT_URL`,
`postgres.host -> DB_HOST`.

Cette option est simple mais insuffisante pour composer une URL a partir de
plusieurs morceaux, par exemple une URL Postgres avec un schema, un user, un
password, un host, un port et un nom de base.

### Option B -- Templates avec placeholders

Chaque variable generee a un nom et un template :

```text
DATABASE_URL=postgresql://${user}:${password}@${host}:${port}/${database}
DIRECT_URL=${url}
DB_HOST=${host}
```

Cette option est retenue. Elle est lisible, testable, assez flexible pour les
cas reels, et ne demande pas d'executer du code utilisateur.

### Option C -- Expressions programmables

L'utilisateur ecrit une expression de type `concat("postgresql://", user, ...)`
ou du JavaScript sandboxe.

Cette option est repoussee. Elle complique la validation, la securite, la
preview UI et le debug, sans apporter assez de valeur en v1.

## Modele conceptuel

Un provider expose des champs sources canoniques. Ces champs ne sont pas
necessairement des variables d'environnement finales.

Postgres expose :

```text
url
protocol
host
port
database
user
password
```

Redis expose :

```text
url
protocol
host
port
password
```

Un mapping transforme ces champs en variables injectees :

```ts
type ServiceEnvMapping = {
	key: string;
	template: string;
	enabled: boolean;
	sensitive: 'auto' | boolean;
};
```

Exemple Postgres :

```text
DATABASE_URL=postgresql://${user}:${password}@${host}:${port}/${database}
DIRECT_URL=${url}
DB_HOST=${host}
```

## Syntaxe des templates

La v1 supporte uniquement :

- du texte litteral ;
- des placeholders `${field}` ;
- des champs declares par le provider du service.

Les placeholders inconnus rendent le mapping invalide. Les noms de variables
doivent respecter les memes regles que les env vars projet existantes :
`^[A-Za-z_][A-Za-z0-9_]*$`.

Les valeurs inserees dans une URL complete doivent venir du provider quand
possible. Par exemple `${url}` reste le chemin recommande pour `DATABASE_URL`,
car le provider controle deja l'encodage du user, du password et du nom de base.
Les templates composes restent disponibles pour les projets qui veulent une
forme precise.

## Presets

Chaque provider declare un preset `standard` applique lors de la creation du
service.

Postgres `standard` :

```text
DATABASE_URL=${url}
POSTGRES_HOST=${host}
POSTGRES_PORT=${port}
POSTGRES_DB=${database}
POSTGRES_USER=${user}
POSTGRES_PASSWORD=${password}
```

Postgres `prisma` :

```text
DATABASE_URL=${url}
DIRECT_URL=${url}
```

Redis `standard` :

```text
REDIS_URL=${url}
REDIS_HOST=${host}
REDIS_PORT=${port}
REDIS_PASSWORD=${password}
```

Les presets sont des points de depart. Une fois appliques, les mappings sont
editables manuellement dans l'UI.

## Stockage

Le mapping peut etre stocke dans `ProjectEnvironmentService.config` en v1 pour
eviter une table supplementaire immediate :

```json
{
	"image": "postgres:17-alpine",
	"database": "app",
	"user": "dotweaver",
	"password": { "encrypted": true, "valueEncrypted": "..." },
	"port": 5432,
	"envMappings": [
		{
			"key": "DATABASE_URL",
			"template": "${url}",
			"enabled": true,
			"sensitive": "auto"
		}
	]
}
```

Si l'UI ou les audits deviennent plus complexes, une table dediee pourra etre
ajoutee plus tard sans changer le modele public.

## Compatibilite et migration

Les services existants peuvent ne pas avoir `config.envMappings`. Dans ce cas,
le resolver applique le preset `standard` du provider au moment de construire
les variables runtime. Cela evite une migration obligatoire pour les services
deja provisionnes.

Lorsqu'un utilisateur ouvre l'UI et sauvegarde explicitement les mappings, le
preset implicite devient une configuration persistante dans `envMappings`.

Le stockage actuel `outputs` reste le lieu des valeurs de connexion chiffrees ou
non sensibles produites par le provider. Le nouveau module ajoute une etape de
projection :

```text
stored service outputs -> canonical source fields -> env mappings -> runtime env vars
```

Les clefs historiques (`DATABASE_URL`, `POSTGRES_HOST`, etc.) restent produites
par le preset `standard`, afin que les agents et prepares existants continuent
de fonctionner sans changement utilisateur.

## Resolution runtime

Le flux de resolution devient :

1. le provider construit les champs sources du service ;
2. le module de mapping valide et resout les templates actives ;
3. les variables resolues sont injectees dans le prepare et les runs ;
4. les env vars projet manuelles sont appliquees ensuite et peuvent ecraser les
   variables service ;
5. les secrets internes runner/MCP restent appliques en dernier.

L'ordre garde la priorite actuelle des variables projet manuelles, tout en
permettant aux services de fournir des valeurs par defaut utiles.

## Sensibilite et masquage

Un champ source declare s'il est sensible. Pour Postgres, `password` et `url`
sont sensibles. Pour Redis, `password` et `url` sont sensibles.

Quand `sensitive` vaut `auto`, une variable generee devient sensible si son
template utilise au moins une source sensible. L'utilisateur peut forcer
`sensitive: true`, mais ne peut pas forcer `false` si une source sensible est
utilisee.

Les previews UI masquent les segments sensibles :

```text
DATABASE_URL=postgresql://dotweaver:masked@dotweaver-p-...:5432/app
```

## UI

Dans la carte d'un service, ajouter une section `Environment variables`.

Chaque ligne affiche :

- un toggle enabled ;
- le nom de variable ;
- le template ;
- une preview masquee ;
- un indicateur sensible/non sensible ;
- un warning en cas de collision.

Actions :

- `Add variable` ;
- `Duplicate` ;
- `Disable` ;
- `Delete` ;
- `Reset to preset` ;
- `Insert field` avec les champs supportes par le provider.

La premiere version peut utiliser un champ texte pour le template et un menu
`Insert field`. Une UI avec chips visuelles pourra arriver ensuite.

## Collisions

Les collisions sont detectees contre :

- les autres mappings actifs du meme profil ;
- les variables projet manuelles actives ;
- les noms reserves du runner (`RUN_PROMPT`, `RUN_AGENT`, etc.).

Une collision entre deux mappings service actifs est une erreur de validation.
Une collision avec une variable projet manuelle est autorisee mais affiche un
warning, car la variable manuelle garde la priorite.

## Erreurs

Les erreurs de validation doivent etre precises :

- nom de variable invalide ;
- placeholder inconnu ;
- template vide ;
- mapping duplique ;
- tentative de rendre non sensible une variable issue d'une source sensible.

Un service `ready` avec un mapping invalide ne doit pas etre injecte
silencieusement. Le prepare/run doit echouer avec une erreur actionnable, et
l'UI doit permettre de corriger le mapping.

## Tests

Tests unitaires a couvrir :

- resolution de template simple ;
- resolution de template compose ;
- source sensible qui rend la variable sensible ;
- placeholder inconnu ;
- collision entre mappings ;
- collision avec env var projet manuelle ;
- presets Postgres et Redis ;
- compatibilite avec les outputs actuels ;
- injection dans prepare ;
- injection dans run agent et resume.

Un test d'integration local pourra provisionner Postgres, definir
`DIRECT_URL=${url}`, lancer une run, puis verifier que l'agent voit
`DATABASE_URL` et `DIRECT_URL` sans afficher leurs valeurs.

## Hors scope v1

- expressions JavaScript ou fonctions custom ;
- edition visuelle par chips obligatoire ;
- services externes non provisionnes par Docker ;
- transformation avancee de valeurs (`urlencode`, `lowercase`, `json`) ;
- mapping global partage entre plusieurs projets.

Ces extensions restent compatibles avec le modele, mais ne sont pas necessaires
pour la premiere version.
