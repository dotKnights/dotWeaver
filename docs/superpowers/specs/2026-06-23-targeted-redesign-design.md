# Design : Refonte ciblee shell, runs et team preferee

**Date** : 2026-06-23
**Statut** : Approuve par l'utilisateur pour redaction de plan

## Design read

Refonte ciblee d'un produit devtool et AI workspace pour utilisateurs techniques. Le langage
visuel suit `DESIGN.MD` : command center editorial, surfaces blanches, panneaux sombres ponctuels,
typographie sobre, peu d'ombres, beaucoup de lisibilite.

Design system retenu : shadcn-svelte existant, Tailwind v4 et icones Lucide deja presentes dans le
projet. Aucune nouvelle librairie UI n'est introduite.

Dial cible :

| Dial | Valeur | Raison |
|---|---:|---|
| `DESIGN_VARIANCE` | 5 | Produit de travail technique, structure stable avant expressivite. |
| `MOTION_INTENSITY` | 3 | Motion limitee aux transitions et au flux live des runs. |
| `VISUAL_DENSITY` | 6 | Interface quotidienne, scannable, sans devenir cockpit. |

## Audit rapide

| Surface | Etat actuel | Probleme |
|---|---|---|
| `/` | Page SvelteKit par defaut | Ne sert pas le produit et ne redirige pas les utilisateurs connectes. |
| `(app)/+layout.svelte` | Header horizontal simple | Navigation peu scalable, team switcher fragile visuellement. |
| `dashboard` | Page centree de demo | Ne donne pas de point d'entree produit. |
| `projects`, `teams` | Cartes et listes basiques | Peu de hierarchie, etats vides peu guides. |
| Page run | Timeline lineaire brute | Trop d'evenements raw, actions review/reply dispersees. |
| Team active | `activeOrganizationId` Better Auth | Pas de preference durable si la session ne garde plus la selection. |

Mode de redesign : evolution ciblee. On preserve l'IA, les routes, les schemas metier existants et
les conventions SvelteKit.

## Objectifs

1. Remplacer le header applicatif par une sidebar gauche responsive.
2. Rediriger `/` vers `/dashboard` quand l'utilisateur est connecte.
3. Harmoniser legerement dashboard, projects et teams avec le nouveau shell.
4. Repenser la page run comme un workspace : header d'etat, timeline nettoyee, rail contexte.
5. Fusionner les events `thinking_tokens` en une seule ligne live au lieu de cartes raw.
6. Ajouter une team preferee durable par utilisateur, restauree apres interruption de dev.
7. Ajouter les tests necessaires sur normalisation run et resolution d'org active.

## Hors perimetre

- Refonte complete de toutes les routes `(app)`.
- Nouvelle landing page marketing publique.
- Changement de design system.
- Refonte de l'orchestrateur de run, de la queue ou du runner Docker.
- Diff inline avance par outil `Write` ou `Edit`.
- Filtres complexes de timeline et persistance des panneaux ouverts.

## Architecture visuelle

### Tokens et style global

`src/routes/layout.css` reste le point d'entree des tokens shadcn.

Principes :

- Canvas principal clair : `background`, `card`, `muted`.
- Sidebar near-black, coherente avec `DESIGN.MD`.
- Accent principal : vert profond pour actions produit et surfaces actives.
- Coral reserve aux alertes douces ou signaux temporaires, pas aux CTA principaux.
- Rayons : 8px pour controles, 12px pour panneaux, pill pour actions principales.
- Ombres faibles ou absentes. Hierarchie par bordures, contraste de surface et typographie.

La typo reste self-hosted via `@fontsource-variable/inter` pour limiter le scope. Une evolution de
font peut etre traitee plus tard.

### App shell

Fichiers cibles :

- `src/routes/(app)/+layout.svelte`
- Eventuellement `src/lib/components/layout/AppSidebar.svelte`
- Eventuellement `src/lib/components/layout/AppTopbar.svelte`

Desktop :

- Sidebar gauche fixe ou sticky, largeur cible 240-260px.
- Logo dotWeaver, team switcher, navigation principale, zone compte en bas.
- Topbar de contenu compacte avec titre de page, description breve et action principale si utile.
- Contenu dans un conteneur flexible, max width selon page.

Mobile :

- Header compact en haut.
- Menu de navigation accessible via bouton.
- Team switcher conserve une cible tactile correcte.
- Les rails secondaires des pages deviennent des sections empilees.

Navigation cible :

- Dashboard
- Projects
- Mail
- Connectors
- Teams

Les labels actuels restent reconnaissables pour ne pas casser la memoire utilisateur.

## Root route

