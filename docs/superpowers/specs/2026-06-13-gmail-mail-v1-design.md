# Design : Gmail mail v1

**Date** : 2026-06-13  
**Statut** : Approuve en brainstorming, en attente de relecture finale  
**Perimetre** : connexion Google/Gmail + affichage de conversations Inbox/Sent en lazy sync

## Objectif

Ajouter a dotWeaver une premiere experience mail permettant a un utilisateur connecte de retrouver
et lire ses conversations Gmail dans la plateforme. La v1 sert de fondation pour de futures analyses
par projet/client, mais ne fait pas encore d'analyse IA, de reponse mail, ni de synchronisation temps
reel.

L'utilisateur peut se connecter a dotWeaver avec GitHub ou Google. S'il est connecte via GitHub sans
compte Google lie, la page Mail lui propose de connecter Google. Si Google est deja lie, l'experience
Mail fonctionne directement.

## Decisions cadrees

| Sujet            | Decision                                                                        |
| ---------------- | ------------------------------------------------------------------------------- |
| Perimetre v1     | Retrouver et afficher les mails, pas d'analyse IA                               |
| Source mail      | Gmail API via compte Google lie a l'utilisateur                                 |
| Auth produit     | Login existant GitHub/Google conserve ; liaison Google depuis `/mail` si absent |
| Scope Gmail      | `https://www.googleapis.com/auth/gmail.readonly`                                |
| Mode d'affichage | Conversations/threads comme Gmail                                               |
| Perimetre Gmail  | Inbox + Sent sur une fenetre recente de 90 jours                                |
| Stockage         | Hybride leger : index local des threads, pas de body complet persistant         |
| Lazy loading     | Infinite scroll avec sentinel observe via `runed/useIntersectionObserver`       |
| Detail thread    | Recuperation Gmail a la demande avec `threads.get(format=full)`                 |
| Sync v1          | Lazy sync a la demande, pas de job background ni Pub/Sub                        |
| Sync future      | Schema prepare pour stocker `historyId`, mais non exploite en v1                |

## Sources techniques verifiees

- Better Auth permet de lier un provider social depuis un compte existant avec `linkSocial` et de
  recuperer un access token cote serveur avec `auth.api.getAccessToken`; l'endpoint rafraichit le
  token expire si possible.
- Gmail `threads.list` renvoie des threads pagines avec `nextPageToken`, mais pas la liste complete
  des messages du fil.
- Gmail `threads.get` renvoie les messages d'un thread et supporte `format=full` avec
  `gmail.readonly`.
- Google classe les scopes Gmail donnant acces au contenu mail comme restreints ; cela implique
  verification OAuth et potentiellement security assessment avant une production publique.
- Runed fournit `useIntersectionObserver`, avec `root`, `pause`, `resume` et `stop`, adapte au lazy
  loading dans une liste scrollable Svelte 5.

References :

- https://www.better-auth.com/docs/concepts/oauth
- https://www.better-auth.com/docs/concepts/users-accounts
- https://developers.google.com/workspace/gmail/api/auth/scopes
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/list
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get
- https://developers.google.com/workspace/gmail/api/guides/threads
- https://developers.google.com/workspace/gmail/api/guides/sync
- https://developers.google.com/workspace/gmail/api/guides/push
- https://www.runed.dev/docs/utilities/use-intersection-observer

## Architecture

```text
User session (Better Auth)
        |
        | if Google account missing
        v
/mail shows "Connect Google" -> authClient.linkSocial(provider: "google", gmail.readonly)
        |
        v
Remote functions in src/lib/rfc/mail.remote.ts
        |
        v
Server-only Gmail service in src/lib/server/gmail.ts
        |
        +--> auth.api.getAccessToken(providerId: "google")
        +--> Gmail API threads.list / threads.get
        |
        v
Prisma MailThread + MailSyncState
        |
        v
Svelte /mail UI: thread list + lazy detail
```

Le client Svelte ne manipule jamais de token Gmail. Les remote functions exposent uniquement des
operations produit : etat de connexion, liste indexee, synchronisation de page suivante et detail
d'un thread.

## Authentification et permissions

La configuration Better Auth garde les providers existants `github` et `google`. La page Mail gere
trois etats :

1. utilisateur non authentifie : le layout `(app)` redirige deja vers `/login` ;
2. utilisateur authentifie sans Google lie : afficher une action `Connect Google` ;
3. utilisateur authentifie avec Google lie et scope Gmail : charger les conversations.

La liaison Google utilise `authClient.linkSocial` avec :

- `provider: 'google'` ;
- `callbackURL: '/mail'` ;
- `scopes: ['https://www.googleapis.com/auth/gmail.readonly']`.

