# Design : Réponse conversationnelle aux runs

**Date** : 2026-06-15
**Statut** : Approuvé en brainstorming
**Périmètre** : permettre à l'utilisateur de répondre à un run terminé pour relancer la session

## Objectif

Quand l'agent termine son tour avec une question posée en texte libre (par
exemple « Est-ce que ce design te convient ? Et peux-tu me donner le DSN ? »), le
container sort en code 0 et le run passe en `awaiting_review`. La question est
visible dans le fil mais l'utilisateur n'a aucun moyen d'y répondre : le run est
perçu comme un succès alors que l'agent attend une réponse.

On ajoute une zone de réponse libre sur les runs en `awaiting_review`. Envoyer un
message relance **la même run** : un nouveau container est lancé sur le checkout
conservé, avec `resume` de la session de l'agent et le message comme nouveau
prompt. Les nouveaux events s'ajoutent au même fil. Cycle :
`awaiting_review → queued → running → awaiting_review`.

## Décisions cadrées

| Sujet                  | Décision                                                                 |
| ---------------------- | ------------------------------------------------------------------------ |
| Modèle d'interaction   | Réponse libre (chat), pas de détection « c'est une question »            |
| Identité du run        | Même run, fil de conversation continu (pas de run enfant)                |
| États autorisés        | `awaiting_review` uniquement                                             |
| Statut de reprise      | Réutiliser `queued` (pas de nouveau statut `resuming`)                   |
| Stockage du message    | `Run.pendingPrompt` (pas de table de messages séparée)                   |
| Composer               | Toujours visible en `awaiting_review`                                    |
| Reprise de session     | `resume=sessionId` + `RUN_PROMPT=<message>` (déjà supporté côté agent)   |

## Contexte actuel

- **Questions structurées** : l'agent appelle l'outil MCP `AskUserQuestion`
  (`docker/runner/ask-user-question-tool.mjs`), l'entrypoint émet un
  `interaction_request`, l'orchestrateur crée une `RunInteraction`, passe le run
  en `awaiting_input`, attend la réponse, puis renvoie un `interaction_response`
  par message de contrôle. Ce chemin reste **inchangé**.
- **Le trou** : si l'agent finit son tour sans outil structuré (`query()` se
  termine, exit 0), le run passe en `awaiting_review` et aucune suite n'est
  possible.
- `Run.sessionId` est déjà persisté. L'entrypoint
  (`docker/runner/entrypoint.mjs`) lit déjà `RUN_RESUME_SESSION` et passe
  `resume` à `query()` → la reprise de session est déjà câblée côté agent.
- Le checkout du run est conservé sur l'hôte jusqu'à l'approbation/abandon
  (`approveRun` appelle `removeRunCheckout`) → il est réutilisable en
  `awaiting_review`.
- **Contrainte `seq`** : `RunEvent` a `@@unique([runId, seq])` et `executeRun`
  fait repartir `seq` à `0` à chaque appel. Pour rester sur la même run, le
  chemin resume doit continuer le `seq` depuis le max existant.
- Le job de queue est `{ runId }` ; `executeRun` recrée toujours le checkout via
  `createRunCheckout`. Il faut donc un chemin « resume » qui réutilise le
  checkout existant au lieu d'en créer un.

## Architecture

### 1. Schema / migration

- `Run.pendingPrompt String?` — message saisi par l'utilisateur, en attente de
  traitement par le worker. Effacé une fois consommé.
- Nouvelle valeur d'enum `RunEventType.user_message` — pour afficher la réponse
  de l'utilisateur dans la timeline (distincte de `tool_result`, qui est ce que
  `classifyMessage` retourne aujourd'hui pour un message `type: 'user'`).

### 2. State machine (`src/lib/domain/run-status.ts`)

Ajouter deux transitions :

- `awaiting_review → queued` : remise en queue pour reprise.
- `queued → running` : chemin resume direct (on saute `preparing` car il n'y a
  ni mirror ni checkout à créer).

Les transitions existantes restent valides ; un run frais continue à passer par
`queued → preparing → running`.

### 3. Commande remote `replyToRun(runId, message)` (`src/lib/rfc/runs.remote.ts`)

Validation et effets, dans une transaction quand c'est pertinent :

1. Scope org + run en `awaiting_review` + `sessionId` non nul + `message` non
   vide (schéma Zod). Sinon `error(400, …)`.
