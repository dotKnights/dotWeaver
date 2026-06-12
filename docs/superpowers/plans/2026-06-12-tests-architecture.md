# Tests Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move dotWeaver tests out of `src/` into a clear `tests/` architecture while preserving the existing test intent.

**Architecture:** Use one top-level `tests/` directory split by test level: `unit`, `integration`, and `e2e`. Keep a logical mirror of the application domains under each level, and use SvelteKit aliases like `$lib/...` from tests whenever possible.

**Tech Stack:** TypeScript, SvelteKit, Vitest projects, Vitest browser mode with Playwright provider, Playwright e2e, Bun scripts.

---

## File Structure

Create and use these target areas:

```text
tests/
  unit/
    lib/
      components/runs/
      schemas/
      server/
      server/mcp/
    routes/app/
  integration/
    lib/server/
    lib/server/mcp/
  e2e/
    auth.e2e.ts
    teams.e2e.ts
    helpers.ts
```

Modify these configuration files:

- `vite.config.ts`: update Vitest include/exclude patterns to point at `tests/unit` and `tests/integration`.
- `playwright.config.ts`: point Playwright at `tests/e2e` and use Bun in the web server command.
- `package.json`: keep existing scripts but use `bun run` inside the aggregate `test` script.

Delete scaffold-only demo files after migration:

- `src/lib/vitest-examples/`
- `src/routes/demo/`

---

### Task 1: Move Pure Client-Agnostic Unit Tests

**Files:**
- Move: `src/lib/schemas/*.test.ts` to `tests/unit/lib/schemas/`
- Move: `src/lib/components/runs/*.test.ts` to `tests/unit/lib/components/runs/`
- Modify imports inside moved files

- [ ] **Step 1: Create target directories**

Run:

```bash
mkdir -p tests/unit/lib/schemas tests/unit/lib/components/runs
```

Expected: directories exist and `git status --short` shows no source changes yet.

- [ ] **Step 2: Move schema unit tests**

Run:

```bash
git mv src/lib/schemas/auth.test.ts tests/unit/lib/schemas/auth.test.ts
git mv src/lib/schemas/projects.test.ts tests/unit/lib/schemas/projects.test.ts
git mv src/lib/schemas/run-interactions.test.ts tests/unit/lib/schemas/run-interactions.test.ts
git mv src/lib/schemas/runs.test.ts tests/unit/lib/schemas/runs.test.ts
git mv src/lib/schemas/teams.test.ts tests/unit/lib/schemas/teams.test.ts
```

Expected: the five schema test files are no longer under `src/lib/schemas`.

- [ ] **Step 3: Update schema test imports**

Change these imports:

```ts
import { loginSchema, registerSchema } from '$lib/schemas/auth';
import { importProjectSchema } from '$lib/schemas/projects';
import { startRunSchema, approveRunSchema, RUN_MODELS } from '$lib/schemas/runs';
import { createTeamSchema, inviteSchema } from '$lib/schemas/teams';
```

For `tests/unit/lib/schemas/run-interactions.test.ts`, import all tested symbols from:

```ts
import {
	answerRunInteractionSchema,
	askUserQuestionRequestSchema,
	type AskUserQuestionRequest
} from '$lib/schemas/run-interactions';
```

Expected: no import in `tests/unit/lib/schemas/*.test.ts` points to `./auth`, `./projects`, `./runs`, `./teams`, or `./run-interactions`.

- [ ] **Step 4: Move component helper unit tests**

Run:

```bash
git mv src/lib/components/runs/markdown.test.ts tests/unit/lib/components/runs/markdown.test.ts
git mv src/lib/components/runs/run-event-display.test.ts tests/unit/lib/components/runs/run-event-display.test.ts
git mv src/lib/components/runs/todos.test.ts tests/unit/lib/components/runs/todos.test.ts
```

Expected: the three runs component helper tests are no longer under `src/lib/components/runs`.

- [ ] **Step 5: Update component helper imports**

Use these imports:

```ts
import { renderMarkdown } from '$lib/components/runs/markdown';
import { describeToolUse, normalizeEvent } from '$lib/components/runs/run-event-display';
import { extractCurrentTodos } from '$lib/components/runs/todos';
```

Expected: the moved component helper tests import production code through `$lib/components/runs/...`.

- [ ] **Step 6: Run moved unit tests with current config to expose expected discovery failure**

Run:

```bash
bun run vitest --run tests/unit/lib/schemas tests/unit/lib/components/runs
```

Expected: tests may fail to run because `vite.config.ts` has not been updated yet. If they run, failures should only be import-resolution failures. Do not change assertions.

- [ ] **Step 7: Commit the first migration slice**

Run:

```bash
git add tests/unit/lib/schemas tests/unit/lib/components/runs src/lib/schemas src/lib/components/runs
git commit -m "refactor(tests): move pure unit tests out of src"
```

Expected: commit succeeds with only moved tests and import updates.

---

### Task 2: Move Server Unit Tests

**Files:**
- Move: `src/lib/server/*.test.ts` except `*.integration.test.ts` to `tests/unit/lib/server/`
- Move: `src/lib/server/mcp/*.test.ts` except `*.integration.test.ts` to `tests/unit/lib/server/mcp/`
- Modify imports inside moved files

- [ ] **Step 1: Create target directories**

Run:

```bash
mkdir -p tests/unit/lib/server/mcp
```

Expected: target directories exist.

- [ ] **Step 2: Move top-level server unit tests**

Run:

```bash
git mv src/lib/server/ask-user-question-tool.test.ts tests/unit/lib/server/ask-user-question-tool.test.ts
git mv src/lib/server/diff.test.ts tests/unit/lib/server/diff.test.ts
git mv src/lib/server/docker.test.ts tests/unit/lib/server/docker.test.ts
git mv src/lib/server/git.test.ts tests/unit/lib/server/git.test.ts
git mv src/lib/server/github-git.test.ts tests/unit/lib/server/github-git.test.ts
git mv src/lib/server/github.test.ts tests/unit/lib/server/github.test.ts
git mv src/lib/server/org.test.ts tests/unit/lib/server/org.test.ts
git mv src/lib/server/process-safety.test.ts tests/unit/lib/server/process-safety.test.ts
git mv src/lib/server/projects-service.test.ts tests/unit/lib/server/projects-service.test.ts
git mv src/lib/server/run-events.test.ts tests/unit/lib/server/run-events.test.ts
git mv src/lib/server/run-interactions-service.test.ts tests/unit/lib/server/run-interactions-service.test.ts
git mv src/lib/server/run-orchestrator.test.ts tests/unit/lib/server/run-orchestrator.test.ts
git mv src/lib/server/run-recovery.test.ts tests/unit/lib/server/run-recovery.test.ts
git mv src/lib/server/run-state.test.ts tests/unit/lib/server/run-state.test.ts
git mv src/lib/server/run-stream.test.ts tests/unit/lib/server/run-stream.test.ts
git mv src/lib/server/runs-service.test.ts tests/unit/lib/server/runs-service.test.ts
git mv src/lib/server/slug.test.ts tests/unit/lib/server/slug.test.ts
git mv src/lib/server/workspace-paths.test.ts tests/unit/lib/server/workspace-paths.test.ts
git mv src/lib/server/workspace.test.ts tests/unit/lib/server/workspace.test.ts
```

Expected: top-level server unit tests are no longer in `src/lib/server`.

- [ ] **Step 3: Move MCP server unit tests**

Run:

```bash
git mv src/lib/server/mcp/context.test.ts tests/unit/lib/server/mcp/context.test.ts
git mv src/lib/server/mcp/tools.test.ts tests/unit/lib/server/mcp/tools.test.ts
```

Expected: MCP unit tests are no longer in `src/lib/server/mcp`.

- [ ] **Step 4: Replace server relative imports with `$lib/server` aliases**

Apply these import replacements in `tests/unit/lib/server/*.test.ts`:

```text
./diff -> $lib/server/diff
./docker -> $lib/server/docker
./git -> $lib/server/git
./github -> $lib/server/github
./github-git -> $lib/server/github-git
./org -> $lib/server/org
./process-safety -> $lib/server/process-safety
./projects-service -> $lib/server/projects-service
./run-events -> $lib/server/run-events
./run-interactions-service -> $lib/server/run-interactions-service
./run-orchestrator -> $lib/server/run-orchestrator
./run-recovery -> $lib/server/run-recovery
./run-state -> $lib/server/run-state
./run-stream -> $lib/server/run-stream
./runs-service -> $lib/server/runs-service
./slug -> $lib/server/slug
./workspace -> $lib/server/workspace
./workspace-paths -> $lib/server/workspace-paths
```

The type-only import in `tests/unit/lib/server/run-orchestrator.test.ts` must become:

```ts
import type { RunContainerControl, RunContainerLineHandler } from '$lib/server/docker';
```

The docker runner import in `tests/unit/lib/server/ask-user-question-tool.test.ts` must become:

```ts
import { createAskUserQuestionToolHandler } from '../../../../docker/runner/ask-user-question-tool.mjs';
```

Expected: `rg "from './" tests/unit/lib/server` returns no matches except files under `tests/unit/lib/server/mcp` before the next step.

- [ ] **Step 5: Replace MCP server relative imports with `$lib/server/mcp` aliases**

Use these imports in `tests/unit/lib/server/mcp/*.test.ts`:

```ts
import { resolveOrgContext, AmbiguousTeamError, TeamAccessError, NoTeamError } from '$lib/server/mcp/context';
import { registerTools } from '$lib/server/mcp/tools';
```

Expected: `rg "from './" tests/unit/lib/server/mcp` returns no matches.

- [ ] **Step 6: Preserve Vitest mock ordering**

Inspect files that call `vi.mock(...)`:

```bash
rg -n "vi\\.mock|await import" tests/unit/lib/server
```

Expected: every `vi.mock(...)` still appears before the import of the module under test when the test depends on hoisting. For `layout` route tests and MCP integration tests, keep dynamic imports as described in later tasks.

- [ ] **Step 7: Commit server unit test moves**

Run:

```bash
git add tests/unit/lib/server src/lib/server
git commit -m "refactor(tests): move server unit tests out of src"
```

Expected: commit succeeds with only moved server unit tests and import updates.

---

### Task 3: Move Route Unit Test

**Files:**
- Move: `src/routes/(app)/layout.server.test.ts` to `tests/unit/routes/app/layout.server.test.ts`
- Modify: dynamic import inside moved test

- [ ] **Step 1: Create target directory**

Run:

```bash
mkdir -p tests/unit/routes/app
```

Expected: target directory exists.

- [ ] **Step 2: Move the route load test**

Run:

```bash
git mv 'src/routes/(app)/layout.server.test.ts' tests/unit/routes/app/layout.server.test.ts
```

Expected: the route test no longer lives in `src/routes/(app)`.

- [ ] **Step 3: Update the dynamic route import**

Change:

```ts
const { load } = await import('./+layout.server');
```

to:

```ts
const { load } = await import('../../../../src/routes/(app)/+layout.server');
```

Expected: the test still imports the real route load function after mocks are registered.

- [ ] **Step 4: Commit route unit test move**

Run:

```bash
git add tests/unit/routes/app 'src/routes/(app)'
git commit -m "refactor(tests): move route unit test out of src"
```

Expected: commit succeeds with the route test move.

---

### Task 4: Move Integration Tests

**Files:**
- Move: `src/lib/server/diff.integration.test.ts` to `tests/integration/lib/server/diff.integration.test.ts`
- Move: `src/lib/server/mcp/mcp.integration.test.ts` to `tests/integration/lib/server/mcp/mcp.integration.test.ts`
- Modify imports inside moved files

- [ ] **Step 1: Create target directories**

Run:

```bash
mkdir -p tests/integration/lib/server/mcp
```

Expected: integration target directories exist.

- [ ] **Step 2: Move integration tests**

Run:

```bash
git mv src/lib/server/diff.integration.test.ts tests/integration/lib/server/diff.integration.test.ts
git mv src/lib/server/mcp/mcp.integration.test.ts tests/integration/lib/server/mcp/mcp.integration.test.ts
```

Expected: no `*.integration.test.ts` files remain under `src/lib/server`.

- [ ] **Step 3: Update diff integration imports**

Change imports in `tests/integration/lib/server/diff.integration.test.ts` to:

```ts
import { gitOk } from '$lib/server/git';
import { computeDiff } from '$lib/server/diff';
```

Expected: the integration test uses `$lib/server` aliases.

- [ ] **Step 4: Update MCP integration route import**

Change:

```ts
import { POST } from '../../../routes/mcp/+server';
```

to:

```ts
import { POST } from '../../../../../src/routes/mcp/+server';
```

Expected: `vi.mock(...)` calls stay before the route import, and the test still imports the real SvelteKit endpoint.

- [ ] **Step 5: Commit integration test moves**

Run:

```bash
git add tests/integration src/lib/server
git commit -m "refactor(tests): move integration tests out of src"
```

Expected: commit succeeds with integration tests moved and imports updated.

---

### Task 5: Move Playwright E2E Tests

**Files:**
- Move: `e2e/auth.e2e.ts` to `tests/e2e/auth.e2e.ts`
- Move: `e2e/teams.e2e.ts` to `tests/e2e/teams.e2e.ts`
- Move: `e2e/helpers.ts` to `tests/e2e/helpers.ts`
- Move: `e2e/global-teardown.ts` to `tests/e2e/global-teardown.ts`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Create target directory**

Run:

```bash
mkdir -p tests/e2e
```

Expected: target directory exists.

- [ ] **Step 2: Move Playwright files**

Run:

```bash
git mv e2e/auth.e2e.ts tests/e2e/auth.e2e.ts
git mv e2e/teams.e2e.ts tests/e2e/teams.e2e.ts
git mv e2e/helpers.ts tests/e2e/helpers.ts
git mv e2e/global-teardown.ts tests/e2e/global-teardown.ts
```

Expected: the top-level `e2e/` directory is empty or removable.

- [ ] **Step 3: Remove empty e2e directory if present**

Run:

```bash
rmdir e2e 2>/dev/null || true
```

Expected: `e2e/` is removed if empty.

- [ ] **Step 4: Update Playwright config**

Replace the full contents of `playwright.config.ts` with:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests/e2e',
	testMatch: '**/*.e2e.{ts,js}',
	globalTeardown: './tests/e2e/global-teardown.ts',
	timeout: 30000,
	use: {
		// Must match BETTER_AUTH_URL so better-auth accepts the request Origin (CSRF check).
		baseURL: 'http://localhost:5173'
	},
	webServer: {
		command: 'bun run build && bun run preview -- --port 5173',
		port: 5173,
		timeout: 120000,
		reuseExistingServer: !process.env.CI
	}
});
```

Expected: Playwright only discovers tests under `tests/e2e`.

- [ ] **Step 5: Commit e2e migration**

Run:

```bash
git add tests/e2e playwright.config.ts e2e
git commit -m "refactor(tests): move e2e tests under tests"
```

Expected: commit succeeds with Playwright files moved and config updated.

---

### Task 6: Update Vitest Discovery and Bun Scripts

**Files:**
- Modify: `vite.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Update Vitest config**

Replace the full contents of `vite.config.ts` with:

```ts
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					passWithNoTests: true,
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['tests/unit/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**', 'tests/unit/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: [
						'tests/unit/**/*.{test,spec}.{js,ts}',
						'tests/integration/**/*.{test,spec}.{js,ts}'
					],
					exclude: ['tests/unit/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
```

Expected: Vitest discovers moved tests under `tests/` and does not discover Playwright e2e tests.

- [ ] **Step 2: Update package scripts to use Bun internally**

In `package.json`, replace only the `test` script value:

```json
"test": "bun run test:unit -- --run && bun run test:e2e"
```

Leave the other script names unchanged.

Expected: `bun run test` no longer shells out through `npm run`.

- [ ] **Step 3: Run Vitest discovery**

