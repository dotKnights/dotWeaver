# Project Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated `/projects/:id/setup` onboarding flow after GitHub import so project environments are detected, configured, prepared once, and opened only when ready or explicitly optional.

**Architecture:** Keep the existing project environment backend as the source of truth. Extract small shared UI helpers for environment readiness and live SSE merging, redirect successful imports to the setup route, and add a Svelte setup page that reuses the existing environment remote functions and live environment stream.

**Tech Stack:** SvelteKit 5 routes and remote functions, Svelte 5 runes, `svelte/reactivity`, existing shadcn-svelte UI components, Vitest browser component tests, Bun.

---

## Scope Check

This plan implements only the v1 onboarding surface from the spec:

- redirect after GitHub import;
- dedicated `/projects/:id/setup` route;
- checklist-style setup UI;
- live environment status/log updates;
- optional prepare when `installCommand` is empty;
- warning/link back to setup from the project page.

It intentionally does not create service modules such as Postgres or Redis, does not add AI detection, and does not migrate run event streaming.

## File Structure

Create:

- `src/lib/components/projects/environment-setup-state.ts` -- pure UI/domain helpers for environment readiness, step status, event labels and prepare log merging.
- `src/lib/components/projects/project-environment-live.svelte.ts` -- reusable Svelte 5 live state wrapper around the environment SSE endpoint.
- `src/lib/components/projects/ProjectSetupChecklist.svelte` -- setup checklist UI, primary CTA, and embedded environment controls.
- `src/routes/(app)/projects/[id]/setup/+page.svelte` -- route wiring remote functions, project data, environment data and live state.
- `tests/unit/lib/components/projects/environment-setup-state.test.ts` -- unit coverage for setup decisions.
- `tests/unit/lib/components/projects/project-setup-checklist.svelte.test.ts` -- browser component coverage for the setup UI.
- `tests/unit/routes/projects-page.svelte.test.ts` -- browser component coverage for redirecting after import.
- `tests/unit/routes/project-setup-page.svelte.test.ts` -- browser component smoke coverage for route wiring.

Modify:

- `src/routes/(app)/projects/+page.svelte` -- call `goto('/projects/:id/setup')` after successful import.
- `src/routes/(app)/projects/[id]/+page.svelte` -- replace local live EventSource code with `createProjectEnvironmentLiveState` and add a setup warning link when needed.
- `src/lib/components/projects/EnvironmentPanel.svelte` -- import shared helpers for readiness/event labels instead of keeping duplicate local logic.
- `tests/unit/lib/components/projects/environment-panel.svelte.test.ts` -- keep existing expectations passing with shared helpers.

## Svelte Notes

Use the official Svelte MCP docs consulted for this plan:

- `kit/routing`: create `src/routes/(app)/projects/[id]/setup/+page.svelte` for `/projects/:id/setup`.
- `kit/$app-navigation`: use `goto` for post-import navigation.
- `kit/remote-functions`: keep existing remote queries/commands as the data boundary and refresh source.
- `svelte/$state`, `svelte/$derived`, `svelte/$effect`: use runes for local state, derived setup state and EventSource lifecycle.
- `svelte/reactivity`: use `SvelteMap` when merging live events.
- `svelte/testing`: prefer browser component tests for `.svelte` files, pure unit tests for extracted helpers.

Run `mcp__svelte.svelte_autofixer` on each new or modified `.svelte` and `.svelte.ts` file before final verification.

---

### Task 1: Shared Environment Setup State

**Files:**

- Create: `src/lib/components/projects/environment-setup-state.ts`
- Test: `tests/unit/lib/components/projects/environment-setup-state.test.ts`
- Modify: `src/lib/components/projects/EnvironmentPanel.svelte`
- Test: `tests/unit/lib/components/projects/environment-panel.svelte.test.ts`

- [ ] **Step 1: Write failing helper tests**

