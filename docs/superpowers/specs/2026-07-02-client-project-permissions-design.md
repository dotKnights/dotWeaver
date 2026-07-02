# Design : Permissions clients granulaires

**Date** : 2026-07-02
**Statut** : Validé en conversation, à relire avant plan d'implémentation

## Objectif

Permettre d'inviter des clients externes sur dotWeaver sans les rendre membres de la team
interne, puis leur donner accès à un ou plusieurs projets précis avec des permissions
granulaires. Le système doit rester modulaire pour que chaque nouveau domaine fonctionnel puisse
déclarer ses propres permissions sans modifier une grosse enum globale.

## Contexte actuel

Le modèle actuel repose sur Better Auth et son plugin `organization` :

- les teams internes sont des `Organization`;
- les membres internes sont des `Member` avec un rôle `owner`, `admin` ou `member`;
- les projets et leurs sous-ressources portent un `organizationId`;
- les services serveur vérifient surtout l'appartenance à l'organisation active via
  `requireActiveOrg`, puis filtrent par `organizationId`.

Ce modèle protège bien les frontières entre teams, mais il ne sait pas exprimer :

- un utilisateur externe non membre de la team;
- un client qui voit seulement certains projets;
- un droit précis sur un projet, par exemple voir le projet sans voir les runs;
- un mécanisme réutilisable pour d'autres ressources que `Project`.

## Décisions

| Sujet | Décision |
| --- | --- |
| Identité | Better Auth reste responsable de la session et du compte utilisateur. |
| Client externe | Un client n'est pas un `Member` de la team interne. |
| Organisation cliente | Une team interne peut créer des `ClientOrganization`, par exemple "Acme". |
| Contacts client | Des utilisateurs Better Auth peuvent être rattachés à une organisation cliente. |
| Permissions | Les permissions sont des strings stables, déclarées dans un registre TypeScript. |
| Stockage | Les grants stockent des permissions sous forme de strings validées par le registre. |
| Héritage | Les contacts héritent des grants de leur organisation cliente. |
| Permissions individuelles | Un contact peut recevoir des droits additionnels. |
| Deny | Aucun deny dans le MVP. Les droits effectifs sont une union. |
| Membres internes | Les membres internes gardent l'accès actuel au départ. |

## Modèle de données

### ClientOrganization

Organisation cliente rattachée à une team interne.

Champs principaux :

- `id`
- `organizationId` : team interne propriétaire
- `name`
- `slug`
- `createdById`
- `createdAt`
- `updatedAt`

Contraintes :

- slug unique par team interne;
- suppression en cascade quand la team interne est supprimée.

### ClientOrganizationMember

Lien entre un compte Better Auth (`User`) et une organisation cliente. C'est ce que le produit
peut appeler "client user" ou "contact client".

Champs principaux :

- `id`
- `organizationId` : team interne propriétaire, dupliqué pour les requêtes et la sécurité
- `clientOrganizationId`
- `userId`
- `role` : `admin` ou `member` côté client, gardé simple au MVP
- `createdAt`

Contraintes :

- unique par `(clientOrganizationId, userId)`;
- un contact peut appartenir à plusieurs organisations clientes si nécessaire.

### ClientInvitation

Invitation email pour rattacher un futur compte utilisateur à une organisation cliente.

Champs principaux :

- `id`
- `organizationId`
- `clientOrganizationId`
- `email`
- `role`
- `status` : `pending`, `accepted`, `canceled`, `expired`
- `invitedById`
- `expiresAt`
- `createdAt`

Le flow d'acceptation suit le principe des invitations de team existantes : l'invité doit créer ou
utiliser un compte avec l'email invité, puis accepter l'invitation. Après acceptation, un
`ClientOrganizationMember` est créé.

### AccessGrant

Autorisation donnée à une cible sur une ressource précise.

Champs principaux :

- `id`
- `organizationId` : team interne propriétaire de la ressource
- `subjectType` : `client_organization` ou `client_member`
- `subjectId` : id de `ClientOrganization` ou `ClientOrganizationMember`
- `resourceType` : `project` au MVP, extensible ensuite
- `resourceId`
- `permissions String[]`
- `createdById`
- `createdAt`
- `updatedAt`

Contraintes :

- unique par `(organizationId, subjectType, subjectId, resourceType, resourceId)`;
- index sur `(organizationId, resourceType, resourceId)`;
- index sur `(subjectType, subjectId)`.

`AccessGrant` est volontairement polymorphe. Les services métier valident que le subject et la
ressource existent dans la team propriétaire avant de créer ou modifier un grant. Cela évite de
figer le système autour de `Project` dès le départ.

## Registre de permissions

Les permissions ne doivent pas être dispersées en strings libres dans le code. Chaque domaine
fonctionnel déclare son module de permissions.

Exemple conceptuel :

```ts
export const projectPermissions = definePermissionModule({
	resource: 'project',
	permissions: {
		view: { label: 'Voir le projet' },
		manage_access: { label: 'Gérer les accès' }
	},
	presets: {
		projectAccess: ['project.view']
	}
});
```

```ts
export const runPermissions = definePermissionModule({
	resource: 'run',
	permissions: {
		view: { label: 'Voir les runs' },
		create: { label: 'Lancer un run' },
		reply: { label: 'Répondre à un run' },
		approve: { label: 'Approuver un run' },
		'diff.view': { label: 'Voir le diff' }
	}
});
```

Un registre central agrège les modules :

```ts
export const permissionRegistry = createPermissionRegistry([
	projectPermissions,
	runPermissions
]);
```

Objectifs du registre :

- produire des clés stables comme `project.view` ou `run.create`;
- fournir les labels, descriptions, catégories et presets à l'UI;
- valider les permissions écrites en base;
- exposer un type TypeScript `Permission`;
- refuser les doublons et les presets qui référencent une permission inconnue.

