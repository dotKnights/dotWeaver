# Project Readiness Center -- Design

**Date** : 2026-06-29
**Statut** : Valide en brainstorming, en attente de relecture utilisateur
**Perimetre** : refonte UX de l'onboarding projet, Readiness Center reutilisable, premier run guide

## Objectif

Transformer l'onboarding projet en une experience complete et reutilisable :

- importer un projet ;
- confirmer ce que dotWeaver a detecte ;
- preparer runtime, variables et services ;
- comprendre si le projet est pret pour les agents ;
- lancer un premier run guide au lieu de laisser un prompt vide.

Le parcours cible n'est pas un wizard jetable. Il devient un **Readiness
Center** que l'utilisateur peut relancer a tout moment apres un changement de
dependances, de commandes, de services, de variables ou de branche.

## Design read

Produit devtool et AI workspace pour utilisateurs techniques. Le langage reste
celui du produit existant : command center editorial, canvas clair, sidebar
sombre, surfaces sobres, peu d'ombres, bordures nettes, typographie dense mais
lisible.

Design system retenu :

- Svelte 5 / SvelteKit existant ;
- Tailwind v4 ;
- shadcn-svelte et Bits UI existants ;
- Lucide existant ;
- primitives motion natives Svelte (`Tween`, `Spring`, `prefersReducedMotion`,
  `transition:`, `animate:flip`) plutot qu'une nouvelle librairie animation.

Dial cible :

| Dial | Valeur | Raison |
| --- | ---: | --- |
| `DESIGN_VARIANCE` | 5 | Produit de travail quotidien, structure stable avant expressivite. |
| `MOTION_INTENSITY` | 4 | Motion visible et utile, mais rapide et non decorative. |
| `VISUAL_DENSITY` | 6 | Interface scannable, reutilisable, orientee action. |

## Decisions validees

| Sujet | Decision |
| --- | --- |
| Portee | Parcours complet projet -> setup -> premier run |
| Niveau d'autonomie | Semi-pilote : dotWeaver propose et pre-remplit, l'utilisateur valide |
| Premier run | Guide avec suggestions v1, pas analyse IA profonde obligatoire |
| Modele UI | Guided command center |
| Nature du setup | Readiness Center reutilisable |
| Placement | Hybride : resume sur page projet, centre complet sur `/setup` |
| Motion | Native Svelte, sobre, accessible, pas de scroll hijack |

## Contexte actuel

La v1 d'onboarding existe deja autour de :

- `/projects/:id/setup` ;
- `ProjectSetupChecklist` ;
- `EnvironmentPanel` ;
- `ProjectEnvironmentServicesPanel` ;
- `computeEnvironmentSetupState` ;
- streams SSE pour environnement et services ;
- redirection post-import vers `/setup`.

Cette base a les bonnes fondations metier, mais l'experience reste un ensemble
de panneaux de configuration. L'utilisateur voit les bons controles, sans
toujours comprendre :

- ce que dotWeaver recommande maintenant ;
- pourquoi une etape bloque le prochain run ;
- ce qui est deja pret ;
- quel premier run lancer apres la preparation.

La refonte garde les routes, remote functions, streams et modeles existants
autant que possible. Elle change surtout la hierarchie, les composants UI et la
progression utilisateur.

## Approches envisagees

### Option A -- Checklist augmentee

Ameliorer directement `ProjectSetupChecklist` : meilleure progression, CTA plus
clair, logs mieux structures, suggestions de premier run en bas de page.

Avantage : scope faible et risque limite.
Limite : l'experience resterait tres proche de la v1 actuelle.

### Option B -- Guided command center

Construire `/setup` comme un centre de commande :

- rail gauche permanent avec progression ;
- zone centrale dediee a l'action courante ;
- rail droit de contexte et recommandations ;
- resume compact sur la page projet.

Option retenue : elle rend l'experience plus claire et plus memorable tout en
restant adaptee a un devtool quotidien.

### Option C -- Story flow

Faire de chaque etape un chapitre visuel plus narratif, avec transitions plus
marquees.

Avantage : experience plus spectaculaire.
Limite : risque de sur-design pour une surface qu'on veut refaire souvent.

## Architecture de parcours

### Page projets

Apres import GitHub, l'utilisateur continue d'arriver sur :

```text
/projects/:projectId/setup
```

Le comportement existant reste correct.

### Page projet

`/projects/:id` affiche un resume compact de readiness avant le formulaire de
run :

- statut global : ready, needs setup, stale, failed, preparing ;
- detail court : runtime, services, prepare state ;
- action principale contextuelle : `Open readiness center`, `Prepare again`,
  `Fix setup`, ou `Start guided run` ;
- lien vers `/projects/:id/setup`.