Create `tests/unit/lib/components/projects/environment-setup-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	computeEnvironmentSetupState,
	eventLabel,
	isPreparedEnvironment,
	mergePrepareEvents,
	type EnvironmentProfile,
	type PrepareEvent
} from '$lib/components/projects/environment-setup-state';

function env(overrides: Partial<EnvironmentProfile> = {}): EnvironmentProfile {
	return {
		id: 'env1',
		status: 'ready',
		runtime: 'node',
		packageManager: 'bun',
		installCommand: 'bun install',
		currentFingerprint: 'fp1',
		lastPreparedFingerprint: 'fp1',
		lastPrepareStatus: 'succeeded',
		lastPrepareError: null,
		warnings: [],
		...overrides
	};
}

describe('environment setup state', () => {
	it('marks a current ready profile as prepared', () => {
		expect(isPreparedEnvironment(env())).toBe(true);
		expect(computeEnvironmentSetupState(env()).prepare.status).toBe('ready');
		expect(computeEnvironmentSetupState(env()).primaryAction).toBe('open_project');
	});

	it('does not mark detected profiles as prepared even with matching fingerprints', () => {
		const state = computeEnvironmentSetupState(env({ status: 'detected' }));
		expect(isPreparedEnvironment(env({ status: 'detected' }))).toBe(false);
		expect(state.prepare.status).toBe('todo');
		expect(state.primaryAction).toBe('prepare');
	});

	it('makes prepare optional when no install command is configured', () => {
		const state = computeEnvironmentSetupState(
			env({
				status: 'detected',
				installCommand: '',
				lastPrepareStatus: 'never',
				lastPreparedFingerprint: null
			})
		);
		expect(state.prepare.status).toBe('optional');
		expect(state.primaryAction).toBe('open_project');
		expect(state.canOpenProject).toBe(true);
	});

	it('asks for detection when no profile exists', () => {
		const state = computeEnvironmentSetupState(null);
		expect(state.runtime.status).toBe('todo');
		expect(state.primaryAction).toBe('detect');
		expect(state.canOpenProject).toBe(false);
	});

	it('reports stale and failed prepare states', () => {
		expect(
			computeEnvironmentSetupState(
				env({ currentFingerprint: 'fp2', lastPreparedFingerprint: 'fp1' })
			).prepare.status
		).toBe('stale');
		expect(computeEnvironmentSetupState(env({ lastPrepareStatus: 'failed' })).prepare.status).toBe(
			'failed'
		);
	});

	it('extracts readable prepare event labels', () => {
		expect(eventLabel({ type: 'output', payload: { text: 'bun install' } })).toBe('bun install');
		expect(eventLabel({ type: 'error', payload: { message: 'failed' } })).toBe('failed');
		expect(eventLabel({ type: 'system', payload: 'plain text' })).toBe('plain text');
	});

	it('merges initial and live prepare events by seq', () => {
		const initial: PrepareEvent[] = [
			{ id: 'a', seq: 1, type: 'system', payload: { text: 'old' } },
			{ id: 'b', seq: 2, type: 'output', payload: { text: 'initial' } }
		];
		const live: PrepareEvent[] = [
			{ id: 'b-live', seq: 2, type: 'output', payload: { text: 'live replacement' } },
			{ id: 'c', seq: 3, type: 'result', payload: { status: 'succeeded' } }
		];

		expect(mergePrepareEvents(initial, live).map((event) => event.payload)).toEqual([
			{ text: 'old' },
			{ text: 'live replacement' },
			{ status: 'succeeded' }
		]);
	});
});
```

- [ ] **Step 2: Run helper tests to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/lib/components/projects/environment-setup-state.test.ts --run
```

Expected: FAIL with module not found for `$lib/components/projects/environment-setup-state`.

- [ ] **Step 3: Implement shared setup state helpers**

Create `src/lib/components/projects/environment-setup-state.ts`:

```ts
export type EnvironmentProfile = Record<string, unknown> & {
	id?: string | null;
	runtime?: string | null;
	packageManager?: string | null;
	status?: string | null;
	currentFingerprint?: string | null;
	lastPreparedFingerprint?: string | null;
	lastPrepareStatus?: string | null;
	lastPrepareError?: string | null;
	installCommand?: string | null;
	testCommand?: string | null;
	buildCommand?: string | null;
	devCommand?: string | null;
	warnings?: unknown;
};

export type PrepareEvent = {
	id?: string | null;
	seq?: number | null;
	type?: string | null;
	payload?: unknown;
	createdAt?: string | Date | null;
};

export type SetupStepStatus =
	| 'todo'
	| 'ready'
	| 'warning'
	| 'failed'
	| 'running'
	| 'optional'
	| 'stale';
export type SetupPrimaryAction = 'detect' | 'prepare' | 'open_project';

export type EnvironmentSetupState = {
	runtime: { status: SetupStepStatus; label: string };
	envVars: { status: SetupStepStatus; label: string };
	services: { status: SetupStepStatus; label: string };
	prepare: { status: SetupStepStatus; label: string };
	canOpenProject: boolean;
	primaryAction: SetupPrimaryAction;
};

export function warningLabel(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === null || value === undefined) return '';
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function normalizeWarnings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(warningLabel).filter(Boolean);
}

export function isPreparedEnvironment(profile: EnvironmentProfile | null): boolean {
	return (
		profile?.status === 'ready' &&
		!!profile.installCommand?.trim() &&
		profile.lastPrepareStatus === 'succeeded' &&
		profile.currentFingerprint === profile.lastPreparedFingerprint
	);
}

export function needsEnvironmentPrepare(profile: EnvironmentProfile | null): boolean {
	if (!profile?.installCommand?.trim()) return false;
	if (profile.lastPrepareStatus !== 'succeeded') return true;
	return profile.currentFingerprint !== profile.lastPreparedFingerprint;
}

