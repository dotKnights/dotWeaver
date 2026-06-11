# Design : Runs agents interactifs

**Date** : 2026-06-12  
**Statut** : Valide en brainstorming, en attente de relecture  
**Perimetre** : questions structurees `AskUserQuestion` + affichage de l'etat courant des todos

## Objectif

Faire evoluer les runs d'agent de dotWeaver d'un mode "prompt unique puis attente du
resultat" vers une boucle interactive minimale : si Claude Code demande une decision via
`AskUserQuestion`, le run se met en pause, l'UI affiche un bloc de questions, l'utilisateur
repond au bloc complet, puis le meme run reprend. En parallele, l'UI affiche l'etat courant de
la todo list preparee par l'agent via `TodoWrite`.

La v1 ne cree pas un chat continu. Elle capture uniquement les demandes structurees produites
par Claude Code et laisse les messages libres de l'assistant dans le fil d'events existant.

## Decisions cadrees

| Sujet | Decision |
| --- | --- |
| Mode interactif | Vraie pause du run via un statut `awaiting_input`, puis reprise du meme conteneur |
| Source des questions | Uniquement l'outil Claude Code `AskUserQuestion` |
| Bloc actif | Un seul bloc `pending` par run, mais ce bloc peut contenir plusieurs questions |
| Reponse | Complete obligatoire avant reprise ; option `Autre` ajoutee cote UI pour chaque question |
| Todos | Panneau "Plan actuel" derive du dernier `TodoWrite`; pas d'historique en v1 |
| Prompt systeme | Pas d'instruction specifique ajoutee pour forcer les questions/todos |
| Chat continu | Hors perimetre v1 |
| Validation d'outils sensibles | Hors perimetre v1, les autres outils restent auto-autorises comme aujourd'hui |

## Approches considerees

### A. Reprise par nouveau run

Terminer le run quand Claude pose une question, enregistrer la reponse, puis creer un nouveau run
avec `resume: sessionId`. Cette option est simple mais fragmente l'historique et donne une
experience moins naturelle : la question ressemble a un prompt suivant, pas a une pause dans le
travail en cours.

### B. Pause dans le meme run via `canUseTool` (retenue)

Intercepter `AskUserQuestion` dans `canUseTool`, persister une interaction, passer le run en
`awaiting_input`, attendre la reponse utilisateur, puis retourner a Claude un `PermissionResult`
`allow` avec un `updatedInput` contenant les `answers` et `annotations`.

Cette approche colle au SDK actuel : `AskUserQuestionInput` accepte deja des champs `answers` et
`annotations`, et `canUseTool` est appele avant chaque execution d'outil.

### C. Session interactive complete

Remplacer le prompt string par un `AsyncIterable<SDKUserMessage>` et construire une messagerie
continue. Cette option sera utile plus tard, mais elle change le cycle de vie du runner,
l'interface et le modele mental. Trop large pour la v1.

## Architecture

### 1. Statuts de run

Ajouter `awaiting_input` a l'enum Prisma `RunStatus`.

Transitions nouvelles :

- `running -> awaiting_input` quand un `AskUserQuestion` est intercepte.
- `awaiting_input -> running` quand l'utilisateur repond au bloc actif.
- `awaiting_input -> canceled | timed_out | failed` pour annulation, timeout ou crash recovery.

`awaiting_input` n'est pas terminal. Le stream SSE reste ouvert et l'UI garde la page connectee,
afin de recevoir les events qui suivent la reprise.

### 2. Modele `RunInteraction`

Ajouter un modele dedie plutot que deduire l'etat actif depuis les `RunEvent`.

Champs proposes :

- `id`
- `runId`
- `kind` : v1 = `ask_user_question`
- `status` : `pending | answered | canceled`
- `toolUseId` : id du tool call Claude (`toolUseID` du contexte `canUseTool`)
- `request` : JSON normalise de `AskUserQuestionInput`
- `response` : JSON nullable avec `answers`, `response?`, `annotations?`
- `createdAt`
- `answeredAt`

Contrainte : un run ne doit avoir qu'une interaction `pending`. Comme Prisma ne modelise pas les
indexes partiels, la migration Postgres ajoute un index unique partiel :