La page projet reste l'endroit rapide pour travailler. Elle ne doit pas devenir
un deuxieme setup complet.

### Readiness Center

`/projects/:id/setup` devient la surface complete pour :

- detecter et confirmer runtime/package manager ;
- editer les commandes ;
- gerer les variables d'environnement ;
- ajouter, configurer, provisionner ou desactiver les services ;
- preparer l'environnement ;
- lire les logs et erreurs ;
- lancer ou pre-remplir un premier run guide.

### Retour vers le premier run

Quand la readiness est suffisante pour ouvrir le projet, le CTA final ne doit
pas seulement etre `Open project`. Il doit proposer une suite :

- choisir une suggestion de premier run ;
- pre-remplir le prompt ;
- lancer depuis le centre ou revenir sur la page projet avec le prompt prepare.

## Layout du Readiness Center

### Rail gauche

Role : progression stable et reassurance.

Contenu :

- nom court du projet ;
- branche par defaut ;
- statut global ;
- etapes : Runtime, Environment, Services, Prepare, First run ;
- dernier check ou derniere preparation si disponible ;
- retour vers la page projet.

Chaque etape affiche un etat lisible : ready, warning, failed, running, todo,
optional ou stale. Le rail est sticky sur desktop. Sur mobile, il devient un
header compact avec une barre de progression et un select/tabs d'etapes.

### Zone centrale

Role : une action dominante a la fois.

La zone centrale affiche l'etape active sous forme d'un panneau principal :

- titre clair ;
- explication courte ;
- action recommandee ;
- controles essentiels ;
- details techniques repliables ;
- erreurs contextualisees.

Le centre ne doit pas afficher tous les panneaux ouverts en meme temps par
defaut. Les sections non courantes restent accessibles via le rail ou des liens
secondaires.

### Rail droit

Role : contexte et prochaines actions.

Contenu possible :

- ce que dotWeaver a detecte ;
- warnings et blocages ;
- services actifs ;
- variables generees par services ;
- suggestions de premier run ;
- liens utiles vers agent config ou project page.

Sur mobile, le rail droit devient une section sous l'action courante.

## Mode premiere fois et mode reutilisable

Le meme Readiness Center sert deux intentions.

### Premiere fois

Apres import, l'interface est plus guidee :

- langage orientee onboarding ;
- etape active calculee automatiquement ;
- CTA principal visible ;
- suggestions de premier run presentees a la fin.

### Reutilisation

Quand le projet existe deja, l'interface devient plus operationnelle :

- met en avant ce qui a change ;
- indique si la preparation est stale ;
- garde les logs et details techniques accessibles ;
- permet de refaire detect, save, provision ou prepare sans repasser par une
  narration de debutant.

## Suggestions de premier run

La v1 propose des suggestions basees sur les signaux deja disponibles, sans
analyse IA profonde obligatoire.

### Verifier le projet

But : lancer un run qui verifie les commandes configurees.

Prompt type :

```text
Verify this project setup. Run the configured install, test, and build commands
where applicable. Summarize any failures and propose the smallest safe fix.
```

Activation :

- toujours disponible si le projet est ready ;
- mise en avant si test/build commands existent.

### Comprendre le repo

But : aider l'utilisateur a obtenir une premiere carte mentale du depot.

Prompt type :

```text
Explore this repository and summarize its structure, main commands, key modules,
and the safest next tasks for an agent.
```

Activation :

- disponible quand aucun signal d'erreur prioritaire n'existe ;
- utile pour un premier contact avec un projet importe.

### Corriger un premier signal

But : transformer un warning ou une erreur de readiness en run actionnable.

Prompt type :

```text
Investigate the readiness issue shown for this project. Explain the root cause,
then implement the smallest safe fix and verify it.
```

Activation :

- mise en avant si warnings runtime, service mapping errors, prepare failed,
  ou fingerprint stale.

## Motion system

La motion doit expliquer les changements d'etat. Elle ne doit pas decorer la
surface.

Principes :

- entrees/sorties de panneaux : `transition:` ou `in:`/`out:` avec 120-220ms ;
- changement de progression : `Tween` pour pourcentage, compteurs et barres ;
- feedback de selection : `Spring` leger sur suggestions et confirmations ;
- reordonnancement de listes : `animate:flip` seulement pour les keyed each ;
- etapes qui changent : animations sur `transform` et `opacity` uniquement ;
- support obligatoire de `prefersReducedMotion`.

Easing cible :

- entree/sortie : ease-out type `cubicOut` ou CSS `cubic-bezier(0.16, 1, 0.3, 1)`;
- mouvement d'elements deja visibles : ease-in-out type `cubicInOut` ;
- hover et press : transitions 100-150ms, feedback tactile discret.

A eviter :