export function computeEnvironmentSetupState(
	profile: EnvironmentProfile | null
): EnvironmentSetupState {
	if (!profile) {
		return {
			runtime: { status: 'todo', label: 'Detect environment' },
			envVars: { status: 'ready', label: 'No variables required yet' },
			services: { status: 'ready', label: 'No services configured' },
			prepare: { status: 'todo', label: 'Detect runtime before preparing' },
			canOpenProject: false,
			primaryAction: 'detect'
		};
	}

	const warnings = normalizeWarnings(profile.warnings);
	const runtimeStatus: SetupStepStatus =
		profile.status === 'invalid' ? 'failed' : warnings.length > 0 ? 'warning' : 'ready';

	let prepareStatus: SetupStepStatus;
	let prepareLabel: string;
	if (!profile.installCommand?.trim()) {
		prepareStatus = 'optional';
		prepareLabel = 'No install command required';
	} else if (profile.lastPrepareStatus === 'running') {
		prepareStatus = 'running';
		prepareLabel = 'Preparing environment';
	} else if (profile.lastPrepareStatus === 'failed') {
		prepareStatus = 'failed';
		prepareLabel = profile.lastPrepareError || 'Prepare failed';
	} else if (isPreparedEnvironment(profile)) {
		prepareStatus = 'ready';
		prepareLabel = 'Environment prepared';
	} else if (profile.lastPrepareStatus === 'succeeded') {
		prepareStatus = 'stale';
		prepareLabel = 'Environment changed since last prepare';
	} else {
		prepareStatus = 'todo';
		prepareLabel = 'Prepare before running agents';
	}

	const canOpenProject = prepareStatus === 'ready' || prepareStatus === 'optional';
	return {
		runtime: {
			status: runtimeStatus,
			label: profile.runtime
				? `${profile.runtime} / ${profile.packageManager ?? 'unknown'}`
				: 'Runtime configured'
		},
		envVars: { status: 'ready', label: 'Environment variables can be edited later' },
		services: { status: 'ready', label: 'No services configured' },
		prepare: { status: prepareStatus, label: prepareLabel },
		canOpenProject,
		primaryAction: canOpenProject ? 'open_project' : 'prepare'
	};
}

export function eventCursor(event: PrepareEvent, index: number): number {
	return typeof event.seq === 'number' ? event.seq : index + 1;
}

export function isTerminalPrepareEvent(event: PrepareEvent): boolean {
	if (event.type === 'result') return true;
	if (event.type !== 'error') return false;
	const payload = event.payload;
	return (
		!!payload &&
		typeof payload === 'object' &&
		typeof (payload as Record<string, unknown>).message === 'string'
	);
}

export function eventLabel(event: PrepareEvent): string {
	const payload = event.payload;
	if (typeof payload === 'string') return payload;
	if (payload && typeof payload === 'object') {
		const record = payload as Record<string, unknown>;
		for (const key of ['text', 'message', 'error', 'reason', 'status']) {
			const value = record[key];
			if (typeof value === 'string' && value.length > 0) return value;
		}
	}
	return warningLabel(payload);
}

export function mergePrepareEvents(initial: PrepareEvent[], live: PrepareEvent[]): PrepareEvent[] {
	const bySeq = new Map<number, PrepareEvent>();
	for (const event of initial) {
		if (typeof event.seq === 'number') bySeq.set(event.seq, event);
	}
	for (const event of live) {
		if (typeof event.seq === 'number') bySeq.set(event.seq, event);
	}
	return [...bySeq.values()].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
}
```

- [ ] **Step 4: Refactor EnvironmentPanel to use helpers**

In `src/lib/components/projects/EnvironmentPanel.svelte`, replace local `EnvironmentProfile`, `PrepareEvent`, `warningLabel`, `normalizeWarnings`, `computeNeedsPrepare`, `eventCursor`, `isTerminalPrepareEvent`, and `eventLabel` definitions/imports with:

```ts
import {
	eventCursor,
	eventLabel,
	isPreparedEnvironment,
	isTerminalPrepareEvent,
	needsEnvironmentPrepare,
	normalizeWarnings,
	type EnvironmentProfile,
	type PrepareEvent
} from './environment-setup-state';
```

Then update derived values:

```ts
const warnings = $derived.by(() => normalizeWarnings(environment?.warnings));
const needsPrepare = $derived.by(() => needsEnvironmentPrepare(environment));
const isPrepared = $derived(isPreparedEnvironment(environment));
```

- [ ] **Step 5: Verify task**

Run:

```bash
bun run test:unit -- tests/unit/lib/components/projects/environment-setup-state.test.ts tests/unit/lib/components/projects/environment-panel.svelte.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit task**

```bash
git add src/lib/components/projects/environment-setup-state.ts src/lib/components/projects/EnvironmentPanel.svelte tests/unit/lib/components/projects/environment-setup-state.test.ts tests/unit/lib/components/projects/environment-panel.svelte.test.ts
git commit -m "feat(onboarding): share environment setup state"
```

---

### Task 2: Reusable Live Environment State

**Files:**

- Create: `src/lib/components/projects/project-environment-live.svelte.ts`
- Modify: `src/routes/(app)/projects/[id]/+page.svelte`

- [ ] **Step 1: Create the reusable live state module**

Create `src/lib/components/projects/project-environment-live.svelte.ts`:

