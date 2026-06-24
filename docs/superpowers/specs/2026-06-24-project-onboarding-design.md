# Project onboarding -- Design

**Date** : 2026-06-24
**Statut** : Valide en brainstorming, en attente de relecture
**Perimetre** : v1 -- onboarding dedie apres import GitHub, setup environnement guide

## Objectif

Ajouter une page dediee `/projects/:id/setup` pour guider le setup initial d'un
projet apres son import GitHub. L'objectif est que l'utilisateur configure et
prepare l'environnement une fois, avant que les agents commencent a travailler,
au lieu que chaque run doive improviser ou relancer l'installation.

La v1 s'appuie sur le socle deja en place :

- detection runtime/package manager ;
- profil `ProjectEnvironmentProfile` durable ;
- preparation standalone en queue ;
- template prepare reutilisable par les runs ;
- logs et statuts live via `LISTEN/NOTIFY` + SSE.

La v1 ne cree pas encore de services persistants comme Postgres, Redis ou S3
local. Elle doit cependant presenter l'interface comme une checklist modulaire
pour pouvoir ajouter ces modules sans refondre le parcours.

## Decisions de cadrage

| Sujet | Decision |
| --- | --- |
| Route | Nouvelle page `/projects/:id/setup` |
| Declenchement | Redirection automatique apres import GitHub |
| Modele UI | Checklist modulaire avec progression guidee |
| Parcours principal | Detect -> Configure -> Prepare -> Open project |
| Blocage des runs | Bloquant seulement si une commande d'installation est configuree et non preparee |
| Skip | Autorise si aucune commande d'installation n'est requise, ou avec warning explicite |
| Source de verite | DB et profil environnement, pas l'etat local du navigateur |
| Live updates | Reutiliser le stream SSE d'environnement prepare |
| Services persistants | Hors scope v1, mais emplacement reserve dans la checklist |

## Contexte actuel

La page `/projects` permet deja d'importer un depot GitHub depuis la liste des
repos accessibles. Apres import, l'utilisateur reste sur la liste de projets et
peut ouvrir la page projet.

La page projet contient deja :

- les details du repo ;
- le panneau `EnvironmentPanel` ;
- la config agent projet ;
- le formulaire de lancement de run ;
- la liste des runs.

Cette page fonctionne pour gerer un projet existant, mais elle n'est pas ideale
pour un premier setup. L'utilisateur doit comprendre seul qu'il faut detecter,
configurer puis preparer l'environnement avant de lancer un agent.

## Approches envisagees

### Option A -- Wizard lineaire

Afficher un wizard strict avec des etapes sequentielles : detection,
configuration, preparation, fin.

Avantage : tres clair pour une v1.
Limite : moins adapte a l'ajout futur de modules optionnels comme database,
Redis ou preview server.

### Option B -- Checklist modulaire guidee

Afficher une page setup composee de blocs independants :

- Runtime ;
- Environment variables ;
- Services ;
- Prepare ;
- Ready.

Chaque bloc possede son propre etat et son propre CTA, tandis qu'un CTA
principal guide l'utilisateur dans l'ordre recommande.

Option retenue : elle reste simple a utiliser maintenant et pose une structure
modulaire pour les prochains modules.

### Option C -- Setup pilote par IA

Faire analyser le repo par une IA qui propose runtime, commandes, services et
variables d'environnement, puis demande validation.

Avantage : experience proche des cloud agents modernes.
Limite : trop tot pour la v1. Il faut d'abord stabiliser le stockage, les
etats, le flow et les points d'extension.

## Parcours utilisateur

### Import GitHub

Quand `importProject` reussit, l'UI redirige vers :

```text
/projects/:projectId/setup
```

Le panneau d'import se ferme implicitement car l'utilisateur quitte la page.

### Setup initial

La page setup charge :

- le projet ;
- le profil environnement `default` ;
- les derniers events de preparation ;
- le stream SSE live si un profil existe.

Si aucun profil environnement n'existe encore, le premier bloc affiche un CTA
`Detect environment`.

Apres detection, la page affiche les informations detectees :

- runtime ;
- package manager ;
- install command ;
- test/build/dev commands si presentes ;
- warnings de detection.

L'utilisateur peut editer ces valeurs avant preparation.

### Preparation

Si `installCommand` est non vide, l'etape `Prepare` est requise. Le bouton
`Prepare environment` enqueue la preparation existante. Les logs et statuts se
mettent a jour en direct via le stream SSE.

La page considere l'environnement pret quand :

- `status = ready` ;
- `lastPrepareStatus = succeeded` ;
- `currentFingerprint = lastPreparedFingerprint`.

Quand ces conditions sont remplies, le CTA principal devient `Open project`.

### Projet sans commande d'installation

Si `installCommand` est vide, la preparation est optionnelle. La page affiche
que le projet peut etre ouvert sans prepare step. Le CTA principal devient
`Open project`, avec un texte indiquant que l'environnement ne necessite pas
d'installation.

### Projet incomplet ou invalide

Si la detection echoue ou produit un profil invalide, l'utilisateur peut :

- modifier la configuration manuellement ;
- relancer la detection ;
- ouvrir le projet avec warning si aucun prepare obligatoire ne peut etre
  determine.