Le serveur recupere le token via `auth.api.getAccessToken({ body: { providerId: 'google' }, headers
})`. Si Better Auth leve une erreur type compte absent, token invalide ou scope insuffisant, le
service renvoie un etat metier `connected: false` ou `needsReconnect: true` plutot qu'une erreur 500.

Avant de deployer publiquement, la configuration doit activer l'encryption des tokens OAuth ou un
hook equivalent. Les tokens OAuth ne doivent jamais apparaitre dans les logs applicatifs ni dans les
payloads de remote functions.

## Modele de donnees

### `MailThread`

Index local minimal d'une conversation Gmail.

Champs proposes :

- `id`
- `userId`
- `gmailThreadId`
- `historyId`
- `subject`
- `snippet`
- `participants`
- `fromEmail`
- `fromName`
- `toEmails`
- `labelIds`
- `lastMessageAt`
- `messageCount`
- `unread`
- `starred`
- `createdAt`
- `updatedAt`

Contraintes et indexes :

- `@@unique([userId, gmailThreadId])`
- `@@index([userId, lastMessageAt])`
- relation `User` avec suppression cascade.

Le body complet des messages n'est pas stocke en v1. `participants`, `toEmails` et `labelIds` sont
des champs Prisma `Json`, en coherence avec les champs JSON deja presents dans le schema existant.

### `MailSyncState`

Etat de lazy sync par utilisateur.

Champs proposes :

- `id`
- `userId`
- `query`
- `windowDays`
- `nextPageToken`
- `lastHistoryId`
- `lastSyncedAt`
- `status` : `idle | syncing | error`
- `error`
- `createdAt`
- `updatedAt`

Contraintes :

- `@@unique([userId])`
- relation `User` avec suppression cascade.

`lastHistoryId` prepare la sync incrementale future via `users.history.list`, mais la v1 ne lance ni
job background, ni `users.watch`, ni Pub/Sub.

## Gmail service

Le module serveur `src/lib/server/gmail.ts` concentre toute la logique Gmail :

- `getGoogleAccessToken(headers): Promise<string | null>` ;
- `listGmailThreadsPage(token, { pageToken, query })` ;
- `getGmailThread(token, gmailThreadId)` ;
- `mapGmailThreadToMailThread(userId, thread)` ;
- `normalizeGmailError(error)` ;
- helpers de parsing headers (`From`, `To`, `Subject`, `Date`).

La requete v1 cible Inbox + Sent sur 90 jours :

```text
newer_than:90d (in:inbox OR in:sent)
```

Si l'API Gmail rejette cette syntaxe dans l'implementation reelle, le plan doit basculer vers deux
requetes explicites (`in:inbox newer_than:90d` et `in:sent newer_than:90d`) fusionnees par
`gmailThreadId`. La semantique produit reste Inbox + Sent sur 90 jours.

Pour construire l'index, chaque page de `threads.list` donne les ids et snippets. Le service recupere
ensuite le detail minimal necessaire des threads de la page avec `threads.get(format=metadata)` et
`metadataHeaders=['From','To','Subject','Date']`. La v1 n'utilise `format=full` que pour le detail
d'une conversation ouverte.

Le detail d'une conversation ouverte utilise `threads.get(format=full)` et renvoie au client une
structure de lecture : messages ordonnes, expediteur, destinataires, date, texte/html nettoye ou
texte brut extrait. Le parsing du MIME doit rester minimal en v1 : afficher le meilleur contenu texte
disponible, puis HTML sanitise si necessaire.

## Remote functions

Nouveau fichier : `src/lib/rfc/mail.remote.ts`.

### `getMailConnectionStatus`

Retourne :

```ts
type MailConnectionStatus = {
	connected: boolean;
	needsReconnect: boolean;
	email?: string;
};
```

### `listMailThreads`

Lit l'index local du user courant, trie par `lastMessageAt desc`, et retourne aussi l'etat de sync :

```ts
type MailThreadListResult = {
	connected: boolean;
	needsReconnect: boolean;
	threads: MailThreadListItem[];
	hasMore: boolean;
	syncing: boolean;
	error: string | null;
};
```

Si l'utilisateur est connecte a Google mais que l'index est vide, la page peut declencher
`syncNextMailPage` automatiquement une seule fois cote UI.

### `syncNextMailPage`

Commande sans argument pour la v1. Elle :

1. verifie la session ;
2. recupere le token Google ;
3. lit ou cree `MailSyncState` ;
4. appelle Gmail avec le `nextPageToken` courant ;
5. upsert les `MailThread` ;
6. persiste le nouveau `nextPageToken`, `lastSyncedAt` et `lastHistoryId` si disponible ;
7. refresh `listMailThreads`.

La commande est idempotente. Si `status = syncing`, elle evite de lancer deux sync concurrentes pour
le meme user.

### `getMailThread`

Query validee par Zod (`gmailThreadId` non vide). Elle appelle Gmail a la demande et renvoie le
thread complet pour affichage. Elle ne persiste pas le body.