```ts
import { SvelteMap } from 'svelte/reactivity';
import {
	mergePrepareEvents,
	type EnvironmentProfile,
	type PrepareEvent
} from './environment-setup-state';

type LivePrepareEvent = {
	projectId: string;
	profileId: string;
	seq: number;
	event: PrepareEvent;
};

type LiveEnvironmentInput = {
	projectId: () => string;
	profileId: () => string;
	environment: () => EnvironmentProfile | null | undefined;
	prepareEvents: () => PrepareEvent[];
};

function livePrepareEventKey(projectId: string, profileId: string, seq: number) {
	return `${projectId}:${profileId}:${seq}`;
}

function parseEventData(event: MessageEvent<string>): unknown {
	try {
		return JSON.parse(event.data);
	} catch {
		return null;
	}
}

export function createProjectEnvironmentLiveState(input: LiveEnvironmentInput) {
	const liveEnvironmentProfiles = new SvelteMap<string, EnvironmentProfile>();
	const livePrepareEvents = new SvelteMap<string, LivePrepareEvent>();

	const environment = $derived.by(() => {
		const current = input.environment();
		const profileId = current?.id;
		if (!profileId) return current ?? null;
		const liveProfile = liveEnvironmentProfiles.get(profileId);
		return liveProfile ? { ...current, ...liveProfile } : current;
	});

	const prepareEvents = $derived.by(() => {
		const projectId = input.projectId();
		const profileId = input.profileId();
		const live = [...livePrepareEvents.values()]
			.filter((event) => event.projectId === projectId && event.profileId === profileId)
			.map((event) => event.event);
		return mergePrepareEvents(input.prepareEvents(), live);
	});

	class EnvironmentEventSource {
		private readonly es: EventSource;
		private readonly projectId: string;
		private readonly profileId: string;

		constructor(projectId: string, profileId: string) {
			this.projectId = projectId;
			this.profileId = profileId;
			this.es = new EventSource(
				`/api/projects/${encodeURIComponent(projectId)}/environment/${encodeURIComponent(
					profileId
				)}/events`
			);
			this.es.addEventListener('profile', this.handleProfile);
			this.es.addEventListener('prepare_event', this.handlePrepareEvent);
			this.es.onerror = this.handleError;
		}

		private handleProfile = (event: MessageEvent<string>) => {
			const payload = parseEventData(event);
			if (!payload || typeof payload !== 'object') return;
			liveEnvironmentProfiles.set(this.profileId, {
				...(liveEnvironmentProfiles.get(this.profileId) ?? {}),
				...(payload as EnvironmentProfile)
			});
		};

		private handlePrepareEvent = (event: MessageEvent<string>) => {
			const payload = parseEventData(event);
			if (!payload || typeof payload !== 'object') return;
			const seq = Number((payload as PrepareEvent).seq ?? event.lastEventId);
			if (!Number.isFinite(seq)) return;
			const key = livePrepareEventKey(this.projectId, this.profileId, seq);
			if (livePrepareEvents.has(key)) return;
			livePrepareEvents.set(key, {
				projectId: this.projectId,
				profileId: this.profileId,
				seq,
				event: payload as PrepareEvent
			});
		};

		private handleError = () => {
			/* EventSource reconnects automatically; replay is idempotent by seq. */
		};

		readonly dispose = () => {
			this.es.close();
		};
	}

	$effect(() => {
		const projectId = input.projectId();
		const profileId = input.profileId();
		if (!projectId || !profileId) return;
		const source = new EnvironmentEventSource(projectId, profileId);
		return source.dispose;
	});

	return {
		get environment() {
			return environment;
		},
		get prepareEvents() {
			return prepareEvents;
		}
	};
}
```

- [ ] **Step 2: Refactor the project page to use the live state**

In `src/routes/(app)/projects/[id]/+page.svelte`, remove:

- `import { SvelteMap } from 'svelte/reactivity';`
- local `EnvironmentProfile`, `PrepareEvent`, `LivePrepareEvent` types;
- local `liveEnvironmentProfiles`, `livePrepareEvents`;
- local `displayEnvironment`, `displayPrepareEvents`;
- local `EnvironmentEventSource` class and helpers.

Add:

```ts
import { computeEnvironmentSetupState } from '$lib/components/projects/environment-setup-state';
import { createProjectEnvironmentLiveState } from '$lib/components/projects/project-environment-live.svelte';
```

After `environmentPrepareEvents`, add:

```ts
const liveEnvironment = createProjectEnvironmentLiveState({
	projectId: () => page.params.id!,
	profileId: () => environmentProfileId,
	environment: () => environment.current,
	prepareEvents: () => environmentPrepareEvents?.current ?? []
});
const setupState = $derived.by(() => computeEnvironmentSetupState(liveEnvironment.environment));
```

Update `EnvironmentPanel` props:

```svelte
environment={liveEnvironment.environment}
prepareEvents={liveEnvironment.prepareEvents}
```

Add a warning link above `EnvironmentPanel` when setup is incomplete:

```svelte
{#if setupState.primaryAction !== 'open_project'}
	<div class="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
		<span>Project setup is not complete.</span>
		<a href={`/projects/${page.params.id}/setup`} class="ml-2 font-medium underline">
			Open setup
		</a>
	</div>
{/if}
```

- [ ] **Step 3: Run Svelte autofixer for modified files**

Run `mcp__svelte.svelte_autofixer` on:

- `ProjectPage.svelte` content from `src/routes/(app)/projects/[id]/+page.svelte`;
- `project-environment-live.svelte.ts` content from `src/lib/components/projects/project-environment-live.svelte.ts`.

Expected: no issues or suggestions. Apply any suggested fix and rerun the autofixer until clean.

