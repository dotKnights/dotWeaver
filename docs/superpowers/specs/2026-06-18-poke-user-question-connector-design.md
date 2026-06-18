# Poke User Question Connector Design

## Contexte

dotWeaver sait deja mettre un run en pause quand l'agent appelle l'outil interne
`AskUserQuestion`. Le runner emet une `interaction_request`, l'orchestrateur cree
une `RunInteraction` pending, la route de run affiche la carte de question, puis
`answerRunInteraction` serialise la reponse et renvoie un message de controle au
conteneur agent.

Poke expose deux surfaces utiles pour cette feature:

- API inbound message: `POST https://poke.com/api/v1/inbound/api-message` avec
  `Authorization: Bearer <V2 API key>` et un body JSON libre.
- MCP servers: Poke peut appeler un serveur MCP distant et inclut les headers
  `Authorization` et `X-Poke-User-Id` quand il execute des outils.

Objectif utilisateur: chaque utilisateur configure sa propre cle API Poke pour
toute l'application. Quand un run qu'il a lance pose une question, dotWeaver envoie
un message a Poke sur son telephone. L'utilisateur repond a Poke, puis Poke appelle
un outil MCP dedie dotWeaver pour reprendre le run.

## Decisions Produit

- La cle Poke est globale par utilisateur, pas par projet.
- Un run utilise la cle Poke de `run.createdById`.
- L'envoi Poke est opportuniste: un echec de notification ne bloque jamais la
  reponse via l'UI dotWeaver.
- La reponse MCP cible le run, pas uniquement l'interaction, avec l'outil
  `answer_pending_question`.
- L'outil accepte une reponse texte libre. dotWeaver la parse vers les options
  existantes quand c'est evident, sinon utilise l'option libre `Autre`.
- L'UI existante reste la voie de secours complete pour toutes les interactions
  difficiles a parser.

## Architecture

### Stockage utilisateur

Ajouter un modele Prisma `UserPokeConfig` lie a `User`:

- `userId` unique.
- `apiKeyEncrypted`.
- `enabled` par defaut `true`.
- `lastNotifiedAt`.
- `lastError`.
- `createdAt`, `updatedAt`.

La cle est chiffree avec la meme primitive que les secrets projet
(`project-agent-config-encryption`) afin de ne jamais stocker la valeur en clair.
Les requetes de lecture ne retournent que `connected`, `enabled`, `lastNotifiedAt`
et `lastError`.

### Service Poke

Creer `src/lib/server/poke-service.ts` avec:

- `getUserPokeConfig(userId)`: retourne l'etat masque.
- `upsertUserPokeApiKey(userId, apiKey)`: valide non vide, chiffre, active.
- `setUserPokeEnabled(userId, enabled)`: active/desactive sans supprimer la cle.
- `deleteUserPokeConfig(userId)`: supprime la cle.
- `sendPokeQuestionNotification(input)`: charge la config du createur du run,
  construit le message, POST vers Poke, met a jour `lastNotifiedAt` ou `lastError`.

Le service utilise `fetch` natif. Il considere la notification reussie seulement si
la reponse HTTP est 2xx et si le JSON optionnel ne contient pas `success: false`.

### Message envoye a Poke

Le message doit etre court, actionnable, et contenir assez de contexte pour que
Poke choisisse l'outil MCP:

```text
dotWeaver needs your input to continue a run.

Run ID: <runId>
Interaction ID: <interactionId>
Project: <owner>/<name>

Question 1: <question>
Options:
- <label>: <description>
- ...

Reply by calling the dotWeaver MCP tool answer_pending_question with:
- runId: <runId>
- message: your natural-language answer
```

Le message ne contient pas de cle API, de secret projet, ni de diff.

### Integration orchestrateur

Dans `executeRun`, apres `createPendingRunInteraction` et avant/pendant la
transition vers `awaiting_input`, appeler `sendPokeQuestionNotification` en
best-effort. L'erreur ne doit pas faire echouer le run. L'event
`interaction_request` continue d'etre persiste avec `interactionId`, afin que l'UI
web reste identique.

### Outil MCP dedie

Ajouter un outil MCP dans `src/lib/server/mcp/tools.ts`:

```ts
answer_pending_question({
  runId: string,
  message: string,
  team?: string
})
```

Comportement:

- Resoudre l'organisation avec `resolveOrgContext(ctx.userId, team)`.
- Trouver l'interaction pending du run dans cette organisation.
- Retourner `Run not found` si le run est absent ou hors org.
- Retourner `No pending question for this run` si aucun input n'est attendu.
- Parser `message` vers `answerRunInteractionSchema` via un helper pur.
- Appeler `answerPendingRunInteractionForOrg`.
- Retourner `{ answered: true }`.

L'outil est expose au meme serveur MCP OAuth que les autres outils dotWeaver. Poke
doit connecter ce serveur MCP via l'URL `/mcp` de dotWeaver.

### Parsing texte libre

Creer un helper pur dans `src/lib/server/run-interaction-answer-parser.ts`.

Entree:

- `request`: le payload `ask_user_question`.
- `message`: texte libre de Poke.

Sortie:

- `answers`: format attendu par `answerPendingRunInteractionForOrg`.
- `response`: le message original trimme.
- `annotations`: `{ source: { channel: "poke", parser: "text" } }`.

Regles:

- Normaliser casse, espaces et ponctuation legere.
- Pour une question single-choice, matcher une option si le message est egal au
  label, commence par le label, ou contient clairement le label comme token.
- Pour une question multi-select, selectionner toutes les options mentionnees.
- Si aucune option ne matche, utiliser `OTHER_OPTION_VALUE` avec `otherText`
  egal au message.
- Si plusieurs questions sont presentes, accepter des lignes `Question: reponse`
  ou `Header: reponse`; sinon appliquer le meme message comme fallback a chaque
  question.
- Toujours laisser `validateAskUserQuestionResponse` faire la validation finale.

### UI Connecteurs

Etendre la page `/settings/connectors` avec une carte Poke:

- Etat connecte/non connecte.
- Toggle active/desactive.
- Formulaire pour sauvegarder/remplacer la cle API.
- Action supprimer la configuration.
- Affichage du dernier echec de notification si present.

La cle sauvegardee n'est jamais revelee. Le champ est toujours vide au chargement.

### Remote functions

Ajouter `src/lib/rfc/poke.remote.ts`:

- `getPokeConnector()`
- `savePokeApiKey({ apiKey })`
- `setPokeEnabled({ enabled })`
- `deletePokeConnector()`

Chaque commande agit sur `locals.user!.id`.

## Gestion des erreurs

- Cle absente ou config desactivee: ne pas appeler Poke, ne pas enregistrer d'erreur.
- API Poke 401/403/429/5xx: stocker un message court dans `lastError`, continuer le run.
- Body Poke non JSON: accepter si HTTP 2xx.
- Parsing impossible: fallback `Autre`.
- Interaction deja repondue ou run plus en `awaiting_input`: l'outil MCP retourne une
  erreur outil non fatale.

## Securite

- Ne jamais logger la cle Poke.
- Ne jamais retourner la cle Poke au client.
- Chiffrer avec la cle applicative existante.
- Scoper l'outil MCP par utilisateur OAuth et organisation, comme les autres outils.
- Ne pas exposer de donnees cross-tenant: `runId` hors org retourne une erreur
  indistinguable d'un run absent.

## Tests

Tests unitaires TDD:

- `poke-service`: chiffrement, masquage, activation, suppression, envoi success,
  envoi echec best-effort.
- `run-interaction-answer-parser`: match exact, match casse/ponctuation, fallback
  `Autre`, multi-question par lignes, multi-select.
- `run-orchestrator`: notifie Poke apres creation d'interaction, n'echoue pas si
  Poke echoue, utilise `run.createdById`.
- `mcp/tools`: enregistre `answer_pending_question`, resout org, repond via le
  service, mappe les erreurs metier.
- `connectors` UI/service existant: Poke apparait dans l'etat connecteur utilisateur.

Verification:

- `bun run test:unit -- --run tests/unit/lib/server/poke-service.test.ts`
- `bun run test:unit -- --run tests/unit/lib/server/run-interaction-answer-parser.test.ts`
- `bun run test:unit -- --run tests/unit/lib/server/run-orchestrator.test.ts`
- `bun run test:unit -- --run tests/unit/lib/server/mcp/tools.test.ts`
- `bun run check`

## Hors perimetre

- Reponse Poke en schema structure obligatoire.
- Webhook inbound depuis Poke vers dotWeaver hors MCP.
- Notifications de review finale ou de run termine.
- Configuration par projet.
- Support de plusieurs cles Poke par utilisateur.

## References

- Poke API: https://poke.com/docs/api
- Poke MCP servers: https://poke.com/docs/mcp-servers
- dotWeaver MCP reference: `docs/mcp.md`
