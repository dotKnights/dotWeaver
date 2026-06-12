# Design : Architecture des tests

**Date** : 2026-06-12  
**Statut** : Valide en brainstorming, en attente de relecture  
**Perimetre** : organisation des tests Vitest et Playwright hors du code fonctionnel

## Objectif

Clarifier l'architecture de tests de dotWeaver en sortant les tests des dossiers de code
fonctionnel, sans perdre la lisibilite ni la proximite logique avec les modules testes.

La v1 vise une separation pragmatique : `src/` contient l'application, `tests/` contient les
validations. Les tests restent organises par type et par domaine pour qu'un developpeur puisse
retrouver rapidement le test associe a un module.

## Decisions cadrees

| Sujet | Decision |
| --- | --- |
| Strategie | Separation pragmatique des tests hors des dossiers metier |
| Racine cible | `tests/` |
| Tests unitaires | `tests/unit/.../*.test.ts` |
| Tests d'integration | `tests/integration/.../*.integration.test.ts` |
| Tests end-to-end | `tests/e2e/.../*.e2e.ts` |
| Organisation interne | Miroir logique de `src/` par domaine, pas colocation fichier par fichier |
| Imports | Preferer les alias SvelteKit (`$lib/...`) depuis `tests/` |
| Demos scaffold | Supprimer les exemples Vitest/Playwright generes si inutiles |
| Intention des tests | Ne pas reecrire les assertions pendant la migration |

## Etat actuel

Le projet utilise deja une base technique saine :

- Vitest est configure avec deux projets : `client` en browser Playwright pour les tests Svelte,
  et `server` en environnement Node.
- Playwright est configure separement pour les tests e2e.
- Les tests couvrent plusieurs niveaux : schemas, helpers de rendu, services serveur, MCP,
  routes SvelteKit, integration filesystem/Git et parcours e2e.

Le probleme principal est architectural : les tests sont melanges au code fonctionnel dans
`src/lib/server`, `src/lib/schemas`, `src/lib/components`, `src/routes`, et quelques demos de
scaffolding restent presentes.

## Approches considerees

### A. Separation stricte par type de test

Tout deplacer sous `tests/unit`, `tests/integration` et `tests/e2e`, avec une arborescence
independante du code source. Cette option rend la separation tres visible, mais elle rend aussi
plus couteuse la recherche du test associe a un module.

### B. Separation pragmatique par type puis domaine (retenue)

Deplacer les tests sous `tests/`, puis garder un miroir logique des domaines de `src`.

Cette approche repond au besoin de ne plus melanger tests et code fonctionnel, tout en gardant
une navigation naturelle :

```text
tests/
  unit/
    lib/
      schemas/
      components/runs/
      server/
      server/mcp/
    routes/
      app/
  integration/
    lib/
      server/
      server/mcp/
  e2e/
    auth.e2e.ts
    teams.e2e.ts
    helpers/
```

### C. Colocation assumee mais normalisee

Garder les tests dans `src`, supprimer les demos et renforcer les conventions de nommage. Cette
option minimise le deplacement de fichiers, mais elle ne repond pas au besoin principal : separer
clairement les tests du code fonctionnel.

## Architecture cible

### 1. Arborescence de tests

`tests/unit` contient les tests rapides, isoles et majoritairement mockes :

- schemas Zod ;
- fonctions pures ;
- formatting et parsing ;
- services serveur avec mocks de DB, filesystem, reseau ou modules externes ;
- route loads testees en isolation.

`tests/integration` contient les tests qui exercent plusieurs composants reels ou des effets
externes controles :

- filesystem temporaire ;
- appels Git locaux ;
- endpoint MCP avec transport et auth mockee ;
- tout test dont l'objectif est de verifier le wiring entre plusieurs modules.

`tests/e2e` contient les tests Playwright qui passent par l'application servie :

- parcours auth ;
- parcours teams ;
- helpers Playwright partages.

### 2. Imports et aliases

Les tests deplaces hors de `src` utilisent les aliases publics du projet autant que possible :

- `$lib/server/runs-service` au lieu de chemins relatifs longs ;
- `$lib/schemas/auth` pour les schemas ;
- imports relatifs uniquement pour les helpers situes dans `tests/`.

Les tests de routes SvelteKit peuvent importer un fichier de route par chemin relatif depuis
`tests/` si aucun alias naturel n'existe. Ce cas reste limite et explicite.

### 3. Configuration Vitest

`vite.config.ts` garde les deux projets actuels, mais change les patterns :

- projet `client` : inclut les tests Svelte/browser sous `tests/unit/**/*.svelte.{test,spec}.{js,ts}`
  ou un pattern equivalent si des tests de composants sont conserves ;
- projet `server` : inclut `tests/unit/**/*.{test,spec}.{js,ts}` et
  `tests/integration/**/*.{test,spec}.{js,ts}` ;
- les tests e2e Playwright ne sont pas inclus dans Vitest.

`expect.requireAssertions` reste actif.

### 4. Configuration Playwright

`playwright.config.ts` pointe explicitement vers `tests/e2e` avec `testDir` ou `testMatch`.

Les helpers e2e quittent `e2e/helpers.ts` pour `tests/e2e/helpers/index.ts` ou un fichier
equivalent. Les imports des specs Playwright restent courts et locaux.

### 5. Demos et exemples

Les fichiers issus du scaffolding ne doivent pas rester dans `src` :

- `src/lib/vitest-examples/*`
- `src/routes/demo/playwright/*`

S'ils ne servent plus au produit, ils sont supprimes. Si une reference pedagogique est souhaitee
plus tard, elle pourra vivre dans une documentation ou dans `tests/examples`, mais pas dans le
code applicatif.

## Migration

La migration se fait sans changer le comportement teste :

1. creer l'arborescence `tests/` cible ;
2. deplacer les tests unitaires, integration et e2e ;
3. ajuster les imports vers `$lib` ou vers les nouveaux helpers ;
4. ajuster `vite.config.ts` et `playwright.config.ts` ;
5. supprimer les demos de scaffolding inutiles ;
6. executer `bun run test:unit`, `bun run test:e2e`, puis `bun run check` si necessaire.

La migration ne doit pas introduire de refactor applicatif. Les eventuelles faiblesses revelees
par le deplacement des tests seront traitees separement, sauf si elles bloquent l'execution.

## Gestion des risques

Les risques principaux sont lies aux imports relatifs et aux mocks hoistes par Vitest.

Pour les limiter :

- conserver l'ordre actuel des `vi.mock(...)` et des imports dynamiques ;
- privilegier des deplacements mecaniques par petits lots ;
- verifier chaque categorie de tests apres mise a jour de la config ;
- ne pas renommer les suites ou les assertions pendant le deplacement.

Les tests d'integration qui manipulent Git ou le filesystem gardent leurs repertoires temporaires
et leurs nettoyages actuels.

## Definition de fini

La refonte est terminee quand :

- aucun fichier `*.test.ts`, `*.spec.ts` ou `*.e2e.ts` ne reste dans `src/`, sauf exception
  justifiee par une contrainte Svelte explicite ;
- les demos de test generees ne polluent plus `src/` ;
- `tests/` montre clairement les niveaux `unit`, `integration` et `e2e` ;
- `bun run test:unit` passe ;
- `bun run test:e2e` passe ou, si l'environnement local bloque Playwright, l'erreur est documentee ;
- la convention est suffisamment lisible pour ajouter un nouveau test sans hesitation.
