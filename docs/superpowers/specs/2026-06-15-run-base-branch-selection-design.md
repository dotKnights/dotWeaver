# Design : Selection de branche de base pour les runs

**Date** : 2026-06-15  
**Statut** : Approuve en brainstorming  
**Perimetre** : choisir la branche de base a chaque lancement de run

## Objectif

Permettre a l'utilisateur de choisir, pour chaque run d'un projet, la branche de
base sur laquelle l'agent va travailler. Le run reste isole : dotWeaver cree
toujours une nouvelle branche agent `claude/<runId>` pour les changements, puis
ouvre une PR vers la branche de base choisie.

La v1 ne pousse jamais directement sur la branche de base. L'option "push sur la
meme branche" est volontairement hors scope pour eviter les cas de rebase,
avance concurrente et force-push.

## Decisions cadrees

| Sujet               | Decision                                                               |
| ------------------- | ---------------------------------------------------------------------- |
| Choix utilisateur   | La branche de base est selectionnee a chaque lancement de run          |
| Valeur par defaut   | `project.defaultBranch`                                                |
| Branche de travail  | Toujours `claude/<runId>`                                              |
| PR                  | `head = claude/<runId>`, `base = run.baseBranch`                       |
| Push direct         | Hors scope v1                                                          |
| Validation          | Liste serveur + revalidation au lancement                              |
| Historique          | Stocker `baseBranch` sur `Run` pour audit et PR future                 |

## Contexte actuel

Aujourd'hui, `startRun` cree un `Run` avec une branche agent `claude/<runId>`.
L'orchestrateur appelle ensuite `createRunCheckout(project.id, runId,
project.defaultBranch, ...)`, ce qui base toujours le checkout sur la branche par
defaut du projet. A l'approbation, `approveRun` pousse `run.agentBranch` et cree
la PR vers `project.defaultBranch`.

Le changement consiste a remplacer cette dependance a `project.defaultBranch`
par une valeur capturee sur le run au moment du lancement.

## Architecture

### Liste des branches

Ajouter `listProjectBranches(projectId)` dans `src/lib/rfc/projects.remote.ts`,
car la liste des branches est une propriete du projet et sera consommee par la
page projet avant la creation du run. La logique git vit dans un service serveur
dedie, `src/lib/server/project-branches-service.ts`.

Responsabilites :

- verifier l'organisation active avec `requireActiveOrg`;
- verifier que le projet appartient a l'organisation;
- recuperer la liste des branches disponibles cote serveur;
- retourner une liste triee, avec la branche par defaut en premier.

La source est le miroir git local, rafraichi avec `ensureMirror`, car il sert
deja de source pour les checkouts. Pour les repos prives, la query utilise le
token GitHub de l'utilisateur courant via le meme couple `authedCloneUrl` et
`makeGitAuth` que l'orchestrateur.

Si la recuperation des branches echoue, l'UI peut garder un fallback minimal
vers `project.defaultBranch`, mais `startRun` doit rester l'autorite finale.

### Lancement d'un run

Ajouter `baseBranch` a `startRunSchema` :

- optionnel cote input pour compatibilite;
- chaine non vide si fournie;
- valeur effective = `input.baseBranch ?? project.defaultBranch`.

`startRun` revalide la branche effective avant de creer le run :

- le nom doit etre une ref git valide;
- la branche doit exister dans la liste serveur la plus recente;
- si elle n'existe pas, renvoyer une erreur 400 claire.

Le `Run` cree stocke :

- `baseBranch`;
- `agentBranch = agentBranch(id)` comme aujourd'hui;
- `baseCommitSha` reste rempli plus tard par l'orchestrateur.

### Execution

`executeRun` utilise `run.baseBranch` pour creer le checkout :

```ts
await createRunCheckout(project.id, runId, run.baseBranch, auth?.env);
```

Le checkout reste ensuite sur `claude/<runId>`. L'agent ne travaille jamais
directement sur la branche de base.

### Review et PR

La page de run affiche deux informations distinctes :

- `Base branch` : la branche choisie au lancement;
- `Agent branch` : la branche isolee `claude/<runId>`.

Lors de `approveRun({ action: 'push_pr' })`, la PR est ouverte avec :

- `head = run.agentBranch`;
- `base = run.baseBranch`.

`approveRun({ action: 'push' })` continue de pousser uniquement
`run.agentBranch`. Il ne pousse pas sur `run.baseBranch`.

## Modele de donnees

Ajouter au modele Prisma `Run` :

```prisma
baseBranch String
```

Migration SQL :

1. ajouter `baseBranch` nullable;
2. backfiller les runs existants avec la `defaultBranch` du projet lie;
3. rendre `baseBranch` non nulle.

Les runs existants doivent continuer a s'afficher et a pouvoir etre approuves.
Pour eux, `baseBranch` vaut la branche par defaut historique du projet.

## UI

Sur `src/routes/(app)/projects/[id]/+page.svelte` :

- charger `listProjectBranches(page.params.id!)`;
- ajouter un select "Base branch" dans le formulaire de lancement;
- initialiser la selection avec `project.current.defaultBranch`;
- envoyer `baseBranch` a `startRun`;
- apres un lancement reussi, reinitialiser la selection a la branche par defaut
  courante du projet.

Etats attendus :

- chargement des branches : select desactive ou fallback sur la branche par
  defaut;
- erreur de chargement : afficher un message discret et permettre le lancement
  sur la branche par defaut seulement;
- branche disparue entre affichage et lancement : erreur 400 affichee dans
  `startError`.

Sur `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte` :

- renommer l'affichage actuel `Branch` en `Agent branch`;
- ajouter `Base branch`.

## Tests

Unitaires :

- `startRunSchema` accepte `baseBranch` et preserve les inputs existants;
- `startRun` persiste `baseBranch` et tombe sur `project.defaultBranch` si absent;
- `startRun` refuse une branche inexistante;
- `executeRun` appelle `createRunCheckout` avec `run.baseBranch`;
- `approveRun(push_pr)` ouvre la PR vers `run.baseBranch`;
- le service de branches retourne la branche par defaut en premier et de-duplique.

Integration git :

- verifier que le listing de branches fonctionne sur un miroir avec plusieurs
  branches, dont des noms contenant `/`.

UI/Svelte :

- le formulaire de run envoie la branche selectionnee;
- l'ecran run affiche base et agent branch separement.

## Hors scope

- Push direct sur la branche de base.
- Rebase automatique si la branche de base avance pendant le run.
- Choix d'un nom de branche agent personnalise.
- Branche de base par defaut configurable au niveau projet.
