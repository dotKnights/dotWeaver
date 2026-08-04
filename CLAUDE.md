# dotWeaver — CLAUDE.md

## What is dotWeaver?

dotWeaver is a **control plane for running AI coding agents** (Claude Code, Codex, etc.) on GitHub repositories inside isolated Docker containers. Teams use it to manage projects, configure agents (MCP servers, skills, secrets, env vars), launch runs, review generated diffs, and push branches/PRs — all from a collaborative web UI.

---

## Stack

| Layer | Technology |
|---|---|
| Framework | SvelteKit 2 + Svelte 5 |
| Language | TypeScript (strict) |
| Runtime / Package manager | Bun |
| Database | PostgreSQL via Prisma ORM |
| Auth | Better Auth |
| Styling | TailwindCSS v4 |
| UI primitives | bits-ui |
| Validation | Zod |
| Unit tests | Vitest |
| E2E tests | Playwright |
| Agent runtime | Docker (isolated containers) |
| Realtime | Server-Sent Events (SSE) |
| Agent protocol | MCP (exposed at `/mcp`) |

---

## Key Commands

```bash
# Development
bun run dev

# Type check
bun run check

# Lint
bun run lint

# Format
bun run format

# Unit tests
bun run test:unit

# E2E tests (Playwright)
bun run test:e2e

# Full quality audit (lint + check + tests)
bun run quality:audit
```

**Always run `bun run quality:audit` before considering a feature complete.**

---

## Architecture

### 1. Server Actions — the RFC Pattern (`src/lib/rfc/*.remote.ts`)

This codebase uses a **custom server action pattern** — NOT tRPC. Every server-side data operation that a component calls goes through an `*.remote.ts` file in `src/lib/rfc/`.

```ts
// src/lib/rfc/run.remote.ts
import { query, command } from '$app/server';

// Read operations → query()
export const getRun = query(async ({ params }) => {
  // calls service layer, never Prisma directly
});

// Write operations → command()
export const createRun = command(async ({ params, data }) => {
  // calls service layer, validates with Zod
});
```

**Rules:**
- `query` for reads, `command` for writes — never reversed
- Remote files call the **service layer**, never Prisma directly
- All inputs validated with Zod schemas from `src/lib/schemas/`
- Authorization enforced inside the remote via `src/lib/server/authz/`

### 2. Service Layer (`src/lib/server/*/service.ts`)

Business logic lives in service files, one per domain area. Services:
- Receive validated, authorized inputs
- Orchestrate Prisma queries and cross-service calls
- Throw typed error classes on failure
- **Never** import from `$lib/components/` or touch the HTTP layer

```ts
// src/lib/server/run/service.ts
export class RunService {
  async createRun(input: CreateRunInput): Promise<Run> {
    // ...
  }
}

// Typed errors — always, no raw Error throws
export class RunWorkspaceUnavailableError extends Error {
  constructor(public runId: string) {
    super(`Workspace unavailable for run ${runId}`);
    this.name = 'RunWorkspaceUnavailableError';
  }
}
```

### 3. Schemas (`src/lib/schemas/*.ts`)

Zod schemas are the **single source of truth** for data shapes, shared between client and server. Never duplicate types manually.

```ts
// src/lib/schemas/run.ts
export const CreateRunSchema = z.object({
  projectId: z.string().cuid(),
  agentType: z.enum(['claude-code', 'codex']),
  branch: z.string().min(1),
});
export type CreateRunInput = z.infer<typeof CreateRunSchema>;
```

### 4. Authorization (`src/lib/server/authz/`)

**Every remote function that touches a resource must call the appropriate authz helper.** There are no exceptions.

```ts
import { requireActor } from '$lib/server/authz/require-actor';
import { requireProjectPermission } from '$lib/server/authz/require-project-permission';
import { requireRunPermission } from '$lib/server/authz/require-run-permission';

// In a remote:
const actor = await requireActor(event);
await requireProjectPermission(actor, projectId, 'runs:write');
```

- `requireActor` — asserts authenticated session, returns typed actor
- `requireProjectPermission(actor, projectId, permission)` — org-scoped project check
- `requireRunPermission(actor, runId, permission)` — run-level check
- **Org scoping is mandatory** on every Prisma query that touches tenant data

### 5. Domain Logic (`src/lib/domain/`)

Pure functions and types with **zero side effects** and **zero imports from server code**. Used for business rules about statuses, transitions, and interaction states.

```ts
// src/lib/domain/run-status.ts
export function isTerminalStatus(status: RunStatus): boolean { ... }
export function canTransitionTo(from: RunStatus, to: RunStatus): boolean { ... }
```

Domain files are unit-tested exhaustively. If you find yourself adding conditionals about run state, it belongs here.

### 6. Components (`src/lib/components/<feature>/`)

Components are grouped by feature domain, not by type:

```
src/lib/components/
  run/          ← RunCard, RunStatusBadge, RunTimeline
  project/      ← ProjectHeader, ProjectSettings
  diff/         ← DiffViewer, FileTree
  agent/        ← AgentConfigForm, McpServerList
```

Components are **Svelte 5** with runes. No Options API, no `$:` reactive statements.

### 7. Runtime (`src/lib/server/runtime/`)

