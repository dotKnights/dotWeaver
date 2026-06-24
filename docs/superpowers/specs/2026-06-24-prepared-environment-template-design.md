# Prepared environment template -- Design

**Date** : 2026-06-24
**Statut** : Valide en brainstorming, en attente de relecture
**Perimetre** : v2 -- onboarding d'environnement durable, template prepare et hydratation des runs

## Objectif

Faire en sorte qu'un projet soit installe une seule fois pendant son onboarding,
puis que les futurs agents demarrent dans un environnement deja hydrate. Les
agents ne doivent plus avoir a lancer `bun install`, `npm install`, `uv sync` ou
equivalent avant de travailler, sauf si le projet ou sa configuration
d'environnement a change.

Le modele retenu est un template d'environnement prepare par projet/profil :
dotWeaver maintient un checkout durable installe, le marque avec un fingerprint,
puis cree chaque run dans un workspace isole hydrate depuis ce template.

## Decisions

| Sujet                | Decision                                                                   |
| -------------------- | -------------------------------------------------------------------------- |
| Modele               | Template prepare durable par profil d'environnement                        |
| Isolation des agents | Chaque run garde son propre workspace                                      |
| Reutilisation        | Les artefacts installes sont copies/synchronises depuis le template        |
| Invalidation         | Fingerprint runtime + lockfiles + commande install + env keys              |
| Runs si stale        | Bloquer ou demander une preparation avant de lancer l'agent                |
| Services futurs      | Add-ons modulaires qui modifient l'environnement et invalident le template |
| Secrets              | Jamais de valeurs secretes dans fingerprints, logs ou snapshots            |

## Pourquoi pas un volume partage

Un volume `node_modules` ou `.venv` partage entre tous les runs est rapide, mais
il rend l'etat global mutable par les agents. Un agent pourrait modifier une
dependance, une branche pourrait polluer une autre, et les erreurs deviendraient
difficiles a attribuer.

Le template prepare donne le meme gain utilisateur tout en gardant une frontiere
claire : le template est une source de depart, pas le workspace de travail des
agents.

## Cycle de vie

### Onboarding

1. L'utilisateur importe un projet GitHub.
2. dotWeaver detecte le runtime, le package manager et les commandes.
3. L'utilisateur valide ou corrige la configuration.
4. dotWeaver cree ou met a jour le checkout template du profil.
5. dotWeaver materialise les variables d'environnement dans ce template.
6. dotWeaver lance la commande d'installation dans le template.
7. Si la commande reussit, le profil passe en etat prepare avec son fingerprint.

### Creation d'un run

1. dotWeaver verifie que le profil par defaut est prepare et a jour.
2. dotWeaver cree le checkout isole du run comme aujourd'hui.
3. dotWeaver hydrate le checkout depuis le template prepare.
4. dotWeaver materialise la config agent du run.
5. L'agent demarre sans etape d'installation projet.

### Invalidation

Le template devient stale si l'un de ces elements change :

- lockfiles suivis par l'adapter (`bun.lock`, `package-lock.json`, `uv.lock`, etc.) ;
- fichier manifeste si pertinent (`package.json`, `pyproject.toml`, `requirements.txt`) ;
- runtime, package manager ou commande d'installation ;
- liste des cles d'environnement exposees au projet ;
- version logique de l'adapter runtime.

Quand le template est stale, les nouveaux runs ne doivent pas essayer de
reinstaller implicitement pendant l'execution agent. Ils doivent afficher une
erreur claire ou rediriger vers l'action `Prepare environment`.

## Architecture

### Chemins persistants

Ajouter un espace dedie par profil :

```text
<workspace-root>/<projectId>/environment/<profileName>/template/
<workspace-root>/<projectId>/environment/<profileName>/metadata.json
```

Le dossier `template/` contient un checkout Git durable, les fichiers
d'environnement materialises et les artefacts installes par le package manager.
Le fichier `metadata.json` contient des informations non secretes utiles au
debug local : fingerprint, date de preparation, runtime, package manager et
commande install.

