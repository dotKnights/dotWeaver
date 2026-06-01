# Design : Rendu UI des events de run

**Date** : 2026-06-01
**Issue** : DOT-16 (amélioration UI)
**Statut** : Approuvé (en attente de relecture finale)

## Objectif

Remplacer l'affichage actuel des `RunEvent` (messages JSON bruts résumés) par un **rendu riche
et lisible**, adapté au type de chaque event : messages de l'agent en markdown, appels d'outils
en cartes, résultats d'outils repliables, thinking repliable, carte de résultat final, activité
des sous-agents. Le même rendu sert à la fois au **flux live** (SSE) et aux **events persistés**.

## Décisions cadrées

| Sujet | Décision |
|---|---|
| Ambition | **Rendu riche par type** (pas IDE-complet : pas de diff inline par Write/Edit, pas de compteur de tokens live, pas de filtres — réservés à plus tard). |
| Texte assistant | **Markdown rendu + sanitization** (`marked` + `isomorphic-dompurify`). |
| Architecture | **Normaliseur pur** `normalizeEvent(payload) → DisplayEvent[]` + composant `<RunEvent>` qui fait un `switch` sur `kind`. Réutilisé par live + persisté. |
| Diff inline (Write/Edit) | Hors périmètre (la vue diff de la Phase 4 le couvre déjà). On affiche juste le chemin de fichier. |

## Taxonomie réelle des `run_event` (relevée en base, 101 events)

| `payload.type[:subtype]` | Contenu pertinent |
|---|---|
| `assistant` | `message.content[]` : `thinking`, `text`, `tool_use` (un event → plusieurs items) + usage |
| `user` | `message.content[]` : `tool_result` (avec `is_error`), parfois `text` |
| `result` (`:success`/erreur) | `result` (texte), `subtype`, `is_error`, `num_turns`, `total_cost_usd`, `duration_ms` |
| `system:init` | `model`, `tools[]`, `session_id` |
| `system:task_started` | sous-agent : `prompt` |
| `system:task_progress` | sous-agent : `description` (commande en cours), `usage` |
| `system:task_notification` | sous-agent : `summary`, `status` |
| `rate_limit_event` | `rate_limit_info` : `status`, `resetsAt`, `rateLimitType`, `isUsingOverage` |
| `runner_summary` | interne (notre entrypoint) : `head`, `session_id`, `result_subtype` |

## Architecture

### 1. Normaliseur (pur, testable)

`src/lib/components/runs/run-event-display.ts`

- **`type DisplayEvent`** — union discriminée par `kind` :
  - `{ kind: 'session_start', model: string }`
  - `{ kind: 'thinking', text: string }`
  - `{ kind: 'assistant_text', markdown: string }`
  - `{ kind: 'tool_use', tool: string, title: string, detail: string }`
  - `{ kind: 'tool_result', text: string, isError: boolean }`
  - `{ kind: 'result', isError: boolean, subtype: string, numTurns: number | null, costUsd: number | null, durationMs: number | null, text: string }`
  - `{ kind: 'subagent', phase: 'started' | 'progress' | 'done', label: string, status: string | null }`
  - `{ kind: 'rate_limit', status: string, resetsAt: number | null }`
  - `{ kind: 'hidden' }` (ex. `runner_summary`)
  - `{ kind: 'raw', json: string }` (fallback pour tout type inconnu — rien ne casse)
- **`normalizeEvent(payload: unknown): DisplayEvent[]`** — un payload peut produire **plusieurs**
  items (un `assistant` avec `[thinking, text, tool_use]` → 3 items). Mapping par `payload.type`
  (+ `subtype`). Type inconnu / forme inattendue → `[{ kind: 'raw', json }]`.
- **`describeToolUse(name: string, input: Record<string, unknown>): { title, detail }`** (pur) :
  `Bash` → `{ title: 'Bash', detail: input.command }` ; `Write`/`Edit`/`Read` →
  `{ title: name, detail: input.file_path }` ; `Glob`/`Grep` → `detail: input.pattern` ;
  défaut → `{ title: name, detail: JSON.stringify(input) }`. Détail tronqué si très long.