2. Enregistre un `RunEvent` de type `user_message` avec `seq = max(seq) + 1` et
   un payload `{ type: 'user_message', text: message }`.
3. Pose `run.pendingPrompt = message`, réinitialise `run.timeoutAt`
   (nouvelle fenêtre), et transitionne `awaiting_review → queued` (transition
   gardée : si le run n'est plus en `awaiting_review`, `error(409, …)`).
4. `enqueueRun(runId)`.
5. Rafraîchit `getRun(runId)` et `listRuns(projectId)`.

### 4. Orchestrateur (`src/lib/server/run-orchestrator.ts`)

`executeRun(runId)` détecte le **mode resume** : le run possède un `sessionId`
**et** un `pendingPrompt`.

- **Mode frais** (actuel) : inchangé — `queued → preparing`, mirror, checkout,
  `preparing → running`, `seq` à 0.
- **Mode resume** :
  - Transitionne `queued → running` (pas de `preparing`).
  - Réutilise le checkout existant (`runWorktreePath`). S'il n'existe plus
    (nettoyé), transitionne le run en `failed` avec un message clair.
  - Calcule `startSeq = (max seq existant) + 1` et l'utilise comme base du
    compteur.
  - Construit l'env avec `RUN_PROMPT = pendingPrompt` et
    `RUN_RESUME_SESSION = sessionId`.
  - Efface `pendingPrompt` une fois le container lancé (ou dans la même
    transition `queued → running`) pour éviter une double consommation.
  - Relance le container. La gestion des `interaction_request` (questions
    structurées) reste identique : l'agent peut très bien reposer une question
    structurée pendant le tour de reprise.
  - Sortie 0 → recalcule `headCommitSha` et repasse en `awaiting_review`. Le
    cycle peut recommencer.

Le code commun (boucle de streaming, gestion des interactions, transitions de
fin) doit être factorisé pour ne pas le dupliquer entre les deux modes.

### 5. UI (`src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`, `RunEvent.svelte`)

- En `awaiting_review`, afficher un **composer** (textarea + bouton envoyer) en
  plus du panneau review/approve existant. Désactivé si pas de `sessionId`.
- L'envoi appelle `replyToRun`. Pendant `running`, le stream SSE existant
  affiche la reprise en direct.
- Rendre le `RunEvent` `user_message` comme une bulle « utilisateur » dans la
  timeline (`run-event-display.ts` + `RunEvent.svelte`).

## Flux de données

1. Run termine son tour → `awaiting_review` (existant).
2. L'utilisateur saisit une réponse → `replyToRun` : event `user_message`
   enregistré + `pendingPrompt` posé + `timeoutAt` réinitialisé + statut
   `queued` + job enqueue.
3. Le worker prend le job → `executeRun` détecte le mode resume → container
   relancé avec `resume` + le message → events streamés (`seq` continue).
4. Exit 0 → `awaiting_review` (nouveau head). Boucle possible.

## Gestion d'erreurs

- **Pas de `sessionId`** → `replyToRun` renvoie 400 ; le composer est désactivé
  côté UI. Ne devrait pas arriver sur une sortie propre, mais on garde la garde.
- **Checkout nettoyé** → l'orchestrateur passe le run en `failed` avec un message
  explicite ; l'UI peut afficher l'erreur.
- **Concurrence reply vs approve/push** → résolue par les transitions gardées :
  `replyToRun` réclame `awaiting_review → queued`, `approveRun` exige
  `awaiting_review`. Le premier arrivé gagne, le second reçoit un 409.
- **Crash du container de reprise** → chemin `failed` existant ;
  `pendingPrompt` aura déjà été effacé.

## Tests

- `run-transitions.test.ts` : nouvelles transitions
  (`awaiting_review → queued`, `queued → running`) autorisées ; les transitions
  interdites le restent.
- Unit : gardes de `replyToRun` (statut, sessionId, message vide) ; continuation
  du `seq` en mode resume ; effacement de `pendingPrompt`.
- E2E : run → réponse dans le composer → 2ᵉ tour visible dans le même fil, avec
  la bulle `user_message` intercalée.

## Hors périmètre (v1)

- Répondre depuis `failed` / `timed_out` / `canceled`.
- Détection automatique « l'agent attend une réponse ».
- Runs enfants / arbre de forks.
- Pousser le prompt système pour forcer l'usage de `AskUserQuestion`.