Les permissions initiales sont :

- `project.view`
- `project.manage_access`
- `run.view`
- `run.create`
- `run.reply`
- `run.diff.view`
- `run.approve`
- `project.config.view`
- `project.config.manage`

Presets initiaux :

- **Accès projet** : `project.view`
- **Suivi** : `project.view`, `run.view`
- **Reviewer** : `project.view`, `run.view`, `run.diff.view`, `run.reply`
- **Opérateur** : `project.view`, `run.view`, `run.create`, `run.reply`, `run.diff.view`
- **Admin projet** : toutes les permissions applicables au projet, dont `project.manage_access`

## Service d'autorisation

Créer un module serveur `authz` distinct de Better Auth. Better Auth répond à "qui est connecté ?".
`authz` répond à "qu'a-t-il le droit de faire ici ?".

API cible :

```ts
const actor = await requireActor(headers);
await requirePermission(actor, 'project.view', { type: 'project', id: projectId });
const allowed = await can(actor, 'run.create', { type: 'project', id: projectId });
const projects = await listAccessibleProjects(actor);
```

### Actor

`requireActor` charge :

- `userId`;
- les memberships internes `Member`;
- les memberships client `ClientOrganizationMember`;
- l'organisation active si elle existe.

Un utilisateur peut être :

- membre interne seulement;
- client externe seulement;
- les deux.

### Evaluation

Pour une permission donnée :

1. Valider que la permission existe dans le registre.
2. Déterminer la team propriétaire de la ressource.
3. Si l'utilisateur est membre interne de cette team, conserver l'accès actuel au MVP.
4. Charger les grants directs du `ClientOrganizationMember`.
5. Charger les grants hérités de sa `ClientOrganization`.
6. Unionner les permissions.
7. Autoriser seulement si la permission demandée est présente.

Pour les runs, la ressource d'autorisation reste le projet. Par exemple, `run.view` se vérifie sur
`{ type: 'project', id: projectId }`, car l'accès client est donné au niveau du projet.

## Surfaces à protéger

Première intégration : projets.

- `listProjects` retourne les projets visibles par l'acteur.
- `getProject` exige `project.view`.
- un client avec seulement `project.view` ne voit ni runs, ni diff, ni config.

Surfaces suivantes :

- runs : `run.view`, `run.create`, `run.reply`, `run.approve`;
- diff : `run.diff.view`;
- config agent, env vars, secrets, MCP, services : `project.config.view` et
  `project.config.manage`;
- streams SSE : même permission que la lecture correspondante;
- outils MCP : mêmes checks que les remote functions web.

Les helpers existants comme `requireProjectInOrg` doivent progressivement être remplacés ou
encapsulés par des helpers orientés permissions, pour éviter une logique d'accès dispersée.

## UX

### Gestion des clients

Dans la zone team :

- créer une organisation cliente;
- inviter un contact par email;
- voir les contacts actifs et invitations en attente.

### Gestion des accès projet

Sur une page projet :

- ajouter une organisation cliente ou un contact client;
- choisir un preset;
- afficher clairement les permissions effectives;
- permettre plus tard un mode "personnalisé" qui coche les permissions atomiques.

Le MVP peut se limiter aux presets. Le modèle et le registre doivent déjà permettre le custom.

### Expérience client

Un utilisateur externe :

- se connecte ou crée son compte normalement;
- ne devient pas membre de la team interne;
- voit uniquement les projets accessibles;
- ne voit pas le switcher de team interne s'il n'a aucun membership interne;
- ne voit pas les actions non autorisées.

## Plan d'intégration progressif

1. Ajouter les modèles Prisma clients et grants.
2. Ajouter le registre de permissions modulaire.
3. Ajouter `requireActor`, `can`, `requirePermission` et les helpers de listing.
4. Brancher les projets sur `project.view`.
5. Brancher les runs et diff.
6. Brancher la configuration projet et les streams.
7. Brancher les outils MCP.
8. Ajouter l'UX de gestion clients et accès.

Cette séquence limite le risque : les membres internes gardent leur comportement actuel pendant
que l'accès externe devient strictement opt-in.

## Gestion des erreurs

- `401` si aucun utilisateur n'est connecté.
- `403` si l'utilisateur est connecté mais n'a pas la permission.
- `404` pour les ressources absentes ou non visibles dans les routes où éviter la fuite
  d'existence est préférable.
- Les mutations de grants doivent refuser toute permission inconnue.
- Les mutations de grants doivent refuser toute ressource hors de la team propriétaire.

## Tests

Tests unitaires :

- le registre refuse les doublons;
- les presets ne peuvent référencer que des permissions connues;
- un contact hérite des grants de son organisation cliente;
- un grant individuel ajoute des droits;
- aucun deny n'est appliqué;
- un client avec `project.view` ne reçoit pas `run.view`.

Tests remote/server :

- `listProjects` filtre les projets visibles;
- `getProject` exige `project.view`;
- `listRuns` exige `run.view`;
- `startRun` exige `run.create`;
- `getRunDiff` exige `run.diff.view`;
- la config projet exige les permissions config.

Tests E2E :

- un interne crée une organisation cliente;
- il invite un contact;
- le contact accepte l'invitation;
- le contact voit uniquement les projets explicitement accordés;
- le contact ne voit pas les runs sans le preset approprié.

## Hors périmètre MVP

- Deny ou révocation partielle d'un droit hérité.
- Rôles internes granulaires pour les membres de team.
- Invitation ouverte sans email ciblé.
- Audit log complet des changements de permissions.
- Groupes avancés côté client au-delà de l'organisation cliente.