### 2. Composant `<RunEvent>`

`src/lib/components/runs/RunEvent.svelte` — `props: { event: DisplayEvent }`. `switch` sur `kind` :
- `session_start` → petite ligne d'en-tête « Session · {model} ».
- `thinking` → bloc repliable, texte atténué (replié par défaut).
- `assistant_text` → `<Markdown>`.
- `tool_use` → carte « 🔧 {title} » + `detail` en mono (tronqué/scroll si long).
- `tool_result` → bloc repliable (souvent long), bordure/texte rouge si `isError`.
- `result` → carte de synthèse « ✓ Success · {numTurns} turns · ${costUsd} · {durationMs}ms »
  (✗ rouge si `isError`), + `text` en markdown si présent.
- `subagent` → ligne indentée « ⤷ sous-agent : {label} » (+ statut si `done`).
- `rate_limit` → masqué si `status === 'allowed'` ; sinon bandeau discret « quota … (reset …) ».
- `hidden` → ne rend rien.
- `raw` → `<pre>` JSON (fallback de secours).

### 3. Composant `<Markdown>`

`src/lib/components/runs/Markdown.svelte` — `props: { source: string }`. Rend
`marked.parse(source)` **sanitizé** via `isomorphic-dompurify` (fonctionne en SSR et client),
injecté par `{@html}`. La sortie d'agent n'étant pas de confiance, la sanitization est
obligatoire (neutralise `<script>`, handlers `on*`, etc.).

### 4. Câblage dans la page run

`src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`

- Construire une liste plate de `DisplayEvent` à partir de la source courante :
  - flux **live** : `liveEvents.flatMap((e) => normalizeEvent(e.payload))`
  - sinon **persisté** : `run.current.events.flatMap((e) => normalizeEvent(e.payload))`
- Filtrer les `kind === 'hidden'`, puis `{#each}` → `<RunEvent {event} />`.
- On conserve la logique live/persisté et le reste de la page (statut, diff Phase 4, prompt,
  bouton cancel) inchangés. Les clés `{#each}` : index stable suffisant (liste append-only).

### 5. Dépendances

- Ajout : `marked`, `isomorphic-dompurify`. (Aucune autre.)

### 6. Gestion des erreurs

- Tout payload inattendu → `kind: 'raw'` (jamais d'exception qui casse la liste).
- `<Markdown>` : si `marked`/sanitize échoue, repli sur le texte brut échappé.

### 7. Tests

- **Unit (vitest)** : `normalizeEvent` pour chaque type (assistant multi-blocs, user tool_result
  + isError, result, system:init, system:task_*, rate_limit, runner_summary→hidden, type
  inconnu→raw) ; `describeToolUse` (Bash/Write/Edit/Read/Glob/Grep/défaut) ; sanitization
  (`<script>` retiré du rendu markdown).
- **Composant** : `svelte-autofixer` jusqu'à 0 issue ; smoke manuel sur un run réel.

## Hors périmètre (YAGNI)

- Diff inline par Write/Edit (couvert par la vue diff Phase 4).
- Compteur de tokens / coût en temps réel, filtres par type, timeline (IDE-like — plus tard).
- Coloration syntaxique des blocs de code (marked rend le `<pre><code>` ; highlighting = plus tard).
- Persistance d'un état « replié/déplié » entre rafraîchissements.

## Structure de fichiers

- Create : `src/lib/components/runs/run-event-display.ts` (normaliseur + `describeToolUse` + types)
- Create : `src/lib/components/runs/run-event-display.test.ts`
- Create : `src/lib/components/runs/Markdown.svelte`
- Create : `src/lib/components/runs/RunEvent.svelte`
- Modify : `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte` (câblage)
- Modify : `package.json` (deps `marked`, `isomorphic-dompurify`)