### Hydratation

Introduire un service `hydrateRunFromPreparedEnvironment` charge de copier ou
synchroniser les artefacts prepares dans le checkout du run. La v1 peut utiliser
une copie recursive simple et explicite, puis evoluer vers `rsync`, hardlinks ou
snapshots APFS plus tard.

Les artefacts a hydrater sont declares par les adapters runtime :

- Node/Bun/npm/pnpm/yarn : `node_modules` si present ;
- Python/uv/poetry/pip : `.venv` si present ;
- custom : aucun artefact par defaut.

Les caches existants restent utiles pour accelerer les prepares, mais ils ne
sont plus le mecanisme principal qui rend un run pret a l'emploi.

### Preparation

Le prepare standalone ne doit plus s'executer dans un checkout jetable. Il doit
s'executer dans le template durable. Apres succes :

- `lastPrepareStatus = succeeded` ;
- `lastPreparedFingerprint = currentFingerprint` ;
- `lastPreparedAt = now` ;
- les logs de prepare restent scrubbes ;
- les anciens events restent consultables depuis la page projet.

Si la preparation echoue, le template reste en place pour le diagnostic, mais le
profil reste non consommable par les nouveaux runs.

## Interface adapters

Etendre les adapters runtime avec une declaration d'artefacts :

```ts
type PreparedArtifactSpec = {
	path: string;
	required?: boolean;
};

type RuntimeAdapter = {
	// champs existants
	preparedArtifacts(input: AdapterProfileInput): PreparedArtifactSpec[];
};
```

Cette extension permet d'ajouter Ruby, Go, PHP, services locaux ou autres
runtimes sans disperser la logique d'hydratation dans l'orchestrateur.

## UX

La page projet garde le panneau `Environment`, mais l'etat doit devenir plus
explicite :

- `Ready` : config valide ;
- `Prepared` : template installe et fingerprint courant ;
- `Needs prepare` : config valide mais template absent ou stale ;
- `Failed` : derniere preparation echouee.

Au lancement d'un run, si l'environnement a besoin d'etre prepare, le bouton de
run doit refuser le lancement ou retourner une erreur claire : `Prepare the
project environment before starting a run`.

## Services futurs

Les add-ons comme PostgreSQL doivent s'integrer au meme cycle :

1. provisionner le service durable ;
2. ajouter ou mettre a jour les variables d'environnement chiffrees ;
3. recalculer le fingerprint ;
4. marquer le template stale ;
5. demander une nouvelle preparation/validation.

Ainsi, un service devient un module d'environnement plutot qu'une exception dans
le pipeline de run.

## Erreurs et securite

- Ne jamais copier de secrets dans `metadata.json`.
- Les logs de prepare restent scrubbes avec les variantes dotenv/JSON/multiline.
- Un run ne doit pas ecrire dans le template prepare.
- Une preparation concurrente sur le meme profil reste interdite.
- Si l'hydratation echoue, le run ne doit pas demarrer l'agent.

## Tests

Tests unitaires attendus :

- fingerprint stale/current pour les nouveaux manifestes suivis ;
- chemins template et metadata ;
- prepare execute dans le template durable ;
- hydratation copie uniquement les artefacts declares par l'adapter ;
- orchestrateur bloque les runs si le template est stale ;
- orchestrateur hydrate avant de lancer Docker ;
- UI affiche `Prepared`, `Needs prepare` et erreurs de lancement.

Smoke test manuel :

1. importer un projet Bun ;
2. lancer l'onboarding/prepare ;
3. verifier que `node_modules` existe dans le template ;
4. lancer un run diagnostic sans `bun install` ;
5. verifier que l'agent voit `node_modules: present` et peut executer un script
   du projet.

## Hors perimetre

- Construire une image Docker par projet ;
- partager un volume mutable de dependances entre runs ;
- provisionner PostgreSQL/Redis dans cette iteration ;
- optimiser l'hydratation avec snapshots filesystem ;
- gerer plusieurs profils actifs par projet dans l'UI.