Handles agent lifecycle: job queue, Docker container management, process safety, and SSE streaming. This is sensitive infrastructure — changes here require careful review and testing.

---

## Coding Standards

### TypeScript
- `strict: true` is non-negotiable — no `@ts-ignore`, no `as any`, no `any` type annotations
- Always type function return values explicitly for exported functions
- Use `unknown` instead of `any` when type is genuinely uncertain, then narrow it
- Prefer `type` over `interface` unless declaration merging is needed

### Error Handling
- Define typed error classes per service — never `throw new Error('string')`
- Handle errors at the boundary (remote layer), not deep in services
- SSE and runtime errors must be caught and streamed, never swallowed

```ts
// ✅ Correct
export class RunMutationError extends Error {
  constructor(public cause: unknown) {
    super('Run mutation failed');
    this.name = 'RunMutationError';
  }
}

// ❌ Wrong
throw new Error('something went wrong');
```

### Comments
- **French comments are the project convention** — write new comments in French
- Comments explain *why*, not *what*
- English is acceptable for inline type annotations and JSDoc

```ts
// Vérifie que le runner est disponible avant de créer le workspace
const isAvailable = await runtimeService.checkAvailability(runnerId);
```

### Svelte 5 Runes
- Use `$state()`, `$derived()`, `$effect()` — never `writable()` / `$:` / `onMount` for reactive state
- `$effect` must clean up subscriptions (return a teardown function)
- `$props()` with explicit type destructuring only

```svelte
<script lang="ts">
  import type { Run } from '$lib/schemas/run';

  let { run, onComplete }: { run: Run; onComplete: () => void } = $props();

  let isExpanded = $state(false);
  let statusLabel = $derived(getStatusLabel(run.status));

  $effect(() => {
    const unsub = subscribeToRun(run.id, handleUpdate);
    return () => unsub();
  });
</script>
```

---

## Forbidden Patterns

```ts
// ❌ Direct Prisma in components or +page.svelte
import { prisma } from '$lib/server/db';

// ❌ console.log in production code (use structured logging)
console.log('debug value:', val);

// ❌ Calling server imports from client-side .svelte files
import { RunService } from '$lib/server/run/service';

// ❌ Raw SQL bypassing Prisma (except in documented migrations)
prisma.$queryRaw`SELECT ...`;

// ❌ any type
function process(data: any) { ... }

// ❌ Unscoped DB queries (always filter by orgId)
await prisma.project.findMany(); // missing where: { orgId }

// ❌ Skipping authz in remote functions
export const deleteRun = command(async ({ params }) => {
  // no requireActor call → security hole
  await runService.deleteRun(params.runId);
});

// ❌ Svelte 4 reactivity in Svelte 5 components
let count = 0;
$: doubled = count * 2;
```

---

## Test Conventions

### Unit Tests (Vitest) — `src/lib/**/*.test.ts`

For domain logic and service layer. Mirror the file structure:

```
src/lib/domain/run-status.ts          → src/lib/domain/run-status.test.ts
src/lib/server/run/service.ts         → src/lib/server/run/service.test.ts
```

Pattern from existing tests:

```ts
// run-status.test.ts
import { describe, it, expect } from 'vitest';
import { isTerminalStatus, canTransitionTo } from './run-status';

describe('isTerminalStatus', () => {
  it('returns true for completed status', () => {
    expect(isTerminalStatus('completed')).toBe(true);
  });
  it('returns false for running status', () => {
    expect(isTerminalStatus('running')).toBe(false);
  });
});
```

Service tests use mocked Prisma clients — never test against a real DB in unit tests.

### E2E Tests (Playwright) — `tests/`

For critical user flows: launching a run, reviewing a diff, pushing a PR. Keep E2E tests focused on workflows that span multiple pages or require auth.

```ts
// tests/run-lifecycle.spec.ts
test('user can launch a run and see it appear in the list', async ({ page }) => {
  await page.goto('/projects/test-project');
  await page.getByRole('button', { name: 'New Run' }).click();
  // ...
});
```

---

## Workflow Before Coding

1. **Explore first** — read the existing code in the relevant feature area before writing anything
2. **Find the pattern** — look at a similar remote/service/component to understand conventions
3. **Check schemas** — does the Zod schema you need already exist in `src/lib/schemas/`?
4. **Check authz** — identify which `require*` helpers apply to your resource
5. **Write the service first** — business logic before HTTP/component layer
6. **Write the remote** — thin adapter: validate → authorize → call service → return
7. **Write the component** — consume the remote via SvelteKit's `use:enhance` or `load` functions
8. **Write tests** — domain/service unit tests minimum; E2E for new critical flows
9. **Run `bun run quality:audit`** — zero errors, zero warnings before marking done

---

## MCP Server & SSE

- The MCP server is exposed at the `/mcp` route — this is the agent's programmatic interface
- Changes to MCP tool definitions must be backward-compatible (running agents may use old definitions)
- SSE endpoints live in `+server.ts` files under the relevant route; always send `Content-Type: text/event-stream` and handle client disconnect via `request.signal`

---

## Docker Runtime

- Agent containers are ephemeral — no state persists between runs except what is explicitly committed
- Container lifecycle is managed by `src/lib/server/runtime/` — do not call Docker APIs directly elsewhere
- Secrets are injected at container start, never logged, never stored in run output