- [ ] **Step 4: Verify task**

Run:

```bash
bun run check
bun run test:unit -- tests/unit/lib/components/projects/environment-panel.svelte.test.ts --run
```

Expected: `svelte-check found 0 errors and 0 warnings`; component tests PASS.

- [ ] **Step 5: Commit task**

```bash
git add src/lib/components/projects/project-environment-live.svelte.ts 'src/routes/(app)/projects/[id]/+page.svelte'
git commit -m "refactor(onboarding): reuse live environment state"
```

---

### Task 3: Redirect After GitHub Import

**Files:**

- Modify: `src/routes/(app)/projects/+page.svelte`
- Test: `tests/unit/routes/projects-page.svelte.test.ts`

- [ ] **Step 1: Write failing redirect component test**

Create `tests/unit/routes/projects-page.svelte.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';

const mocks = vi.hoisted(() => ({
	goto: vi.fn(),
	importProject: vi.fn()
}));

vi.mock('$app/navigation', () => ({
	goto: mocks.goto
}));

vi.mock('$lib/rfc/projects.remote', () => ({
	listProjects: vi.fn(() => ({ current: [], error: undefined })),
	listGithubRepos: vi.fn(() => ({
		current: {
			connected: true,
			repos: [
				{
					githubRepoId: 1,
					owner: 'acme',
					name: 'repo',
					fullName: 'acme/repo',
					defaultBranch: 'main',
					private: false
				}
			]
		},
		error: undefined
	})),
	importProject: mocks.importProject
}));

import ProjectsPage from '../../../src/routes/(app)/projects/+page.svelte';

describe('projects page import onboarding redirect', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.importProject.mockResolvedValue({ id: 'p1', owner: 'acme', name: 'repo' });
	});

	it('redirects to setup after importing a repository', async () => {
		const screen = render(ProjectsPage);

		await screen.getByRole('button', { name: /import repository/i }).click();
		await screen.getByRole('button', { name: /^import$/i }).click();

		expect(mocks.importProject).toHaveBeenCalledWith({ owner: 'acme', name: 'repo' });
		expect(mocks.goto).toHaveBeenCalledWith('/projects/p1/setup');
	});
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/routes/projects-page.svelte.test.ts --run
```

Expected: FAIL because `$app/navigation.goto` is not imported/called.

- [ ] **Step 3: Implement redirect**

In `src/routes/(app)/projects/+page.svelte`, add:

```ts
import { goto } from '$app/navigation';
```

Change `handleImport` success path:

```ts
const project = await importProject({ owner, name });
showImport = false;
await goto(`/projects/${project.id}/setup`);
```

- [ ] **Step 4: Verify task**

Run:

```bash
bun run test:unit -- tests/unit/routes/projects-page.svelte.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Run Svelte autofixer**

Run `mcp__svelte.svelte_autofixer` on `src/routes/(app)/projects/+page.svelte`.

Expected: no issues or suggestions.

- [ ] **Step 6: Commit task**

```bash
git add 'src/routes/(app)/projects/+page.svelte' tests/unit/routes/projects-page.svelte.test.ts
git commit -m "feat(onboarding): redirect imports to setup"
```

---

### Task 4: Project Setup Checklist Component

**Files:**

- Create: `src/lib/components/projects/ProjectSetupChecklist.svelte`
- Test: `tests/unit/lib/components/projects/project-setup-checklist.svelte.test.ts`

- [ ] **Step 1: Write failing checklist tests**

Create `tests/unit/lib/components/projects/project-setup-checklist.svelte.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ProjectSetupChecklist from '$lib/components/projects/ProjectSetupChecklist.svelte';
import type { EnvironmentProfile } from '$lib/components/projects/environment-setup-state';

const project = {
	id: 'p1',
	owner: 'acme',
	name: 'repo',
	defaultBranch: 'main',
	private: false
};

function env(overrides: Partial<EnvironmentProfile> = {}): EnvironmentProfile {
	return {
		id: 'env1',
		status: 'detected',
		runtime: 'node',
		packageManager: 'bun',
		installCommand: 'bun install',
		currentFingerprint: 'fp1',
		lastPreparedFingerprint: null,
		lastPrepareStatus: 'never',
		lastPrepareError: null,
		warnings: [],
		...overrides
	};
}