Run:

```bash
bun run test:unit -- --run --reporter=dot
```

Expected: Vitest runs tests from `tests/unit` and `tests/integration`. It should not run `tests/e2e`.

- [ ] **Step 4: Fix import-resolution failures only**

If Step 3 fails with import resolution errors, fix only the broken import path. Use `$lib/...` for production modules and relative imports only for files under `tests/`.

Expected: no assertion text or production behavior changes are made in this task.

- [ ] **Step 5: Commit config updates**

Run:

```bash
git add vite.config.ts package.json tests
git commit -m "build(tests): point vitest at tests directory"
```

Expected: commit succeeds with config and import-resolution fixes.

---

### Task 7: Remove Test Scaffold Demos From src

**Files:**
- Delete: `src/lib/vitest-examples/`
- Delete: `src/routes/demo/`

- [ ] **Step 1: Remove Vitest example files**

Run:

```bash
git rm -r src/lib/vitest-examples
```

Expected: `src/lib/vitest-examples` is removed.

- [ ] **Step 2: Remove Playwright demo route**

Run:

```bash
git rm -r src/routes/demo
```

Expected: `src/routes/demo` is removed, including the scaffold Playwright demo test and demo route.

- [ ] **Step 3: Confirm no source imports depend on demos**

Run:

```bash
rg -n "vitest-examples|/demo/playwright|routes/demo|Welcome\\.svelte|greet" src tests package.json
```

Expected: no matches.

- [ ] **Step 4: Commit scaffold cleanup**

Run:

```bash
git add src/lib src/routes
git commit -m "chore(tests): remove scaffold test demos"
```

Expected: commit succeeds with only scaffold demo deletion.

---

### Task 8: Verify Final Architecture

**Files:**
- Read-only verification across repository

- [ ] **Step 1: Verify no test files remain in `src/`**

Run:

```bash
rg --files src -g '*.{test,spec,e2e}.{ts,js}' -g '*.{test,spec,e2e}.svelte.{ts,js}'
```

Expected: no output.

- [ ] **Step 2: Verify tests are under the expected roots**

Run:

```bash
find tests -type f \( -name '*.test.ts' -o -name '*.spec.ts' -o -name '*.e2e.ts' -o -name '*.svelte.test.ts' -o -name '*.svelte.spec.ts' \) | sort
```

Expected: output contains only files under `tests/unit`, `tests/integration`, and `tests/e2e`.

- [ ] **Step 3: Run unit and integration tests**

Run:

```bash
bun run test:unit -- --run
```

Expected: all Vitest tests pass.

- [ ] **Step 4: Run Playwright e2e tests**

Run:

```bash
bun run test:e2e
```

Expected: all Playwright tests pass. If the local browser install or app environment fails, capture the exact error and confirm whether it is environmental before changing code.

- [ ] **Step 5: Run SvelteKit type and lint checks**

Run:

```bash
bun run check
bun run lint
```

Expected: both commands pass. If lint formats moved files differently, run `bun run format`, inspect the diff, and rerun `bun run lint`.

- [ ] **Step 6: Final status check**

Run:

```bash
git status --short
```

Expected: only intentional changes remain, and `.codex/` may remain untracked from the local Codex app state.

- [ ] **Step 7: Commit final verification fixes if any**

If Steps 3-5 required fixes, commit them:

```bash
git add package.json playwright.config.ts vite.config.ts tests src
git commit -m "fix(tests): resolve migrated test paths"
```

Expected: commit succeeds only if there were real fixes after verification.

---

## Self-Review Notes

Spec coverage:

- Tests move out of `src/`: Tasks 1-5 and Task 8.
- Unit/integration/e2e split: Tasks 1-5.
- `$lib` aliases from tests: Tasks 1-4.
- Vitest and Playwright config updates: Tasks 5-6.
- Scaffold demo cleanup: Task 7.
- Verification commands: Task 8.

Known implementation risk:

- `passWithNoTests: true` is included for the Vitest browser project because the current scaffold Svelte component tests are deleted and there may be no browser-mode component tests left after migration.
