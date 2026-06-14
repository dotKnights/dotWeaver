# Page Connecteurs — Design

**Date**: 2026-06-15
**Statut**: Approuvé

## Objectif

Une page dédiée permettant à l'utilisateur de gérer ses connexions de comptes
externes : connecter/déconnecter son **GitHub** et son **Google (Gmail)**, voir
l'état de chaque connexion, et gérer l'accès aux repos de son organisation
GitHub.

## Contexte & décision GitHub

L'application utilise une **GitHub OAuth App** (via `socialProviders.github` de
better-auth, `scope: ['repo']`). Limite structurelle : une OAuth App a un modèle
de permissions « tout ou rien » et, pour les organisations ayant activé
« OAuth App access restrictions » (cas de l'org dotWeaver), l'accès aux repos de
l'org est bloqué tant qu'un owner n'a pas approuvé l'app.

**Décision** : on conserve l'OAuth App. La page connecteurs affiche l'état et
fournit un bouton « Gérer l'accès org » qui deep-linke vers la page GitHub de
gestion de l'app, où l'utilisateur peut demander/gérer l'approbation pour l'org.
On ne migre **pas** vers une GitHub App pour l'instant (permissions fines
remises à plus tard).

## Architecture

- Route : `src/routes/(app)/settings/connectors/+page.svelte`.
- Lien **« Settings »** ajouté dans le header (`src/routes/(app)/+layout.svelte`)
  pointant vers `/settings/connectors`.
- Logique serveur : nouveau `src/lib/rfc/connectors.remote.ts` (pattern
  `*.remote.ts` existant) — une `query` de statut, deux `command` de
  déconnexion.
- Les **connexions** (redirect OAuth) restent côté client via
  `authClient.linkSocial`.

## Données exposées — `listConnectors` (query)

S'appuie sur `auth.api.listUserAccounts({ headers })` (aucun appel réseau
GitHub/Google) :

- `github`: `{ connected }`
- `google`: `{ connected, hasGmailScope }` où
  `needsReconnect = connected && !hasGmailScope` (scope `gmail.readonly` absent
  du champ `scope` du compte).
- `hasPassword` : présence d'un account `providerId === 'credential'`.
- `canDisconnect` par provider = **il restera ≥ 1 méthode de login** après
  retrait (sinon bouton désactivé + explication → règle « bloquer si dernier
  login »). Double sécurité : better-auth refuse déjà d'unlink le dernier compte.
- `githubOrgAccessUrl` =
  `https://github.com/settings/connections/applications/{GITHUB_CLIENT_ID}`
  (le client_id n'est pas secret ; exposé depuis le serveur via
  `env.GITHUB_CLIENT_ID`).

## Actions

- **Connect GitHub** (client) :
  `linkSocial({ provider: 'github', scopes: ['repo'], callbackURL: '/settings/connectors' })`.
- **Connect / Reconnect Google** (client) :
  `linkSocial({ provider: 'google', scopes: [GMAIL_READONLY_SCOPE], callbackURL: '/settings/connectors' })`.
- **Gérer l'accès org GitHub** : lien externe vers `githubOrgAccessUrl`.
- **disconnectGithub** (command) : garde « dernier login » →
  `auth.api.unlinkAccount({ body: { providerId: 'github' }, headers })`.
- **disconnectGoogle** (command) : garde « dernier login » → **purge**
  `MailThread` + `MailSyncState` (where `userId`) →
  `auth.api.unlinkAccount({ body: { providerId: 'google' }, headers })`.
  Purge **avant** unlink pour que l'opération reste rejouable si l'unlink échoue.

## UI

- Composant réutilisable `ConnectorCard.svelte` (shadcn `Card` + `Badge` +
  `Button`, icônes Lucide `Github` / `Mail`) : nom du provider, badge de statut
  (Connecté / Non connecté / Reconnexion requise), bouton d'action principal, et
  pour GitHub un bouton secondaire « Gérer l'accès org ».
- Déconnexion → **dialog de confirmation** (`AlertDialog` shadcn). Celle de
  Google précise explicitement que **les mails synchronisés seront supprimés**.
- Page Mail : quand non connecté, le `linkSocial` inline est remplacé par un
  message + lien vers `/settings/connectors` (source unique de vérité pour les
  connexions).

## Erreurs & edge cases

- Les commands renvoient `{ ok: false, error }` (ou `error()` SvelteKit) ; l'UI
  affiche l'erreur via `Alert`.
- Tentative de disconnect du dernier login → bloquée côté serveur **et** bouton
  désactivé côté client.
- La `query` est invalidée/rafraîchie après chaque command.

## Tests

- Unitaires (`tests/unit/lib`) : calcul `canDisconnect` (logique pure),
  détection `hasGmailScope`, ordre purge-puis-unlink de `disconnectGoogle`.
- Composant `ConnectorCard` : rendu des 3 états de badge (pattern
  `vitest-browser-svelte` existant).

## Hors scope (plus tard)

- Migration vers une GitHub App (permissions fines par-repo).
- Autres providers.
- Gestion de rôles/permissions internes.