```sql
CREATE UNIQUE INDEX run_interaction_one_pending_per_run
ON run_interaction ("runId")
WHERE status = 'pending';
```

Le code applique aussi la regle dans une transaction afin d'obtenir une erreur claire.

### 3. Protocole hote/conteneur

Aujourd'hui, le conteneur ecrit des `SDKMessage` en JSON-lines sur stdout. Pour reprendre un
`canUseTool` bloque, on ajoute un canal inverse sur stdin :

- stdout conteneur -> hote : messages SDK et messages de controle dotWeaver ;
- stdin hote -> conteneur : reponses dotWeaver.

`docker run` devra etre lance avec `-i` pour garder stdin ouvert. `runContainer` evolue pour
exposer au gestionnaire de lignes stdout une fonction `sendControlMessage(message)` qui ecrit
une ligne JSON sur le stdin du conteneur.

Messages de controle proposes :

```json
{
  "type": "interaction_request",
  "kind": "ask_user_question",
  "toolUseId": "toolu_...",
  "request": { "questions": [] }
}
```

```json
{
  "type": "interaction_response",
  "toolUseId": "toolu_...",
  "response": {
    "answers": {},
    "response": null,
    "annotations": {}
  }
}
```

Dans `docker/runner/entrypoint.mjs` :

- pour tous les outils sauf `AskUserQuestion`, `canUseTool` retourne `allow` comme aujourd'hui ;
- pour `AskUserQuestion`, il emet `interaction_request`, attend la ligne
  `interaction_response` avec le meme `toolUseId`, puis retourne :

```js
{
  behavior: 'allow',
  updatedInput: {
    ...input,
    answers: response.answers,
    annotations: response.annotations
  }
}
```

Si le run est annule ou si l'attente expire, l'hote envoie une reponse de controle d'annulation
ou tue le conteneur ; le run passe dans un etat terminal existant.

### 4. Orchestration cote hote

`run-orchestrator.ts` traite les lignes stdout de facon asynchrone.

Quand il recoit `interaction_request` :

1. il cree un `RunInteraction.pending` en DB ;
2. il append un `RunEvent` systeme contenant au minimum `{ type: 'interaction_request',
   interactionId, toolUseId, request }` pour reveiller l'UI via SSE ;
3. il passe le `Run` en `awaiting_input` ;
4. il attend que `answerRunInteraction` marque l'interaction `answered` ;
5. il envoie `interaction_response` au stdin du conteneur ;
6. il repasse le `Run` en `running`.

Le worker et l'app web etant deux process separes, cette attente ne depend jamais d'une promesse
en memoire cote HTTP. La source de verite est `RunInteraction.response` en DB. Pour la v1, le
runner peut poller l'interaction `pending` a intervalle court pendant `awaiting_input`. Une phase
ulterieure pourra remplacer ce polling par `LISTEN/NOTIFY`.

L'attente utilisateur doit etre abortable :

- annulation utilisateur ;
- timeout du run ;
- fermeture du conteneur ;
- redemarrage du worker.

Pour la v1, si le worker redemarre alors qu'un run est `awaiting_input`, le run est marque
`failed` avec un message explicite, car le canal stdin vers le conteneur est perdu. Une phase
future pourra reprendre via `sessionId`.

### 5. Remote functions

Ajouter dans `src/lib/rfc/runs.remote.ts` :

- `answerRunInteraction({ interactionId, answers, response?, annotations? })`

`getRun(runId)` inclut l'interaction active pour eviter une query separee.

Regles serveur :

- l'utilisateur doit etre membre de l'organisation active ;
- l'interaction doit appartenir a un run de cette organisation ;
- le run doit etre `awaiting_input` ;
- l'interaction doit etre `pending` ;
- toutes les questions du bloc doivent etre completees ;
- pour `Autre`, le texte libre est obligatoire ;
- une interaction deja repondue ne peut pas etre repondue deux fois.

Apres succes, la command refresh `getRun(runId)` et `listRuns(projectId)`.

### 6. UI de la page run

La page `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte` garde son role d'inspecteur
de run, avec trois zones :

- fil d'events existant ;
- carte prioritaire "Question de l'IA" si une interaction active existe ;
- panneau "Plan actuel" derive du dernier `TodoWrite`.

Carte "Question de l'IA" :

