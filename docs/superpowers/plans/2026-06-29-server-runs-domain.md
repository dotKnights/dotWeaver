# Server Runs Domain Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move run-related server modules from the broad `src/lib/server` root into a coherent `src/lib/server/runs` domain without changing behavior.

**Architecture:** Keep the current public functions intact and move files mechanically first. Update every `$lib/server/run*` and `$lib/server/runs-service` import to point at `$lib/server/runs/*`, then verify with targeted run tests before the full quality suite.

**Tech Stack:** SvelteKit, TypeScript, Bun, Vitest, ESLint, Prettier.

---

### Task 1: Move Runs Modules

**Files:**
- Move: `src/lib/server/run-events.ts` to `src/lib/server/runs/events.ts`
- Move: `src/lib/server/run-interaction-answer-parser.ts` to `src/lib/server/runs/interaction-answer-parser.ts`
- Move: `src/lib/server/run-interactions-service.ts` to `src/lib/server/runs/interactions-service.ts`
- Move: `src/lib/server/run-orchestrator.ts` to `src/lib/server/runs/orchestrator.ts`
- Move: `src/lib/server/run-recovery.ts` to `src/lib/server/runs/recovery.ts`
- Move: `src/lib/server/run-reply-service.ts` to `src/lib/server/runs/reply-service.ts`
- Move: `src/lib/server/run-state.ts` to `src/lib/server/runs/state.ts`
- Move: `src/lib/server/run-stream.ts` to `src/lib/server/runs/stream.ts`
- Move: `src/lib/server/run-transitions.ts` to `src/lib/server/runs/transitions.ts`
- Move: `src/lib/server/runs-service.ts` to `src/lib/server/runs/service.ts`
- Move: `src/lib/server/run-transitions.test.ts` to `src/lib/server/runs/transitions.test.ts`

- [ ] **Step 1: Create the target folder**

Run: `mkdir -p src/lib/server/runs`

- [ ] **Step 2: Move files with git**

Run the exact `git mv` commands listed in the file list above.

- [ ] **Step 3: Update internal imports**

Replace root imports like `$lib/server/run-events` with domain imports like `$lib/server/runs/events`. In colocated files under `src/lib/server/runs`, prefer relative imports such as `./events`.

- [ ] **Step 4: Update external imports and mocks**

Update route handlers, RFC functions, MCP tools, runner entrypoint, and tests to import from `$lib/server/runs/*`.

- [ ] **Step 5: Verify targeted run tests**

Run: `bun run test:unit -- --run tests/unit/lib/server/run-events.test.ts tests/unit/lib/server/run-state.test.ts tests/unit/lib/server/run-stream.test.ts tests/unit/lib/server/run-interactions-service.test.ts tests/unit/lib/server/run-reply-service.test.ts tests/unit/lib/server/runs-service.test.ts tests/unit/lib/server/run-orchestrator.test.ts tests/unit/lib/server/run-recovery.test.ts tests/unit/lib/server/run-interaction-answer-parser.test.ts tests/unit/lib/rfc/runs.remote.test.ts`

Expected: all targeted tests pass.

### Task 2: Final Verification

**Files:**
- Modify: `docs/code-cleanliness-audit.md`

- [ ] **Step 1: Update audit report**

Record that the `runs` domain has moved under `src/lib/server/runs` and update the `src/lib/server` root file count.

- [ ] **Step 2: Run full verification**

Run:
- `bun run check`
- `bun run lint`
- `bun run test:unit -- --run`
- `bun run quality:audit`
- `git diff --check`

Expected: all commands exit 0. Existing Prisma and Vitest/SvelteKit noise may remain only if unchanged from the previous baseline.