Fichier cible : `src/routes/+page.server.ts` en plus de `src/routes/+page.svelte`.

Comportement :

- Si `locals.session` existe : `redirect(303, '/dashboard')`.
- Sinon : afficher une entree publique tres simple avec liens login/register.

Choix recommande : petite entree publique minimale, car elle remplace la page SvelteKit par defaut
et evite un slash vide pour les visiteurs non connectes.

## Dashboard, projects et teams

Objectif : harmonisation legere, pas refonte profonde.

Dashboard :

- Titre produit clair.
- Resume de team active.
- Raccourcis vers importer un projet, consulter les runs recents et configurer les connecteurs.
- Etats vides guidees si pas de team ou pas de projet.

Projects :

- Header avec action "Import repository".
- Import GitHub dans un panneau dedie.
- Liste projets en rows ou panneaux sobres, avec owner/name, branch par defaut et action d'ouverture.
- Etats loading, empty et error explicites.

Teams :

- Creation de team et liste de teams dans une composition plus lisible.
- Badge ou libelle clair pour la team active.
- Le champ placeholder ne doit pas utiliser de nom generique type "Acme Inc."; utiliser un exemple
  contextualise ou retirer le placeholder.

## Run workspace

Fichiers cibles :

- `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`
- `src/lib/components/runs/RunEvent.svelte`
- `src/lib/components/runs/run-event-display.ts`
- Eventuellement `src/lib/components/runs/RunHeader.svelte`
- Eventuellement `src/lib/components/runs/RunTimeline.svelte`
- Eventuellement `src/lib/components/runs/RunReviewPanel.svelte`

Layout desktop :

- Colonne principale : header run, prompt, review ou reply, timeline.
- Rail droit sticky : question IA active, plan actuel, metadonnees utiles.
- Header run : status, agent, modele, base branch, agent branch, action cancel si autorisee.

Layout mobile :

- Header run.
- Question IA et plan actuel avant ou apres timeline selon statut.
- Actions review/reply visibles avant la timeline longue.

### Timeline

La timeline ne doit plus etre une liste de blocs bruts. Elle affiche des evenements lisibles :

- `session_start` : ligne compacte.
- `thinking_stream` : ligne compacte et dynamique, detail repliable.
- `assistant_text` : bulle/panneau markdown.
- `user_message` : message utilisateur aligne distinctement.
- `tool_use` et `tool_result` : paire visuelle ou groupe compact, detail tronque.
- `result` : carte finale claire avec statut, cout, duree et tours.
- `raw` : panneau diagnostic repliable, jamais premier niveau sauf type inconnu.

Les transitions visuelles restent simples : hover, active, apparition discrete. Pas de scroll
custom ou animation lourde.

### Thinking tokens

Investigation DB locale, le 2026-06-23 :

```json
{
  "type": "system",
  "subtype": "thinking_tokens",
  "estimated_tokens": 88,
  "estimated_tokens_delta": 52
}
```

Ces events ne contiennent pas le texte de pensee. Ils representent des deltas ou estimations de
tokens. Le vrai texte arrive ensuite via un payload `assistant` contenant `content[]` avec
`type: "thinking"`.

Comportement cible :

- Creer `normalizeTimeline(payloads: unknown[]): DisplayEvent[]`.
- `normalizeTimeline` remplace l'appel actuel `source.flatMap((p) => normalizeEvent(p))`.
- Les payloads `system/thinking_tokens` consecutifs sont fusionnes dans un seul
  `DisplayEvent` de type `thinking_stream`.
- `thinking_stream` porte au minimum :
  - `text: string | null`
  - `estimatedTokens: number | null`
  - `deltaTokens: number | null`
  - `streaming: boolean`
- Pendant le SSE live, la meme entree se met a jour parce que `eventTimeline` est derivee des
  events persistants + live events.
- Si un payload `assistant/thinking` arrive apres les tokens, il enrichit ou remplace le texte de
  `thinking_stream` au lieu de creer un deuxieme bloc.
- Les events `thinking_tokens` ne sont jamais rendus en `raw`.
- Si plusieurs sequences de pensee sont separees par du texte assistant ou un tool call, chaque
  sequence devient sa propre entree `thinking_stream`.

Rendu cible :

- Une ligne compacte "Thinking" avec compteur optionnel, par exemple `88 tokens`.
- En live, la ligne progresse avec `estimated_tokens`.
- Detail repliable pour lire le texte final quand il existe.
- Si aucun texte final n'existe, afficher seulement l'indicateur et le compteur.

Tests requis :