- un seul bloc actif ;
- 1 a 4 questions dans le bloc, selon `AskUserQuestionInput`;
- single choice : radio group ou boutons segmentes ;
- multi-select : checkboxes ;
- option `Autre` ajoutee cote UI ;
- champ texte obligatoire quand `Autre` est selectionne ;
- bouton "Repondre et reprendre" desactive tant que le bloc est incomplet ;
- etat busy pendant `answerRunInteraction`.

Le fil d'events peut masquer ou rendre discret l'event brut `interaction_request`, puisque la
carte active est l'interface principale.

### 7. Projection des todos

Ajouter une fonction pure, par exemple :

```ts
extractCurrentTodos(events: Array<{ payload: unknown }>): TodoItem[]
```

Elle scanne les events dans l'ordre et retient le dernier bloc `assistant.message.content[]`
contenant un `tool_use` avec `name === 'TodoWrite'`. L'etat courant vient de
`tool_use.input.todos`.

Le panneau affiche :

- `in_progress` en premier ;
- puis `pending` ;
- puis `completed` ;
- `activeForm` si disponible, sinon `content`.

On ne persiste pas de projection separee en v1. La DB garde seulement les events source de verite.

### 8. SSE et refresh client

`awaiting_input` doit etre considere comme un statut actif dans la page run. L'EventSource reste
connecte pour que la reprise continue dans le meme ecran.

Quand l'UI recoit un event SSE `interaction_request`, elle appelle `getRun(runId).refresh()` afin
de recuperer le statut `awaiting_input` et l'interaction active. L'event contient assez de donnees
pour que l'interface reste comprehensible meme si le refresh est lent.

Quand l'utilisateur repond, `answerRunInteraction` refresh `getRun` ; la reprise du conteneur
produit ensuite de nouveaux events live.

### 9. Timeouts

La v1 peut conserver le timeout global actuel du run, mais elle doit rendre l'etat explicite :
si l'utilisateur ne repond pas avant expiration, le run passe `timed_out` et l'interaction passe
`canceled`.

Un durcissement ulterieur pourra separer le budget d'execution active du temps d'attente
utilisateur. Ce n'est pas requis pour livrer la boucle interactive initiale.

## Gestion des erreurs

| Cas | Comportement |
| --- | --- |
| Reponse incomplete | `answerRunInteraction` rejette avec 400 et une erreur lisible |
| Interaction deja repondue | 409 ou 400, aucun double envoi vers le conteneur |
| Run annule pendant l'attente | interaction `canceled`, conteneur tue, run `canceled` |
| Timeout pendant l'attente | interaction `canceled`, run `timed_out` |
| Worker redemarre en attente | run `failed`, message "Interrupted while waiting for user input" |
| Deuxieme `AskUserQuestion` concurrent | refuse ou met en erreur controlee ; jamais deux blocs `pending` |
| Payload `AskUserQuestion` malforme | run `failed` avec message controle, event `error` |

## Tests

Unitaires :

- validation de reponse complete pour single choice, multi-select et `Autre` ;
- normalisation de `AskUserQuestionInput` vers modele UI ;
- extraction du dernier `TodoWrite` depuis des events assistant ;
- transitions `running -> awaiting_input -> running` et annulation depuis `awaiting_input` ;
- contrainte "un seul pending".

Integration serveur :

- orchestration avec faux conteneur : stdout `interaction_request`, attente DB, stdin
  `interaction_response`, reprise et event suivant ;
- `answerRunInteraction` : auth org, refus hors org, refus si run non `awaiting_input`,
  refus si interaction non pending ;
- crash recovery inclut `awaiting_input`.

UI :

- carte question : bouton desactive tant que toutes les questions ne sont pas completes ;
- `Autre` rend le champ texte obligatoire ;
- panneau todos affiche le dernier etat courant ;
- `svelte-autofixer` sur les composants modifies jusqu'a zero issue.

## Hors perimetre v1

- chat continu pendant un run ;
- detection de questions dans le texte markdown de l'assistant ;
- plusieurs blocs actifs en parallele ;
- validation interactive de `Bash`, `Edit`, `Write` ou autres outils sensibles ;
- historique detaille des changements de todos ;
- reprise automatique apres crash worker pendant `awaiting_input`.