## UI

Nouvelle route : `src/routes/(app)/mail/+page.svelte`.

Ajouter un lien `Mail` dans `src/routes/(app)/+layout.svelte`.

Etats UI :

- Google non connecte : callout avec bouton `Connect Google`.
- Reconnexion requise : message expliquant que le scope Gmail doit etre accorde, bouton reconnect.
- Index vide : skeleton puis premiere lazy sync.
- Liste chargee : conversations Gmail-like.
- Chargement page suivante : spinner discret en bas de liste.
- Fin de liste : indication courte ou silence visuel.
- Erreur quota/rate limit : pause du lazy loading + bouton retry.
- Thread inaccessible : panneau detail avec message non bloquant.

Sur desktop, l'ecran utilise deux zones :

- liste scrollable de conversations a gauche ;
- detail du thread selectionne a droite.

Sur mobile, la liste reste l'ecran principal. Le detail peut s'ouvrir en navigation interne ou panneau
plein ecran selon les composants existants disponibles au moment de l'implementation.

## Lazy loading au scroll

Ajouter la dependance `runed`.

La liste de threads contient un sentinel en bas de son conteneur scrollable. Le composant utilise
`useIntersectionObserver` :

- `root` pointe vers le conteneur scrollable ;
- si le sentinel intersecte et `hasMore === true` et `loadingNextPage === false`, appeler
  `syncNextMailPage()` ;
- mettre l'observer en pause pendant la sync ;
- reprendre l'observer apres refresh de `listMailThreads` ;
- stopper l'observer quand `hasMore === false` ou Google n'est pas connecte.

Un bouton retry reste visible en cas d'erreur. Il ne remplace pas l'infinite scroll, il sert seulement
de fallback actionnable.

## Erreurs et securite

Le service Gmail transforme les erreurs externes en erreurs metier :

| Cas                             | Comportement                          |
| ------------------------------- | ------------------------------------- |
| Compte Google absent            | `connected: false`                    |
| Token invalide / scope manquant | `needsReconnect: true`                |
| 401 Gmail                       | reconnect Google                      |
| 403 quota/rate limit/privilege  | message UI + retry, logs serveur      |
| 429                             | pause lazy loading + retry            |
| Thread 404/inaccessible         | message dans le detail, liste intacte |
| Erreur reseau                   | retry manuel, pas de crash serveur    |

Les logs serveur ne doivent pas contenir d'access token, de refresh token, ni de body mail.

## Hors perimetre v1

- Analyse IA des mails.
- Association automatique mail -> projet/client.
- Recherche avancee.
- Reponse, envoi, brouillons ou modification de labels.
- Pieces jointes completes.
- Stockage du body complet.
- Sync background periodique.
- Sync temps reel via `users.watch`, Google Pub/Sub et webhook.
- Gestion multi-compte Google par utilisateur.

## Tests

### Unit

- `mapGmailThreadToMailThread` extrait sujet, participants, labels, dates, unread/starred.
- Parsing headers robuste quand `From`, `To`, `Subject` ou `Date` manquent.
- `getGoogleAccessToken` retourne `null` ou `needsReconnect` sans faire remonter une APIError brute.
- `normalizeGmailError` couvre 401, 403, 429 et erreur reseau.
- Upsert `MailThread` idempotent par `userId + gmailThreadId`.

### Remote functions / serveur

- `listMailThreads` retourne `connected: false` sans Google lie.
- `syncNextMailPage` persiste `nextPageToken` et refresh la query.
- Deux syncs concurrentes pour le meme user ne dupliquent pas les threads.
- `getMailThread` refuse un `gmailThreadId` invalide et ne persiste pas le body.

### UI / e2e cible

- `/mail` affiche le callout Connect Google si Google absent.
- Avec donnees mockees, la liste affiche les conversations triees par date.
- Le sentinel declenche `syncNextMailPage` quand il devient visible.
- Une erreur de sync affiche un retry et ne vide pas la liste deja chargee.

Les composants Svelte modifies doivent passer par `svelte-autofixer` avant livraison.

## Plan d'implementation propose

1. Creer la branche de travail et installer `runed`.
2. Ajouter la migration Prisma `MailThread` + `MailSyncState`.
3. Ajuster la configuration Better Auth Google pour les scopes Gmail et la liaison additionnelle.
4. Implementer `src/lib/server/gmail.ts` et ses tests unitaires.
5. Implementer `src/lib/server/mail-service.ts` pour l'index local et la sync idempotente.
6. Ajouter `src/lib/rfc/mail.remote.ts`.
7. Ajouter `/mail`, la navigation et le lazy scroll via Runed.
8. Ajouter tests remote/UI cibles.
9. Verifier `bun run check`, `bun run lint` et les tests pertinents.