describe('ProjectSetupChecklist', () => {
	it('shows detect action when no environment exists', async () => {
		const onDetect = vi.fn().mockResolvedValue({});
		const screen = render(ProjectSetupChecklist, {
			projectId: 'p1',
			project,
			environment: null,
			prepareEvents: [],
			onDetect,
			onSave: vi.fn(),
			onPrepare: vi.fn()
		});

		await expect.element(screen.getByText('Setup acme/repo')).toBeInTheDocument();
		await screen.getByRole('button', { name: /detect environment/i }).click();
		expect(onDetect).toHaveBeenCalledWith({ projectId: 'p1' });
	});

	it('shows prepare action when install command is required', async () => {
		const onPrepare = vi.fn().mockResolvedValue({});
		const screen = render(ProjectSetupChecklist, {
			projectId: 'p1',
			project,
			environment: env(),
			prepareEvents: [],
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare
		});

		await expect.element(screen.getByText('Prepare before running agents')).toBeInTheDocument();
		await screen.getByRole('button', { name: /prepare environment/i }).click();
		expect(onPrepare).toHaveBeenCalledWith({ projectId: 'p1', profileId: 'env1', force: false });
	});

	it('allows opening the project when prepare is optional', async () => {
		const screen = render(ProjectSetupChecklist, {
			projectId: 'p1',
			project,
			environment: env({ installCommand: '', lastPrepareStatus: 'never' }),
			prepareEvents: [],
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare: vi.fn()
		});

		await expect
			.element(screen.getByRole('link', { name: /open project/i }))
			.toHaveAttribute('href', '/projects/p1');
		await expect.element(screen.getByText('No install command required')).toBeInTheDocument();
	});

	it('shows live prepare log lines', async () => {
		const screen = render(ProjectSetupChecklist, {
			projectId: 'p1',
			project,
			environment: env({ lastPrepareStatus: 'running' }),
			prepareEvents: [{ id: 'event1', seq: 1, type: 'output', payload: { text: 'bun install' } }],
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare: vi.fn()
		});

		await expect.element(screen.getByText('bun install')).toBeInTheDocument();
	});
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/lib/components/projects/project-setup-checklist.svelte.test.ts --run
```

Expected: FAIL with module not found for `ProjectSetupChecklist.svelte`.

- [ ] **Step 3: Implement the checklist component**

Create `src/lib/components/projects/ProjectSetupChecklist.svelte`:

```svelte
<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import type { ProjectEnvironmentProfileInput } from '$lib/schemas/project-environments';
	import { CheckCircle2, Circle, Database, LoaderCircle, Play, Settings2 } from '@lucide/svelte';
	import EnvironmentPanel from './EnvironmentPanel.svelte';
	import {
		computeEnvironmentSetupState,
		eventLabel,
		type EnvironmentProfile,
		type PrepareEvent,
		type SetupStepStatus
	} from './environment-setup-state';

	type ProjectSummary = {
		id: string;
		owner: string;
		name: string;
		defaultBranch: string;
		private: boolean;
	};

	type Props = {
		projectId: string;
		project: ProjectSummary;
		environment: EnvironmentProfile | null;
		prepareEvents?: PrepareEvent[];
		onDetect: (input: { projectId: string }) => Promise<unknown>;
		onSave: (input: ProjectEnvironmentProfileInput) => Promise<unknown>;
		onPrepare: (input: {
			projectId: string;
			profileId: string;
			force?: boolean;
		}) => Promise<unknown>;
	};

	let {
		projectId,
		project,
		environment,
		prepareEvents = [],
		onDetect,
		onSave,
		onPrepare
	}: Props = $props();

	let primaryBusy = $state(false);
	let primaryError = $state<string | null>(null);

	const setupState = $derived.by(() => computeEnvironmentSetupState(environment));
	const latestLogs = $derived.by(() =>
		prepareEvents
			.map((event) => ({ ...event, label: eventLabel(event) }))
			.filter((event) => event.label.length > 0)
			.slice(-5)
	);

	function statusVariant(
		status: SetupStepStatus
	): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (status === 'failed') return 'destructive';
		if (status === 'ready') return 'secondary';
		return 'outline';
	}

	function statusIcon(status: SetupStepStatus) {
		if (status === 'ready' || status === 'optional') return CheckCircle2;
		if (status === 'running') return LoaderCircle;
		return Circle;
	}

	async function runPrimaryAction() {
		if (primaryBusy) return;
		primaryError = null;
		primaryBusy = true;
		try {
			if (setupState.primaryAction === 'detect') {
				await onDetect({ projectId });
			} else if (setupState.primaryAction === 'prepare' && environment?.id) {
				await onPrepare({ projectId, profileId: environment.id, force: false });
			}
		} catch (e) {
			primaryError = e instanceof Error ? e.message : 'Setup action failed';
		} finally {
			primaryBusy = false;
		}
	}
</script>

<div class="space-y-6">
	<header class="space-y-2 border-b pb-5">
		<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
			<div class="min-w-0">
				<p class="text-sm text-muted-foreground">Project setup</p>
				<h1 class="truncate text-2xl font-semibold tracking-tight">
					Setup {project.owner}/{project.name}
				</h1>
				<p class="mt-1 text-sm text-muted-foreground">
					Prepare this repository once so future agents start with the right runtime and
					dependencies.
				</p>
			</div>
			<Badge variant="outline" class="w-fit">{project.defaultBranch}</Badge>
		</div>
	</header>

	{#if primaryError}
		<p
			class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
		>
			{primaryError}
		</p>
	{/if}

	<section class="grid gap-3 md:grid-cols-4" aria-label="Setup checklist">
		{#each [{ title: 'Runtime', state: setupState.runtime }, { title: 'Environment', state: setupState.envVars }, { title: 'Services', state: setupState.services }, { title: 'Prepare', state: setupState.prepare }] as step (step.title)}
			{@const Icon = statusIcon(step.state.status)}
			<Card.Root size="sm">
				<Card.Content class="space-y-2 pt-4">
					<div class="flex items-center justify-between gap-2">
						<p class="text-sm font-medium">{step.title}</p>
						<Icon class={step.state.status === 'running' ? 'size-4 animate-spin' : 'size-4'} />
					</div>
					<Badge variant={statusVariant(step.state.status)}>{step.state.status}</Badge>
					<p class="text-xs text-muted-foreground">{step.state.label}</p>
				</Card.Content>
			</Card.Root>
		{/each}
	</section>

	<EnvironmentPanel {projectId} {environment} {prepareEvents} {onDetect} {onSave} {onPrepare} />

	<Card.Root size="sm">
		<Card.Header>
			<Card.Title>Services</Card.Title>
			<Card.Description>
				No services are configured yet. Databases and other persistent services will appear here
				later.
			</Card.Description>
			<Card.Action>
				<Database class="size-4 text-muted-foreground" />
			</Card.Action>
		</Card.Header>
	</Card.Root>

	{#if latestLogs.length > 0}
		<Card.Root size="sm">
			<Card.Header>
				<Card.Title>Latest prepare logs</Card.Title>
			</Card.Header>
			<Card.Content>
				<ul class="space-y-1 text-xs text-muted-foreground">
					{#each latestLogs as event, index (`${event.id ?? event.seq ?? index}-${event.label}`)}
						<li class="grid grid-cols-[auto_1fr] gap-2">
							<span class="uppercase">{event.type ?? 'event'}</span>
							<span class="break-words">{event.label}</span>
						</li>
					{/each}
				</ul>
			</Card.Content>
		</Card.Root>
	{/if}

	<footer
		class="sticky bottom-0 flex flex-col gap-2 border-t bg-background/95 py-4 backdrop-blur sm:flex-row sm:items-center sm:justify-between"
	>
		<p class="text-sm text-muted-foreground">{setupState.prepare.label}</p>
		{#if setupState.primaryAction === 'open_project'}
			<Button href={`/projects/${projectId}`} class="w-full sm:w-fit">
				<Play class="size-4" />
				Open project
			</Button>
		{:else}
			<Button
				onclick={() => void runPrimaryAction()}
				disabled={primaryBusy}
				class="w-full sm:w-fit"
			>
				{#if primaryBusy}
					<LoaderCircle class="size-4 animate-spin" />
				{:else if setupState.primaryAction === 'detect'}
					<Settings2 class="size-4" />
				{:else}
					<Play class="size-4" />
				{/if}
				{setupState.primaryAction === 'detect' ? 'Detect environment' : 'Prepare environment'}
			</Button>
		{/if}
	</footer>
</div>
```

- [ ] **Step 4: Run Svelte autofixer**

Run `mcp__svelte.svelte_autofixer` on `ProjectSetupChecklist.svelte`.

Expected: no issues or suggestions. Apply fixes and rerun until clean.

- [ ] **Step 5: Verify task**

Run:

```bash
bun run test:unit -- tests/unit/lib/components/projects/project-setup-checklist.svelte.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit task**

```bash
git add src/lib/components/projects/ProjectSetupChecklist.svelte tests/unit/lib/components/projects/project-setup-checklist.svelte.test.ts
git commit -m "feat(onboarding): add project setup checklist"
```

---

### Task 5: Setup Route Wiring

**Files:**

- Create: `src/routes/(app)/projects/[id]/setup/+page.svelte`
- Test: `tests/unit/routes/project-setup-page.svelte.test.ts`

- [ ] **Step 1: Write failing route smoke test**

Create `tests/unit/routes/project-setup-page.svelte.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

vi.mock('$app/state', () => ({
	page: { params: { id: 'p1' } }
}));

vi.mock('$lib/rfc/projects.remote', () => ({
	getProject: vi.fn(() => ({
		current: { id: 'p1', owner: 'acme', name: 'repo', defaultBranch: 'main', private: false },
		error: undefined
	}))
}));

vi.mock('$lib/rfc/project-environments.remote', () => ({
	getProjectEnvironment: vi.fn(() => ({
		current: null,
		error: undefined
	})),
	getProjectEnvironmentPrepareEvents: vi.fn(() => ({
		current: [],
		error: undefined
	})),
	detectProjectEnvironment: vi.fn(async () => ({ id: 'env1' })),
	saveProjectEnvironment: vi.fn(async () => ({ id: 'env1' })),
	prepareProjectEnvironment: vi.fn(async () => ({ queued: true }))
}));

import SetupPage from '../../../src/routes/(app)/projects/[id]/setup/+page.svelte';

describe('project setup page', () => {
	it('renders setup for the current project', async () => {
		const screen = render(SetupPage);

		await expect.element(screen.getByText('Setup acme/repo')).toBeInTheDocument();
		await expect
			.element(screen.getByRole('button', { name: /detect environment/i }))
			.toBeInTheDocument();
	});
});
```

- [ ] **Step 2: Run route test to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/routes/project-setup-page.svelte.test.ts --run
```

Expected: FAIL because the setup route does not exist.

- [ ] **Step 3: Implement setup route**

Create `src/routes/(app)/projects/[id]/setup/+page.svelte`:

```svelte
<script lang="ts">
	import { page } from '$app/state';
	import ProjectSetupChecklist from '$lib/components/projects/ProjectSetupChecklist.svelte';
	import { getProject } from '$lib/rfc/projects.remote';
	import {
		detectProjectEnvironment,
		getProjectEnvironment,
		getProjectEnvironmentPrepareEvents,
		prepareProjectEnvironment,
		saveProjectEnvironment
	} from '$lib/rfc/project-environments.remote';
	import { createProjectEnvironmentLiveState } from '$lib/components/projects/project-environment-live.svelte';

	const projectId = $derived(page.params.id!);
	const project = $derived(getProject(projectId));
	const environment = $derived(getProjectEnvironment(projectId));
	const environmentProfileId = $derived(environment.current?.id ?? '');
	const environmentPrepareEvents = $derived(
		environmentProfileId
			? getProjectEnvironmentPrepareEvents({ projectId, profileId: environmentProfileId })
			: null
	);
	const liveEnvironment = createProjectEnvironmentLiveState({
		projectId: () => projectId,
		profileId: () => environmentProfileId,
		environment: () => environment.current,
		prepareEvents: () => environmentPrepareEvents?.current ?? []
	});
</script>

<svelte:head>
	<title>Project setup | dotWeaver</title>
</svelte:head>

<div class="mx-auto max-w-5xl p-6">
	{#if project.error}
		<p class="text-sm text-destructive">{project.error.message}</p>
	{:else if environment.error}
		<p class="text-sm text-destructive">{environment.error.message}</p>
	{:else if project.current && environment.current !== undefined}
		<ProjectSetupChecklist
			{projectId}
			project={project.current}
			environment={liveEnvironment.environment}
			prepareEvents={liveEnvironment.prepareEvents}
			onDetect={() => detectProjectEnvironment({ projectId })}
			onSave={saveProjectEnvironment}
			onPrepare={prepareProjectEnvironment}
		/>
	{:else}
		<p class="text-sm text-muted-foreground">Loading project setup</p>
	{/if}
</div>
```

- [ ] **Step 4: Run Svelte autofixer**

Run `mcp__svelte.svelte_autofixer` on `src/routes/(app)/projects/[id]/setup/+page.svelte`.

Expected: no issues or suggestions. Apply fixes and rerun until clean.

- [ ] **Step 5: Verify task**

Run:

```bash
bun run test:unit -- tests/unit/routes/project-setup-page.svelte.test.ts --run
bun run check
```

Expected: route test PASS and `svelte-check found 0 errors and 0 warnings`.

- [ ] **Step 6: Commit task**

```bash
git add 'src/routes/(app)/projects/[id]/setup/+page.svelte' tests/unit/routes/project-setup-page.svelte.test.ts
git commit -m "feat(onboarding): add project setup route"
```

---

### Task 6: Final Verification And Manual Smoke

**Files:**

- Verify all modified files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun run test:unit -- \
  tests/unit/lib/components/projects/environment-setup-state.test.ts \
  tests/unit/lib/components/projects/environment-panel.svelte.test.ts \
  tests/unit/lib/components/projects/project-setup-checklist.svelte.test.ts \
  tests/unit/routes/projects-page.svelte.test.ts \
  tests/unit/routes/project-setup-page.svelte.test.ts \
  --run
```

Expected: all listed test files PASS.

- [ ] **Step 2: Run full static check**

Run:

```bash
bun run check
```

Expected: `svelte-check found 0 errors and 0 warnings`.

- [ ] **Step 3: Run full unit suite**

Run:

```bash
bun run test:unit -- --run
```

Expected: all unit and browser component tests PASS.

- [ ] **Step 4: Manual UI smoke**

Start the app and runner dependencies the same way the project normally runs locally. Then verify:

1. Open `/projects`.
2. Click `Import repository`.
3. Import a GitHub repository.
4. Confirm the browser lands on `/projects/:id/setup`.
5. Click `Detect environment` if no profile exists.
6. Confirm runtime/package manager/commands appear.
7. Click `Prepare environment`.
8. Confirm prepare logs and status update without refreshing.
9. Confirm `Open project` appears when prepared, or when prepare is optional because `installCommand` is empty.
10. Open the project and confirm any incomplete setup warning links back to `/projects/:id/setup`.

- [ ] **Step 5: Commit any verification-only fixes**

If verification required small fixes, commit them:

```bash
git add \
  src/lib/components/projects/environment-setup-state.ts \
  src/lib/components/projects/project-environment-live.svelte.ts \
  src/lib/components/projects/ProjectSetupChecklist.svelte \
  src/lib/components/projects/EnvironmentPanel.svelte \
  'src/routes/(app)/projects/+page.svelte' \
  'src/routes/(app)/projects/[id]/+page.svelte' \
  'src/routes/(app)/projects/[id]/setup/+page.svelte' \
  tests/unit/lib/components/projects/environment-setup-state.test.ts \
  tests/unit/lib/components/projects/environment-panel.svelte.test.ts \
  tests/unit/lib/components/projects/project-setup-checklist.svelte.test.ts \
  tests/unit/routes/projects-page.svelte.test.ts \
  tests/unit/routes/project-setup-page.svelte.test.ts
git commit -m "fix(onboarding): polish project setup flow"
```

If no fixes were required, do not create an empty commit.
