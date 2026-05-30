# Design : Équipes & invitations

**Date** : 2026-05-29
**Statut** : Approuvé (en attente de relecture finale)

## Objectif

Permettre à un utilisateur de **créer des équipes** et d'**inviter des personnes** dans ces
équipes, en restant dans la stack existante : SvelteKit (remote functions), better-auth
(plugin `organization`), Prisma, zod et superforms.

## Décisions cadrées

| Sujet              | Décision                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Modèle « équipe »  | `organization` de better-auth (entité top-level). La sous-feature « teams » imbriquée n'est **pas** utilisée.                                  |
| Multi-équipe       | Un user peut appartenir à plusieurs équipes. Une **équipe active** est stockée sur la session.                                                 |
| Rôles              | `owner` / `admin` / `member` (rôles par défaut du plugin).                                                                                     |
| Invitations        | Lien **scié à un email** (natif better-auth). Aucun envoi d'email : le lien `/accept-invitation/{id}` est affiché et **copié** par l'inviteur. |
| Slug               | **Auto-généré** depuis le nom (slugify + suffixe anti-collision). Pas de saisie utilisateur.                                                   |
| Sélecteur d'équipe | Dropdown dans le layout `(app)`, équipe active pré-sélectionnée, listant toutes mes équipes.                                                   |

## Contrainte connue (better-auth)

Les invitations du plugin `organization` sont **scopées à un email** et il n'existe **pas** de
lien d'inscription ouvert. Concrètement :

1. L'inviteur saisit l'email de l'invité + le rôle.
2. `inviteMember` crée une `Invitation` (status `pending`) et retourne son `id`. Aucun email
   n'est envoyé (`sendInvitationEmail` non configuré).
3. L'UI affiche le lien `/{...}/accept-invitation/{id}` que l'inviteur copie et transmet.
4. L'invité se connecte/s'inscrit **avec ce même email**, ouvre le lien, et `acceptInvitation`
   l'ajoute comme membre.

## Architecture

### 1. Modèle de données (Prisma)

Ajout dans `prisma/schema.prisma` (aligné sur le schéma attendu par le plugin, vérifié via
`@better-auth/cli generate`) :

- **`Organization`** : `id`, `name`, `slug` (`@unique`), `logo?`, `metadata?`, `createdAt`.
  Relations : `members Member[]`, `invitations Invitation[]`.
- **`Member`** : `id`, `organizationId`, `userId`, `role`, `createdAt`. Relations vers `User`
  (onDelete Cascade) et `Organization` (onDelete Cascade).
- **`Invitation`** : `id`, `organizationId`, `email`, `role`, `status`, `inviterId`,
  `expiresAt`. Relation vers `Organization` (onDelete Cascade).
- **`Session`** : ajout du champ `activeOrganizationId String?`.
- **`User`** : ajout des relations inverses `members Member[]`.

Migration : `prisma migrate dev` (datasource PostgreSQL, config via `prisma.config.ts`).

### 2. Authentification (better-auth)

- **Serveur** (`src/lib/server/auth.ts`) : ajout du plugin `organization()`. Rôles par défaut
  conservés. `sendInvitationEmail` **non défini** (pas d'envoi). Optionnellement
  `allowUserToCreateOrganization: true` (défaut).
- **Client** (`src/lib/auth-client.ts`) : ajout du plugin `organizationClient()`.

### 3. Remote functions Svelte

- Activation : `kit.experimental.remoteFunctions = true` dans `svelte.config.js`.
- Fichier `src/routes/(app)/teams/teams.remote.ts` exportant depuis `$app/server` :
  - **`query`** (lectures, re-fetch auto après mutation) :
    - `listMyTeams()` → équipes de l'utilisateur + équipe active
    - `getTeam(slug)` → détail : membres (rôle), invitations en attente
    - `getActiveTeam()` → équipe active courante
  - **`command`** (écritures sans formulaire riche) :
    - `acceptInvitation(invitationId)`
    - `setActiveTeam(organizationId)`
    - `removeMember({ organizationId, memberId })`
    - `cancelInvitation(invitationId)`
  - **`form`** (formulaires validés zod) :
    - `createTeam` (name → slug auto)
    - `inviteMember` (email + role) → retourne l'`id` d'invitation pour le lien
- Chaque fonction récupère la requête via `getRequestEvent()` (`$app/server`) et délègue à
  `auth.api.*` en passant `request.headers` (cookies de session). Autorisation déléguée à
  better-auth (un `admin`/`owner` peut inviter ; le retrait de membre suit les permissions du
  plugin). Les `query` concernées sont invalidées/rafraîchies après chaque `command`/`form`.

### 4. Validation (zod + superforms)

- Schémas zod dans `src/lib/schemas/teams.ts` :
  - `createTeamSchema` : `name` (min 2). Le slug est dérivé côté serveur, pas dans le schéma.
  - `inviteSchema` : `email` (email valide), `role` (enum `admin` | `member`).
- **superforms** côté client (même pattern que le login existant) : `superForm` avec
  `zod4Client` pour la validation réactive et l'affichage des erreurs, qui appelle la remote
  `form`/`command` dans `onSubmit`. zod = source unique de vérité serveur (remote) et client
  (superforms).
- Util de slug `src/lib/server/slug.ts` : `slugify(name)` + résolution de collision (suffixe
  `-2`, `-3`… selon l'existant en base).

### 5. Routes / UI (composants shadcn existants)

- `(app)/teams/+page.svelte` — liste de mes équipes + bouton/form « Créer une équipe ».
- `(app)/teams/[slug]/+page.svelte` — détail d'une équipe :
  - liste des membres avec rôle (+ retrait pour owner/admin)
  - formulaire d'invitation (email + rôle)
  - invitations en attente avec **lien copiable** + bouton « Annuler »
- `(app)/accept-invitation/[id]/+page.svelte` — page d'acceptation (gère connecté / non
  connecté, redirige vers login si nécessaire, vérifie la correspondance d'email).
- Sélecteur d'équipe active : dropdown dans `(app)/+layout.svelte`, équipe active
  pré-sélectionnée, listant toutes mes équipes ; sélection → `command` `setActiveTeam`.

### 6. Gestion des erreurs

- Remote functions : erreurs better-auth (permission, invitation expirée, email non
  correspondant, slug en conflit) remontées en messages exploitables côté form.
- Page d'acceptation : messages clairs pour invitation invalide/expirée/déjà acceptée et pour
  email non correspondant.

### 7. Tests

- **Unit (vitest)** : `slugify` + collisions ; schémas zod (`createTeamSchema`, `inviteSchema`).
- **E2E (playwright)** _(optionnel)_ : créer équipe → inviter → copier lien → accepter avec un
  second compte.

## Hors périmètre (YAGNI)

- Envoi d'emails (provider non configuré).
- Sous-équipes imbriquées, rôles/permissions custom.
- Liens d'invitation ouverts (anyone-can-join).
- Transfert de propriété / suppression d'équipe (peut venir plus tard).