Le skip ne doit pas masquer l'etat : la page projet continuera d'afficher les
warnings environnement.

## Architecture UI

### Nouvelle route

Ajouter :

```text
src/routes/(app)/projects/[id]/setup/+page.svelte
```

La page reutilise les remote functions existantes :

- `getProject` ;
- `getProjectEnvironment` ;
- `getProjectEnvironmentPrepareEvents` ;
- `detectProjectEnvironment` ;
- `saveProjectEnvironment` ;
- `prepareProjectEnvironment`.

Elle reutilise aussi le endpoint SSE :

```text
/api/projects/:id/environment/:profileId/events
```

### Composants

La v1 peut commencer avec des composants locaux a la page, puis extraire quand
le pattern se stabilise.

Composants conceptuels :

- `SetupStepCard` : bloc checklist avec status, titre, description, action ;
- `RuntimeSetupSection` : detection et edition runtime/commands ;
- `EnvVarsSetupSection` : resume des variables d'environnement et lien vers la
  config existante ;
- `ServicesSetupSection` : bloc vide en v1, avec etat et emplacement stables
  pour modules futurs ;
- `PrepareSetupSection` : prepare button, status et logs live ;
- `SetupFooter` : CTA principal `Detect`, `Prepare` ou `Open project`.

Pour rester scope v1, `EnvironmentPanel` et `EnvironmentEditor` peuvent etre
reutilises dans la page setup si cela reduit la duplication. Si leur surface est
trop orientee "page projet", extraire seulement les helpers de calcul d'etat
dans un module partage.

## Regles de statut

### Runtime step

- `todo` : aucun profil environnement ;
- `ready` : profil detecte ou configure ;
- `warning` : profil detecte avec warnings ;
- `failed` : detection impossible ou profil invalide.

### Env vars step

- `ready` : aucune action requise en v1 ;
- `warning` : warnings connus sur variables d'environnement ;
- extensible plus tard pour variables requises detectees.

### Services step

- `ready` en v1 avec texte "No services configured" ;
- reserve pour ajouter database/Redis/autres modules.

### Prepare step

- `optional` : `installCommand` vide ;
- `todo` : install command presente et jamais preparee ;
- `running` : `lastPrepareStatus = running` ;
- `ready` : profil pret et fingerprint courant prepare ;
- `failed` : derniere preparation echouee ;
- `stale` : fingerprint courant different du dernier fingerprint prepare.

## Data flow

```text
Import repository
  -> importProject command
  -> project row created/upserted
  -> UI goto /projects/:id/setup

Setup page
  -> getProject + getProjectEnvironment
  -> user clicks Detect if needed
  -> detectProjectEnvironment command
  -> user edits and saves config if needed
  -> prepareProjectEnvironment command
  -> queue job executes prepare
  -> prepare writes DB events/profile updates
  -> pg_notify
  -> SSE endpoint relays canonical DB state
  -> setup page updates live
  -> Open project
```

## Run gating

La page setup est l'experience principale, mais le backend reste la protection
finale. Les runs ne doivent pas utiliser un environnement stale ou non prepare
quand une commande d'installation est configuree.

La page projet peut afficher un warning si :

- aucun profil n'existe ;
- le profil a besoin d'etre prepare ;
- la derniere preparation a echoue ;
- le profil est invalide.

Ce warning peut pointer vers `/projects/:id/setup`.

## Error handling

- Erreur d'import : rester sur `/projects`, afficher l'erreur existante.
- Erreur de detection : afficher dans le bloc Runtime, conserver les valeurs
  existantes si presentes.
- Erreur de save : afficher dans le bloc Runtime.
- Erreur de prepare enqueue : afficher dans le bloc Prepare.
- Erreur pendant prepare : affichee via events + `lastPrepareError`.
- Deconnexion SSE : laisser `EventSource` reconnecter automatiquement ; la DB
  reste source de verite.

## Tests

### Unit / component

- Apres import reussi, la page `/projects` redirige vers `/projects/:id/setup`.
- La page setup affiche `Detect environment` quand aucun profil n'existe.
- La page setup affiche `Prepare environment` quand un install command est
  present et non prepare.
- La page setup affiche `Open project` quand le profil est ready.
- La page setup considere la preparation optionnelle si `installCommand` est
  vide.
- Les events live fusionnent avec les events charges initialement, sans doublon.

### Server

- Les remote functions existantes restent la source de verite.
- Aucun run ne contourne les regles existantes de preparation obligatoire.

### Verification manuelle

- Importer un repo Node/Bun.
- Arriver automatiquement sur `/setup`.
- Detecter/configurer.
- Preparer et voir les logs/status sans refresh.
- Ouvrir le projet et lancer un run qui reutilise le template prepare.

## Hors scope v1

- Creation de database/Redis/service persistant.
- Detection IA automatique.
- Wizard multi-profils.
- Preview server/dev server persistant.
- Migration du stream des runs vers `LISTEN/NOTIFY`.

## Criteres de succes

- Un projet importe amene naturellement l'utilisateur au setup.
- L'utilisateur comprend quoi faire avant de lancer un agent.
- Un projet avec install command ne pousse pas l'utilisateur vers un run avant
  preparation reussie.
- Les logs/status de preparation sont reactifs sans refresh.
- La structure UI accepte un futur bloc `Services` sans refonte.