- Payloads `thinking_tokens` seuls produisent un seul `thinking_stream`.
- Plusieurs deltas consecutifs gardent le dernier `estimated_tokens` comme `estimatedTokens`.
- Plusieurs deltas consecutifs additionnent les `estimated_tokens_delta` comme `deltaTokens`.
- `thinking_tokens` + `assistant/thinking` produisent un seul display event.
- Un `tool_use` entre deux sequences coupe la fusion.
- Aucun `thinking_tokens` ne tombe en `raw`.

## Team preferee durable

Probleme actuel : les commandes serveur utilisent `requireActiveOrg(headers)`, qui lit
`activeOrganizationId` depuis la session Better Auth. Une simple restauration visuelle dans
`listMyTeams` ne suffit donc pas.

### Donnees

Choix recommande : ajouter un champ nullable sur `User`.

Schema cible :

```prisma
model User {
  preferredOrganizationId String?
  preferredOrganization   Organization? @relation("PreferredOrganization", fields: [preferredOrganizationId], references: [id], onDelete: SetNull)
}

model Organization {
  preferredByUsers User[] @relation("PreferredOrganization")
}
```

Si Prisma ou Better Auth rend cette relation trop intrusive, alternative acceptee :
`UserPreference { userId, preferredOrganizationId }`. Le comportement attendu reste identique.

### Resolution effective

Creer un helper serveur partage, par exemple :

```ts
resolveEffectiveActiveOrg(headers: Headers): Promise<string | null>
```

Regles :

1. Si la session a `activeOrganizationId` et que l'utilisateur est membre, retourner cet id et
   synchroniser `preferredOrganizationId`.
2. Sinon, si `preferredOrganizationId` existe et que l'utilisateur est membre, retourner cet id et
   synchroniser la session Better Auth si possible.
3. Sinon, si l'utilisateur a au moins une team, choisir la premiere team stable, enregistrer cette
   preference, et synchroniser la session si possible.
4. Sinon, retourner `null`.

`requireActiveOrg(headers)` utilise ce helper. Si le helper retourne `null`, la commande renvoie
toujours `400 No active team selected`.

Routes ou fonctions a migrer vers le helper :

- `src/lib/server/org.ts`
- `src/lib/rfc/teams.remote.ts`
- `src/routes/api/runs/[id]/events/+server.ts`

### Changement de team

`setActiveTeam(organizationId)` :

- Verifie que l'utilisateur est membre de l'organisation.
- Appelle `auth.api.setActiveOrganization`.
- Met a jour `User.preferredOrganizationId`.
- Refresh `listMyTeams`.

`listMyTeams()` :

- Retourne `teams`.
- Retourne `activeOrganizationId` effectif.
- Peut exposer `preferredOrganizationId` si utile au debug UI, mais l'UI n'en depend pas.

## Accessibilite et etats

Chaque surface touchee doit inclure :

- Etat loading avec skeleton ou texte stable.
- Etat empty avec action claire.
- Etat error contextualise.
- Focus visible preserve pour boutons, liens et select.
- Labels au-dessus des champs.
- Pas de placeholder comme label.
- Contraste lisible sur sidebar sombre et panneaux verts.

## Tests et verification

Commandes attendues avant livraison implementation :

- `bun run check`
- `bun run test:unit -- --run`
- Tests cibles ajoutes ou modifies pour :
  - `run-event-display`
  - resolution de team preferee
  - domaines existants si touches
- Verification navigateur desktop et mobile :
  - `/`
  - `/dashboard`
  - `/projects`
  - `/teams`
  - page run avec events existants
  - page run live si un run local peut etre lance

Svelte MCP :

- Utiliser `svelte-autofixer` sur tout nouveau composant Svelte ou composant modifie de facon
  substantielle.
- Relancer jusqu'a absence d'issues ou suggestions actionnables.

## Risques

| Risque | Mitigation |
|---|---|
| La session Better Auth ne se synchronise pas pendant le meme request cycle | Les commandes serveur utilisent l'id retourne par le helper, pas seulement `locals.session`. |
| Une team preferee devient invalide | Verification de membership a chaque resolution et fallback propre. |
| Les thinking tokens n'ont pas de texte | Rendu compteur live, puis fusion avec le bloc `assistant/thinking` final. |
| Trop de refonte visuelle | Scope limite aux surfaces listees, routes et IA conservees. |
| Regression mobile | Collapse explicite des layouts multi-colonnes. |

## Plan d'implementation attendu

Le plan devra etre decoupe en etapes testables :

1. Team preference DB + helper serveur + tests.
2. Root redirect + app shell sidebar.
3. Harmonisation dashboard/projects/teams.
4. Normalisation timeline avec `thinking_stream` + tests.
5. Recomposition page run.
6. Verification Svelte MCP, `bun run check`, unit tests et verification navigateur.