- scroll hijack ;
- parallax ;
- boucles persistantes decoratives ;
- animation de `height`, `width`, `top`, `left`, `padding`, `margin` ;
- loader qui modifie la taille du layout ;
- bounce visible dans les controles frequents.

## Composants cibles

La refonte peut extraire des composants depuis `ProjectSetupChecklist`.

Composants probables :

- `ProjectReadinessCenter.svelte` : orchestration de la surface complete ;
- `ReadinessRail.svelte` : rail gauche desktop et progression mobile ;
- `ReadinessActionPanel.svelte` : panneau central pour l'etape active ;
- `ReadinessContextRail.svelte` : rail droit de contexte ;
- `ReadinessSummaryCard.svelte` : resume compact pour la page projet ;
- `GuidedRunSuggestions.svelte` : cartes de prompts v1 ;
- `PrepareActivityLog.svelte` : logs compacts et repliables ;
- `ReadinessProgress.svelte` : progression animee via `Tween`.

Les helpers purs dans `environment-setup-state.ts` restent la source de calcul
d'etat. Si necessaire, les enrichir plutot que recopier la logique dans les
composants.

## Data flow

La source de verite reste serveur/DB.

```text
Project page
  -> getProject + getProjectEnvironment + getProjectEnvironmentServices
  -> compute readiness summary
  -> link/action to /setup

Readiness Center
  -> getProject
  -> getProjectEnvironment
  -> getProjectEnvironmentPrepareEvents
  -> getProjectEnvironmentServices
  -> live environment SSE
  -> live services SSE
  -> compute active step
  -> render action panel + context rail

User action
  -> detect/save/provision/prepare remote command
  -> DB updates + events
  -> SSE refreshes UI
  -> CTA advances to next recommended step

Ready
  -> choose guided run suggestion
  -> prefill run prompt
  -> launch run or return to project with selected prompt state
```

## Regles d'etape active

L'interface choisit une etape active recommandee, tout en laissant l'utilisateur
ouvrir n'importe quelle etape manuellement.

Priorite :

1. no profile -> Runtime;
2. invalid runtime -> Runtime;
3. service loading/error/provision needed -> Services;
4. prepare failed/stale/todo -> Prepare;
5. ready with no run yet -> First run;
6. otherwise -> Overview.

La selection manuelle ne doit pas etre ecrasee pendant que l'utilisateur edite
un formulaire.

## Error handling

Les erreurs apparaissent pres de l'action qui les a causees :

- detection failure inside Runtime panel ;
- save failure inside Runtime/Commands panel ;
- service creation/provision failure inside Services panel ;
- mapping errors inside the affected service ;
- prepare enqueue failure near Prepare CTA ;
- prepare runtime failure in Prepare log plus summary ;
- SSE disconnect as passive reconnect state, not a blocking modal.

Le rail doit continuer a refleter l'etat global d'echec.

## Accessibility

Exigences :

- semantic landmarks for rail, main action and context ;
- keyboard reachable step navigation ;
- visible focus states preserved ;
- no placeholder as label ;
- labels above inputs ;
- `aria-current` for active step ;
- `aria-live="polite"` for global readiness changes and prepare completion ;
- no automatic focus stealing on SSE updates ;
- reduced motion support for every animated state ;
- mobile target size at least 44px for primary tap targets.

## Tests

Expected test coverage for implementation:

### Pure helpers

- active step priority ;
- global readiness summary ;
- guided run suggestion selection based on setup state ;
- service errors blocking open project ;
- stale prepare enabling prepare again.

### Component tests

- Readiness Center shows Runtime when no profile exists ;
- ready project shows First run suggestions ;
- failed prepare shows Prepare as active step ;
- manual step selection is preserved while editing ;
- project page summary links to `/setup` when not ready ;
- project page summary offers guided run when ready ;
- reduced motion disables non-essential transition configuration where practical.

### Verification commands

Before implementation delivery:

```bash
bun run check
bun run test:unit -- --run
```

Use Svelte MCP `svelte-autofixer` on each new or substantially modified Svelte
component until no actionable issues remain.

## Out of scope

- AI-driven deep repository analysis for suggestions ;
- new database/service kinds beyond existing service infrastructure ;
- full redesign of run workspace timeline ;
- replacing the existing app shell ;
- adding Motion, GSAP or another animation dependency ;
- storing a long-lived onboarding tour state unless required by the plan.

## Success criteria

- A new project naturally leads from import to readiness to a useful first run.
- A returning user can rerun readiness without feeling trapped in first-time
  onboarding copy.
- The page project shows readiness status without duplicating the full setup UI.
- Technical details remain accessible, but do not dominate the happy path.
- Motion helps users understand state changes and respects reduced motion.
- Existing server-side readiness rules remain the final source of truth.
