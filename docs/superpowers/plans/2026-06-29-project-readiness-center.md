# Project Readiness Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current project setup checklist with a reusable Readiness Center that guides users from project import to environment readiness to a useful first run.

**Architecture:** Keep the existing server APIs, SSE streams, project environment helpers, and run creation flow as the source of truth. Add pure readiness model helpers first, then focused Svelte components for the rail, progress, summary, and guided run suggestions, then wire those components into `/projects/:id/setup` and the project page.

**Tech Stack:** Svelte 5 runes, SvelteKit remote functions, Tailwind v4, shadcn-svelte/Bits UI, Lucide icons, Svelte native motion (`Tween`, `Spring`, `prefersReducedMotion`), Vitest browser component tests, Bun.

---

## Scope Check

This plan implements the approved design in `docs/superpowers/specs/2026-06-29-project-readiness-center-design.md`.

It intentionally does not add deep AI repo analysis, new service kinds, a full run workspace redesign, a new app shell, GSAP, Motion, or persisted onboarding tour state.

## File Structure

Create:

- `src/lib/components/projects/ReadinessProgress.svelte` -- tiny animated readiness progress primitive using Svelte `Tween`.
- `src/lib/components/projects/ReadinessRail.svelte` -- step navigation and global readiness state.
- `src/lib/components/projects/ReadinessSummaryCard.svelte` -- compact readiness summary for the project page.
- `src/lib/components/projects/GuidedRunSuggestions.svelte` -- reusable first-run prompt suggestion cards.
- `src/lib/components/projects/ProjectReadinessCenter.svelte` -- orchestrates the full `/setup` Readiness Center.
- `tests/unit/lib/components/projects/readiness-model.test.ts` -- pure helper coverage.
- `tests/unit/lib/components/projects/readiness-components.svelte.test.ts` -- focused component coverage.

Modify:

- `src/lib/components/projects/environment-setup-state.ts` -- add readiness model helpers, active step selection, summary, and guided suggestion selection.
- `src/routes/(app)/projects/[id]/setup/+page.svelte` -- render `ProjectReadinessCenter` and fetch runs for first-run mode.
- `src/routes/(app)/projects/[id]/+page.svelte` -- replace the current setup warning with `ReadinessSummaryCard` and add guided prompt handoff.
- `tests/unit/lib/components/projects/environment-setup-state.test.ts` -- keep existing tests passing and add small coverage if names shift.
- `tests/unit/lib/components/projects/project-setup-checklist.svelte.test.ts` -- migrate to `ProjectReadinessCenter` behavior or replace with new component tests.
- `tests/unit/routes/project-setup-page.svelte.test.ts` -- expect the Readiness Center.
- `tests/unit/routes/project-page.svelte.test.ts` -- expect summary card and guided run behavior.

Reference docs already consulted through Svelte MCP:

- `svelte/motion` for `Tween`, `Spring`, and `prefersReducedMotion`.
- `svelte/transition`, `svelte/in-and-out`, `svelte/easing`, `svelte/animate` for local transitions.
- `kit/$app-navigation` for navigation and refresh behavior.
- `kit/remote-functions` for command/query refresh semantics.
- `kit/accessibility` for focus and navigation expectations.

---

### Task 1: Readiness Model Helpers

**Files:**

- Modify: `src/lib/components/projects/environment-setup-state.ts`
- Create: `tests/unit/lib/components/projects/readiness-model.test.ts`
- Test: `tests/unit/lib/components/projects/environment-setup-state.test.ts`

- [ ] **Step 1: Write failing tests for readiness model helpers**

Create `tests/unit/lib/components/projects/readiness-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	computeProjectReadinessModel,
	getGuidedRunSuggestions,
	type EnvironmentProfile,
	type EnvironmentServiceSummary
} from '$lib/components/projects/environment-setup-state';

function env(overrides: Partial<EnvironmentProfile> = {}): EnvironmentProfile {
	return {
		id: 'env1',
		status: 'ready',
		runtime: 'node',
		packageManager: 'bun',
		installCommand: 'bun install',
		testCommand: 'bun run test',
		buildCommand: 'bun run build',
		devCommand: 'bun run dev',
		currentFingerprint: 'fp1',
		lastPreparedFingerprint: 'fp1',
		lastPrepareStatus: 'succeeded',
		lastPrepareError: null,
		warnings: [],
		...overrides
	};
}

describe('project readiness model', () => {
	it('starts on runtime when no profile exists', () => {
		const model = computeProjectReadinessModel(null, [], {}, { hasRuns: false });

		expect(model.globalStatus).toBe('needs_setup');
		expect(model.activeStepId).toBe('runtime');
		expect(model.progressPercent).toBe(25);
		expect(model.steps.map((step) => step.id)).toEqual([
			'runtime',
			'environment',
			'services',
			'prepare',
			'first_run'
		]);
	});

	it('moves to services when an enabled service needs provisioning', () => {
		const services: EnvironmentServiceSummary[] = [
			{ id: 'svc1', enabled: true, status: 'configured', kind: 'postgres' }
		];

		const model = computeProjectReadinessModel(env(), services, {}, { hasRuns: false });

		expect(model.globalStatus).toBe('needs_setup');
		expect(model.activeStepId).toBe('services');
		expect(model.summaryAction).toBe('Open readiness center');
	});

	it('moves to prepare when the prepared fingerprint is stale', () => {
		const model = computeProjectReadinessModel(
			env({ currentFingerprint: 'fp2', lastPreparedFingerprint: 'fp1' }),
			[],
			{},
			{ hasRuns: true }
		);

		expect(model.globalStatus).toBe('stale');
		expect(model.activeStepId).toBe('prepare');
		expect(model.summaryAction).toBe('Prepare again');
	});

	it('moves to first run when ready and no run exists yet', () => {
		const model = computeProjectReadinessModel(env(), [], {}, { hasRuns: false });

		expect(model.globalStatus).toBe('ready');
		expect(model.activeStepId).toBe('first_run');
		expect(model.summaryAction).toBe('Start guided run');
		expect(model.progressPercent).toBe(100);
	});

	it('moves to overview when ready and runs already exist', () => {
		const model = computeProjectReadinessModel(env(), [], {}, { hasRuns: true });

		expect(model.globalStatus).toBe('ready');
		expect(model.activeStepId).toBe('overview');
		expect(model.summaryAction).toBe('Start guided run');
	});

	it('recommends fixing readiness when warnings or failures exist', () => {
		const suggestions = getGuidedRunSuggestions(
			env({ lastPrepareStatus: 'failed', lastPrepareError: 'bun install failed' }),
			[],
			{},
			{ hasRuns: false }
		);

		expect(suggestions[0]).toMatchObject({
			id: 'fix_readiness_issue',
			priority: 'recommended'
		});
		expect(suggestions.map((suggestion) => suggestion.id)).toContain('verify_project');
	});

	it('recommends verification for a ready project with test or build commands', () => {
		const suggestions = getGuidedRunSuggestions(env(), [], {}, { hasRuns: false });

		expect(suggestions[0]).toMatchObject({
			id: 'verify_project',
			priority: 'recommended'
		});
		expect(suggestions.map((suggestion) => suggestion.id)).toEqual([
			'verify_project',
			'understand_repo',
			'fix_readiness_issue'
		]);
	});
});
```

- [ ] **Step 2: Run the helper tests and verify they fail**

Run:

```bash
bun run test:unit -- tests/unit/lib/components/projects/readiness-model.test.ts --run
```

Expected: FAIL with missing exports for `computeProjectReadinessModel` and `getGuidedRunSuggestions`.

- [ ] **Step 3: Add readiness model types and helper functions**

Append these exports near the existing setup state helpers in `src/lib/components/projects/environment-setup-state.ts`:

```ts
export type ReadinessStepId = 'runtime' | 'environment' | 'services' | 'prepare' | 'first_run';
export type ReadinessActiveStepId = ReadinessStepId | 'overview';
export type ReadinessGlobalStatus =
	| 'ready'
	| 'needs_setup'
	| 'running'
	| 'failed'
	| 'warning'
	| 'stale';

export type ReadinessStep = {
	id: ReadinessStepId;
	title: string;
	status: SetupStepStatus;
	label: string;
};

export type ReadinessModelOptions = {
	hasRuns?: boolean;
};

export type GuidedRunSuggestionId =
	| 'verify_project'
	| 'understand_repo'
	| 'fix_readiness_issue';

export type GuidedRunSuggestion = {
	id: GuidedRunSuggestionId;
	title: string;
	description: string;
	prompt: string;
	priority: 'recommended' | 'available';
	reason: string;
};

export type ProjectReadinessModel = {
	globalStatus: ReadinessGlobalStatus;
	globalLabel: string;
	activeStepId: ReadinessActiveStepId;
	steps: ReadinessStep[];
	progressPercent: number;
	canOpenProject: boolean;
	summaryAction: string;
	setupState: EnvironmentSetupState;
	suggestions: GuidedRunSuggestion[];
};

function statusBlocksProgress(status: SetupStepStatus): boolean {
	return status === 'todo' || status === 'failed' || status === 'running' || status === 'stale';
}

function globalStatusFor(setupState: EnvironmentSetupState): ReadinessGlobalStatus {
	const statuses = [
		setupState.runtime.status,
		setupState.envVars.status,
		setupState.services.status,
		setupState.prepare.status
	];
	if (statuses.includes('failed')) return 'failed';
	if (statuses.includes('running')) return 'running';
	if (statuses.includes('stale')) return 'stale';
	if (!setupState.canOpenProject) return 'needs_setup';
	if (statuses.includes('warning')) return 'warning';
	return 'ready';
}

function globalLabelFor(status: ReadinessGlobalStatus): string {
	if (status === 'ready') return 'Ready for agent runs';
	if (status === 'running') return 'Readiness is updating';
	if (status === 'failed') return 'Readiness needs attention';
	if (status === 'warning') return 'Ready with warnings';
	if (status === 'stale') return 'Preparation is stale';
	return 'Setup required';
}

function summaryActionFor(status: ReadinessGlobalStatus, canOpenProject: boolean): string {
	if (status === 'stale') return 'Prepare again';
	if (status === 'failed') return 'Fix setup';
	if (canOpenProject) return 'Start guided run';
	return 'Open readiness center';
}

function readinessSteps(setupState: EnvironmentSetupState): ReadinessStep[] {
	return [
		{ id: 'runtime', title: 'Runtime', ...setupState.runtime },
		{ id: 'environment', title: 'Environment', ...setupState.envVars },
		{ id: 'services', title: 'Services', ...setupState.services },
		{ id: 'prepare', title: 'Prepare', ...setupState.prepare },
		{
			id: 'first_run',
			title: 'First run',
			status: setupState.canOpenProject ? 'ready' : 'todo',
			label: setupState.canOpenProject ? 'Choose a guided run' : 'Finish readiness first'
		}
	];
}

function activeStepFor(
	profile: EnvironmentProfile | null,
	setupState: EnvironmentSetupState,
	steps: ReadinessStep[],
	options: ReadinessModelOptions
): ReadinessActiveStepId {
	if (!profile) return 'runtime';
	if (setupState.runtime.status === 'failed') return 'runtime';
	if (statusBlocksProgress(setupState.services.status)) return 'services';
	if (statusBlocksProgress(setupState.prepare.status)) return 'prepare';
	if (setupState.canOpenProject && !options.hasRuns) return 'first_run';
	const firstWarning = steps.find((step) => step.status === 'warning');
	return firstWarning?.id ?? 'overview';
}

function progressFor(steps: ReadinessStep[]): number {
	const completed = steps.filter(
		(step) => step.status === 'ready' || step.status === 'optional' || step.id === 'first_run'
	).length;
	return Math.round((completed / steps.length) * 100);
}

export function getGuidedRunSuggestions(
	profile: EnvironmentProfile | null,
	services: EnvironmentServiceSummary[] = [],
	servicesLoadState: EnvironmentServicesLoadState = {},
	options: ReadinessModelOptions = {}
): GuidedRunSuggestion[] {
	const setupState = computeEnvironmentSetupState(profile, services, servicesLoadState);
	const hasReadinessIssue =
		!setupState.canOpenProject ||
		setupState.runtime.status === 'warning' ||
		setupState.services.status === 'warning' ||
		setupState.prepare.status === 'warning' ||
		setupState.prepare.status === 'failed' ||
		setupState.prepare.status === 'stale';
	const hasConfiguredVerification = Boolean(
		profile?.testCommand?.trim() || profile?.buildCommand?.trim()
	);

	const suggestions: GuidedRunSuggestion[] = [
		{
			id: 'verify_project',
			title: 'Verify project',
			description: 'Run the configured install, test, and build commands where applicable.',
			prompt:
				'Verify this project setup. Run the configured install, test, and build commands where applicable. Summarize any failures and propose the smallest safe fix.',
			priority: setupState.canOpenProject && hasConfiguredVerification ? 'recommended' : 'available',
			reason: hasConfiguredVerification
				? 'This project has verification commands configured.'
				: 'Use this once verification commands are configured.'
		},
		{
			id: 'understand_repo',
			title: 'Understand repo',
			description: 'Map the repository structure, commands, key modules, and safest next tasks.',
			prompt:
				'Explore this repository and summarize its structure, main commands, key modules, and the safest next tasks for an agent.',
			priority:
				setupState.canOpenProject && !hasConfiguredVerification && !options.hasRuns
					? 'recommended'
					: 'available',
			reason: 'This is a good first run when you want a project map before changing code.'
		},
		{
			id: 'fix_readiness_issue',
			title: 'Fix readiness issue',
			description: 'Turn the current readiness warning or failure into a focused repair run.',
			prompt:
				'Investigate the readiness issue shown for this project. Explain the root cause, then implement the smallest safe fix and verify it.',
			priority: hasReadinessIssue ? 'recommended' : 'available',
			reason: hasReadinessIssue
				? 'Readiness has a warning, stale preparation, or failing step.'
				: 'Keep this available for later when readiness changes.'
		}
	];

	return suggestions.sort((left, right) => {
		if (left.priority === right.priority) return 0;
		return left.priority === 'recommended' ? -1 : 1;
	});
}

export function computeProjectReadinessModel(
	profile: EnvironmentProfile | null,
	services: EnvironmentServiceSummary[] = [],
	servicesLoadState: EnvironmentServicesLoadState = {},
	options: ReadinessModelOptions = {}
): ProjectReadinessModel {
	const setupState = computeEnvironmentSetupState(profile, services, servicesLoadState);
	const steps = readinessSteps(setupState);
	const globalStatus = globalStatusFor(setupState);
	return {
		globalStatus,
		globalLabel: globalLabelFor(globalStatus),
		activeStepId: activeStepFor(profile, setupState, steps, options),
		steps,
		progressPercent: progressFor(steps),
		canOpenProject: setupState.canOpenProject,
		summaryAction: summaryActionFor(globalStatus, setupState.canOpenProject),
		setupState,
		suggestions: getGuidedRunSuggestions(profile, services, servicesLoadState, options)
	};
}
```

- [ ] **Step 4: Run helper tests and existing setup tests**

Run:

```bash
bun run test:unit -- tests/unit/lib/components/projects/readiness-model.test.ts tests/unit/lib/components/projects/environment-setup-state.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit the helper model**

```bash
git add src/lib/components/projects/environment-setup-state.ts tests/unit/lib/components/projects/readiness-model.test.ts tests/unit/lib/components/projects/environment-setup-state.test.ts
git commit -m "feat(readiness): add project readiness model"
```

---

### Task 2: Readiness Presentation Components

**Files:**

- Create: `src/lib/components/projects/ReadinessProgress.svelte`
- Create: `src/lib/components/projects/ReadinessRail.svelte`
- Create: `src/lib/components/projects/ReadinessSummaryCard.svelte`
- Create: `src/lib/components/projects/GuidedRunSuggestions.svelte`
- Create: `tests/unit/lib/components/projects/readiness-components.svelte.test.ts`

- [ ] **Step 1: Write failing component tests**

Create `tests/unit/lib/components/projects/readiness-components.svelte.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ReadinessRail from '$lib/components/projects/ReadinessRail.svelte';
import ReadinessSummaryCard from '$lib/components/projects/ReadinessSummaryCard.svelte';
import GuidedRunSuggestions from '$lib/components/projects/GuidedRunSuggestions.svelte';
import type {
	GuidedRunSuggestion,
	ProjectReadinessModel
} from '$lib/components/projects/environment-setup-state';

const suggestions: GuidedRunSuggestion[] = [
	{
		id: 'verify_project',
		title: 'Verify project',
		description: 'Run install, test, and build.',
		prompt: 'Verify this project setup.',
		priority: 'recommended',
		reason: 'This project has verification commands configured.'
	},
	{
		id: 'understand_repo',
		title: 'Understand repo',
		description: 'Map the repository.',
		prompt: 'Explore this repository.',
		priority: 'available',
		reason: 'Useful for a first map.'
	}
];

const model: ProjectReadinessModel = {
	globalStatus: 'ready',
	globalLabel: 'Ready for agent runs',
	activeStepId: 'first_run',
	progressPercent: 100,
	canOpenProject: true,
	summaryAction: 'Start guided run',
	setupState: {
		runtime: { status: 'ready', label: 'node / bun' },
		envVars: { status: 'ready', label: 'Environment variables can be edited later' },
		services: { status: 'ready', label: 'No services configured' },
		prepare: { status: 'ready', label: 'Environment prepared' },
		canOpenProject: true,
		primaryAction: 'open_project'
	},
	steps: [
		{ id: 'runtime', title: 'Runtime', status: 'ready', label: 'node / bun' },
		{ id: 'environment', title: 'Environment', status: 'ready', label: 'Variables ready' },
		{ id: 'services', title: 'Services', status: 'ready', label: 'No services configured' },
		{ id: 'prepare', title: 'Prepare', status: 'ready', label: 'Environment prepared' },
		{ id: 'first_run', title: 'First run', status: 'ready', label: 'Choose a guided run' }
	],
	suggestions
};

describe('readiness presentation components', () => {
	it('renders the readiness rail and reports selected steps', async () => {
		const onSelect = vi.fn();
		const screen = render(ReadinessRail, {
			projectLabel: 'acme/repo',
			defaultBranch: 'main',
			model,
			selectedStepId: 'first_run',
			onSelect
		});

		await expect.element(screen.getByText('acme/repo')).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: /runtime/i })).toBeInTheDocument();
		await screen.getByRole('button', { name: /runtime/i }).click();
		expect(onSelect).toHaveBeenCalledWith('runtime');
	});

	it('renders compact project readiness summary', async () => {
		const screen = render(ReadinessSummaryCard, {
			projectId: 'p1',
			model
		});

		await expect.element(screen.getByText('Ready for agent runs')).toBeInTheDocument();
		await expect
			.element(screen.getByRole('link', { name: /open readiness center/i }))
			.toHaveAttribute('href', '/projects/p1/setup');
		await expect.element(screen.getByText('Start guided run')).toBeInTheDocument();
	});

	it('selects guided run suggestions', async () => {
		const onSelect = vi.fn();
		const screen = render(GuidedRunSuggestions, {
			suggestions,
			selectedId: null,
			onSelect
		});

		await expect.element(screen.getByText('Verify project')).toBeInTheDocument();
		await screen.getByRole('button', { name: /verify project/i }).click();
		expect(onSelect).toHaveBeenCalledWith(suggestions[0]);
	});
});
```

- [ ] **Step 2: Run component tests and verify failure**

Run:

```bash
bun run test:unit -- tests/unit/lib/components/projects/readiness-components.svelte.test.ts --run
```

Expected: FAIL with missing component modules.

- [ ] **Step 3: Create `ReadinessProgress.svelte`**

Create `src/lib/components/projects/ReadinessProgress.svelte`:

```svelte
<script lang="ts">
	import { Tween, prefersReducedMotion } from 'svelte/motion';
	import { cubicOut } from 'svelte/easing';

	type Props = {
		value: number;
		label?: string;
	};

	let { value, label = 'Readiness progress' }: Props = $props();

	const boundedValue = $derived(Math.max(0, Math.min(100, value)));
	const progress = Tween.of(() => boundedValue, {
		duration: prefersReducedMotion.current ? 0 : 180,
		easing: cubicOut
	});
</script>

<div class="space-y-1" aria-label={label}>
	<div class="flex items-center justify-between gap-3 text-xs text-muted-foreground">
		<span>{label}</span>
		<span class="font-mono">{Math.round(progress.current)}%</span>
	</div>
	<div class="h-1.5 overflow-hidden rounded-full bg-muted">
		<div
			class="h-full rounded-full bg-primary"
			style={`width: ${progress.current}%`}
			aria-hidden="true"
		></div>
	</div>
</div>
```

- [ ] **Step 4: Create `ReadinessRail.svelte`**

Create `src/lib/components/projects/ReadinessRail.svelte`:

```svelte
<script lang="ts">
	import { CheckCircle2, Circle, LoaderCircle, TriangleAlert } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';
	import ReadinessProgress from './ReadinessProgress.svelte';
	import type {
		ProjectReadinessModel,
		ReadinessActiveStepId,
		ReadinessStep,
		ReadinessStepId,
		SetupStepStatus
	} from './environment-setup-state';

	type Props = {
		projectLabel: string;
		defaultBranch: string;
		model: ProjectReadinessModel;
		selectedStepId: ReadinessActiveStepId;
		onSelect: (stepId: ReadinessStepId) => void;
	};

	let { projectLabel, defaultBranch, model, selectedStepId, onSelect }: Props = $props();

	function statusIcon(status: SetupStepStatus) {
		if (status === 'ready' || status === 'optional') return CheckCircle2;
		if (status === 'failed' || status === 'warning' || status === 'stale') return TriangleAlert;
		if (status === 'running') return LoaderCircle;
		return Circle;
	}

	function stepClasses(step: ReadinessStep): string {
		const active = selectedStepId === step.id;
		return cn(
			'flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors focus-visible:ring-1 focus-visible:ring-sidebar-ring focus-visible:outline-none',
			active
				? 'border-sidebar-primary/40 bg-sidebar-accent text-sidebar-foreground'
				: 'border-sidebar-border bg-transparent text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground'
		);
	}
</script>

<aside class="space-y-5 rounded-xl border border-sidebar-border bg-sidebar p-4 text-sidebar-foreground">
	<div class="min-w-0 space-y-1">
		<p class="truncate text-sm font-semibold">{projectLabel}</p>
		<p class="truncate text-xs text-sidebar-foreground/60">Default branch: {defaultBranch}</p>
	</div>

	<div class="rounded-lg border border-sidebar-border bg-sidebar-accent/45 p-3">
		<p class="text-xs font-medium text-sidebar-foreground/70">Status</p>
		<p class="mt-1 text-sm font-semibold">{model.globalLabel}</p>
		<div class="mt-3">
			<ReadinessProgress value={model.progressPercent} label="Readiness" />
		</div>
	</div>

	<nav aria-label="Readiness steps" class="space-y-2">
		{#each model.steps as step (step.id)}
			{@const Icon = statusIcon(step.status)}
			<button
				type="button"
				class={stepClasses(step)}
				aria-current={selectedStepId === step.id ? 'step' : undefined}
				onclick={() => onSelect(step.id)}
			>
				<Icon class={cn('mt-0.5 size-4 shrink-0', step.status === 'running' && 'animate-spin')} />
				<span class="min-w-0">
					<span class="block truncate text-sm font-medium">{step.title}</span>
					<span class="mt-0.5 block text-xs text-sidebar-foreground/58">{step.label}</span>
				</span>
			</button>
		{/each}
	</nav>

	<Button
		href="../"
		variant="outline"
		size="sm"
		class="w-full border-sidebar-border bg-sidebar-accent/55 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
	>
		Back to project
	</Button>
</aside>
```

- [ ] **Step 5: Create `ReadinessSummaryCard.svelte`**

Create `src/lib/components/projects/ReadinessSummaryCard.svelte`:

```svelte
<script lang="ts">
	import { ArrowRight, CheckCircle2, LoaderCircle, TriangleAlert } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import ReadinessProgress from './ReadinessProgress.svelte';
	import type { ProjectReadinessModel } from './environment-setup-state';

	type Props = {
		projectId: string;
		model: ProjectReadinessModel;
	};

	let { projectId, model }: Props = $props();

	const Icon = $derived.by(() => {
		if (model.globalStatus === 'ready') return CheckCircle2;
		if (model.globalStatus === 'running') return LoaderCircle;
		return TriangleAlert;
	});
	const badgeVariant = $derived(
		model.globalStatus === 'failed' ? 'destructive' : model.globalStatus === 'ready' ? 'secondary' : 'outline'
	);
</script>

<Card.Root class="rounded-lg shadow-sm">
	<Card.Header class="border-b">
		<div class="min-w-0 space-y-1">
			<Card.Title>Project readiness</Card.Title>
			<Card.Description>{model.globalLabel}</Card.Description>
		</div>
		<Card.Action>
			<Badge variant={badgeVariant} class="capitalize">{model.globalStatus.replaceAll('_', ' ')}</Badge>
		</Card.Action>
	</Card.Header>
	<Card.Content class="space-y-4">
		<div class="flex min-w-0 gap-3">
			<span class="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
				<Icon class={model.globalStatus === 'running' ? 'size-4 animate-spin' : 'size-4'} strokeWidth={1.8} />
			</span>
			<div class="min-w-0 flex-1 space-y-3">
				<ReadinessProgress value={model.progressPercent} label="Readiness" />
				<div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
					{#each model.steps.slice(0, 4) as step (step.id)}
						<div class="min-w-0 rounded-md border bg-background/60 p-2">
							<p class="truncate text-xs font-medium">{step.title}</p>
							<p class="truncate text-xs text-muted-foreground">{step.label}</p>
						</div>
					{/each}
				</div>
			</div>
		</div>

		<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
			<p class="text-sm text-muted-foreground">{model.summaryAction}</p>
			<Button href={`/projects/${projectId}/setup`} variant="outline" class="w-full sm:w-fit">
				Open readiness center
				<ArrowRight />
			</Button>
		</div>
	</Card.Content>
</Card.Root>
```

- [ ] **Step 6: Create `GuidedRunSuggestions.svelte`**

Create `src/lib/components/projects/GuidedRunSuggestions.svelte`:

```svelte
<script lang="ts">
	import { Bot, CheckCircle2 } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';
	import type { GuidedRunSuggestion, GuidedRunSuggestionId } from './environment-setup-state';

	type Props = {
		suggestions: GuidedRunSuggestion[];
		selectedId?: GuidedRunSuggestionId | null;
		onSelect: (suggestion: GuidedRunSuggestion) => void;
	};

	let { suggestions, selectedId = null, onSelect }: Props = $props();
</script>

<section class="space-y-3" aria-labelledby="guided-run-suggestions-heading">
	<div class="space-y-1">
		<h2 id="guided-run-suggestions-heading" class="text-sm font-semibold">Start with a guided run</h2>
		<p class="text-sm text-muted-foreground">
			Choose a focused first prompt. You can edit it before launching.
		</p>
	</div>

	<div class="grid gap-3 lg:grid-cols-3">
		{#each suggestions as suggestion (suggestion.id)}
			{@const selected = selectedId === suggestion.id}
			<button
				type="button"
				class={cn(
					'group min-w-0 rounded-lg border bg-card p-4 text-left transition-all focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
					selected ? 'border-primary bg-accent/50 shadow-sm' : 'hover:border-primary/40 hover:bg-muted/30'
				)}
				onclick={() => onSelect(suggestion)}
				aria-pressed={selected}
			>
				<div class="flex items-start justify-between gap-3">
					<span class="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground">
						{#if selected}
							<CheckCircle2 class="size-4" strokeWidth={1.8} />
						{:else}
							<Bot class="size-4" strokeWidth={1.8} />
						{/if}
					</span>
					{#if suggestion.priority === 'recommended'}
						<Badge variant="secondary">Recommended</Badge>
					{/if}
				</div>
				<h3 class="mt-3 text-sm font-semibold">{suggestion.title}</h3>
				<p class="mt-1 text-sm text-muted-foreground">{suggestion.description}</p>
				<p class="mt-3 text-xs text-muted-foreground">{suggestion.reason}</p>
			</button>
		{/each}
	</div>

	{#if suggestions.length === 0}
		<div class="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
			Finish readiness before choosing a guided run.
		</div>
	{/if}
</section>
```

- [ ] **Step 7: Run the Svelte autofixer on new components**

For each new `.svelte` file, call Svelte MCP `svelte-autofixer` with the component source:

- `ReadinessProgress.svelte`
- `ReadinessRail.svelte`
- `ReadinessSummaryCard.svelte`
- `GuidedRunSuggestions.svelte`

Expected: no actionable issues. If the autofixer reports Svelte 5 syntax issues, apply its fixes and run it again on the changed component.

- [ ] **Step 8: Run component tests**

Run:

```bash
bun run test:unit -- tests/unit/lib/components/projects/readiness-components.svelte.test.ts --run
```

Expected: PASS.

- [ ] **Step 9: Commit presentation components**

```bash
git add src/lib/components/projects/ReadinessProgress.svelte src/lib/components/projects/ReadinessRail.svelte src/lib/components/projects/ReadinessSummaryCard.svelte src/lib/components/projects/GuidedRunSuggestions.svelte tests/unit/lib/components/projects/readiness-components.svelte.test.ts
git commit -m "feat(readiness): add readiness presentation components"
```

---

### Task 3: Full Readiness Center Route

**Files:**

- Create: `src/lib/components/projects/ProjectReadinessCenter.svelte`
- Modify: `src/routes/(app)/projects/[id]/setup/+page.svelte`
- Modify: `tests/unit/routes/project-setup-page.svelte.test.ts`
- Replace or retire: `tests/unit/lib/components/projects/project-setup-checklist.svelte.test.ts`

- [ ] **Step 1: Update route test expectations**

Modify `tests/unit/routes/project-setup-page.svelte.test.ts` so the first test expects the new center:

```ts
it('renders the Readiness Center for a project without an environment', async () => {
	const screen = render(SetupPage);

	await expect.element(screen.getByText('Readiness Center')).toBeInTheDocument();
	await expect.element(screen.getByText('acme/repo')).toBeInTheDocument();
	await expect
		.element(screen.getByRole('button', { name: /runtime/i }))
		.toBeInTheDocument();
	await expect
		.element(screen.getByRole('button', { name: /detect environment/i }))
		.toBeInTheDocument();
});
```

Keep the service mapping test, but update only text selectors that still reference `ProjectSetupChecklist`.

- [ ] **Step 2: Write focused component tests for center behavior**

Replace `tests/unit/lib/components/projects/project-setup-checklist.svelte.test.ts` with tests for `ProjectReadinessCenter`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ProjectReadinessCenter from '$lib/components/projects/ProjectReadinessCenter.svelte';
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
		status: 'ready',
		runtime: 'node',
		packageManager: 'bun',
		installCommand: 'bun install',
		testCommand: 'bun run test',
		buildCommand: 'bun run build',
		devCommand: 'bun run dev',
		currentFingerprint: 'fp1',
		lastPreparedFingerprint: 'fp1',
		lastPrepareStatus: 'succeeded',
		lastPrepareError: null,
		warnings: [],
		...overrides
	};
}

describe('ProjectReadinessCenter', () => {
	it('runs detection from the runtime step', async () => {
		const onDetect = vi.fn().mockResolvedValue({});
		const screen = render(ProjectReadinessCenter, {
			projectId: 'p1',
			project,
			environment: null,
			prepareEvents: [],
			hasRuns: false,
			onDetect,
			onSave: vi.fn(),
			onPrepare: vi.fn()
		});

		await expect.element(screen.getByText('Readiness Center')).toBeInTheDocument();
		await screen.getByRole('button', { name: /detect environment/i }).click();
		expect(onDetect).toHaveBeenCalledWith({ projectId: 'p1' });
	});

	it('shows prepare as the active action for stale environments', async () => {
		const onPrepare = vi.fn().mockResolvedValue({});
		const screen = render(ProjectReadinessCenter, {
			projectId: 'p1',
			project,
			environment: env({ currentFingerprint: 'fp2', lastPreparedFingerprint: 'fp1' }),
			prepareEvents: [],
			hasRuns: true,
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare
		});

		await expect.element(screen.getByText('Preparation is stale')).toBeInTheDocument();
		await screen.getByRole('button', { name: /prepare environment/i }).click();
		expect(onPrepare).toHaveBeenCalledWith({ projectId: 'p1', profileId: 'env1', force: false });
	});

	it('selects a guided prompt when ready', async () => {
		const screen = render(ProjectReadinessCenter, {
			projectId: 'p1',
			project,
			environment: env(),
			prepareEvents: [],
			hasRuns: false,
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare: vi.fn()
		});

		await screen.getByRole('button', { name: /verify project/i }).click();
		await expect.element(screen.getByLabelText('Run prompt')).toHaveValue(/Verify this project setup/);
	});
});
```

- [ ] **Step 3: Run new route and component tests to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/routes/project-setup-page.svelte.test.ts tests/unit/lib/components/projects/project-setup-checklist.svelte.test.ts --run
```

Expected: FAIL because `ProjectReadinessCenter.svelte` does not exist and setup route still renders the old checklist.

- [ ] **Step 4: Create `ProjectReadinessCenter.svelte`**

Create `src/lib/components/projects/ProjectReadinessCenter.svelte`. Start from this implementation and keep `EnvironmentPanel` / `ProjectEnvironmentServicesPanel` embedded to avoid rewriting existing forms:

```svelte
<script lang="ts">
	import type { Project, ProjectEnvVar } from '@prisma/client';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import type { ProjectEnvironmentServiceKind } from '$lib/domain/project-environment-service';
	import type { ProjectEnvironmentProfileInput } from '$lib/schemas/project-environments';
	import { LoaderCircle, Play, RefreshCw } from '@lucide/svelte';
	import EnvironmentPanel from './EnvironmentPanel.svelte';
	import ProjectEnvironmentServicesPanel from './ProjectEnvironmentServicesPanel.svelte';
	import GuidedRunSuggestions from './GuidedRunSuggestions.svelte';
	import ReadinessRail from './ReadinessRail.svelte';
	import {
		computeProjectReadinessModel,
		type EnvironmentProfile,
		type EnvironmentServiceSummary,
		type GuidedRunSuggestion,
		type GuidedRunSuggestionId,
		type PrepareEvent,
		type ReadinessActiveStepId,
		type ReadinessStepId
	} from './environment-setup-state';

	type ProjectSummary = Pick<Project, 'owner' | 'name' | 'defaultBranch'>;
	type ServiceEnvMappingInput = Pick<ProjectEnvVar, 'key' | 'enabled'> & {
		template: string;
		sensitive: 'auto' | ProjectEnvVar['sensitive'];
	};

	type Props = {
		projectId: string;
		project: ProjectSummary;
		environment: EnvironmentProfile | null;
		prepareEvents?: PrepareEvent[];
		hasRuns?: boolean;
		onDetect: (input: { projectId: string }) => Promise<unknown>;
		onSave: (input: ProjectEnvironmentProfileInput) => Promise<unknown>;
		onPrepare: (input: { projectId: string; profileId: string; force?: boolean }) => Promise<unknown>;
		services?: EnvironmentServiceSummary[];
		serviceEvents?: (serviceId: string) => PrepareEvent[];
		servicesLoading?: boolean;
		servicesError?: string | null;
		onCreateService?: (input: {
			projectId: string;
			profileId: string;
			kind: ProjectEnvironmentServiceKind;
		}) => Promise<unknown>;
		onProvisionService?: (input: {
			projectId: string;
			profileId: string;
			serviceId: string;
		}) => Promise<unknown>;
		onSetServiceEnabled?: (input: {
			projectId: string;
			profileId: string;
			serviceId: string;
			enabled: boolean;
		}) => Promise<unknown>;
		onUpdateServiceEnvMappings?: (input: {
			projectId: string;
			profileId: string;
			serviceId: string;
			envMappings: ServiceEnvMappingInput[];
		}) => Promise<unknown>;
	};

	let {
		projectId,
		project,
		environment,
		prepareEvents = [],
		hasRuns = false,
		onDetect,
		onSave,
		onPrepare,
		services = [],
		serviceEvents = () => [],
		servicesLoading = false,
		servicesError = null,
		onCreateService = async () => {},
		onProvisionService = async () => {},
		onSetServiceEnabled = async () => {},
		onUpdateServiceEnvMappings = async () => {}
	}: Props = $props();

	let selectedStepId = $state<ReadinessActiveStepId | null>(null);
	let selectedSuggestionId = $state<GuidedRunSuggestionId | null>(null);
	let prompt = $state('');
	let primaryBusy = $state(false);
	let primaryError = $state<string | null>(null);

	const model = $derived.by(() =>
		computeProjectReadinessModel(environment, services, { loading: servicesLoading, error: servicesError }, { hasRuns })
	);
	const activeStepId = $derived(selectedStepId ?? model.activeStepId);
	const projectLabel = $derived(`${project.owner}/${project.name}`);
	const selectedSuggestion = $derived(
		model.suggestions.find((suggestion) => suggestion.id === selectedSuggestionId) ?? null
	);

	function selectStep(stepId: ReadinessStepId) {
		selectedStepId = stepId;
	}

	function selectSuggestion(suggestion: GuidedRunSuggestion) {
		selectedSuggestionId = suggestion.id;
		prompt = suggestion.prompt;
	}

	async function detect() {
		if (primaryBusy) return;
		primaryBusy = true;
		primaryError = null;
		try {
			await onDetect({ projectId });
			selectedStepId = null;
		} catch (error) {
			primaryError = error instanceof Error ? error.message : 'Detection failed';
		} finally {
			primaryBusy = false;
		}
	}

	async function prepare() {
		if (primaryBusy || !environment?.id) return;
		primaryBusy = true;
		primaryError = null;
		try {
			await onPrepare({ projectId, profileId: environment.id, force: false });
			selectedStepId = null;
		} catch (error) {
			primaryError = error instanceof Error ? error.message : 'Prepare failed';
		} finally {
			primaryBusy = false;
		}
	}

	async function openProjectWithPrompt() {
		const encoded = encodeURIComponent(prompt.trim());
		await goto(encoded ? `/projects/${projectId}?prompt=${encoded}` : `/projects/${projectId}`);
	}
</script>

<section class="space-y-5">
	<header class="border-b pb-5">
		<div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
			<div class="min-w-0 space-y-1">
				<p class="text-xs font-medium text-muted-foreground">Project setup</p>
				<h1 class="truncate text-2xl font-semibold tracking-tight">Readiness Center</h1>
				<p class="max-w-2xl text-sm text-muted-foreground">
					Prepare {projectLabel} for repeatable agent runs, then start with a guided first prompt.
				</p>
			</div>
			<Button href={`/projects/${projectId}`} variant="outline" class="w-full sm:w-fit">
				Back to project
			</Button>
		</div>
	</header>

	<div class="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_300px]">
		<ReadinessRail
			projectLabel={projectLabel}
			defaultBranch={project.defaultBranch}
			{model}
			selectedStepId={activeStepId}
			onSelect={selectStep}
		/>

		<main class="min-w-0 space-y-4" aria-live="polite">
			{#if primaryError}
				<p class="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
					{primaryError}
				</p>
			{/if}

			{#if activeStepId === 'runtime' || activeStepId === 'environment'}
				<Card.Root class="rounded-xl shadow-sm">
					<Card.Header class="border-b">
						<Card.Title>{activeStepId === 'runtime' ? 'Confirm runtime' : 'Environment settings'}</Card.Title>
						<Card.Description>
							Review detected commands and adjust them before preparing the project.
						</Card.Description>
					</Card.Header>
					<Card.Content>
						{#if !environment}
							<Button onclick={() => void detect()} disabled={primaryBusy}>
								{#if primaryBusy}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}
								Detect environment
							</Button>
						{:else}
							<EnvironmentPanel {projectId} {environment} {prepareEvents} {onDetect} {onSave} {onPrepare} />
						{/if}
					</Card.Content>
				</Card.Root>
			{:else if activeStepId === 'services'}
				<ProjectEnvironmentServicesPanel
					{projectId}
					profileId={environment?.id ?? ''}
					{services}
					{serviceEvents}
					loading={servicesLoading}
					error={servicesError}
					onCreate={onCreateService}
					onProvision={onProvisionService}
					onSetEnabled={onSetServiceEnabled}
					onUpdateEnvMappings={onUpdateServiceEnvMappings}
				/>
			{:else if activeStepId === 'prepare'}
				<Card.Root class="rounded-xl shadow-sm">
					<Card.Header class="border-b">
						<Card.Title>Prepare environment</Card.Title>
						<Card.Description>{model.setupState.prepare.label}</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-4">
						<EnvironmentPanel {projectId} {environment} {prepareEvents} {onDetect} {onSave} {onPrepare} />
						<Button onclick={() => void prepare()} disabled={primaryBusy || !environment?.id || model.setupState.prepare.status === 'running'}>
							{#if primaryBusy || model.setupState.prepare.status === 'running'}<LoaderCircle class="animate-spin" />{:else}<Play />{/if}
							Prepare environment
						</Button>
					</Card.Content>
				</Card.Root>
			{:else}
				<Card.Root class="rounded-xl shadow-sm">
					<Card.Header class="border-b">
						<Card.Title>{model.globalLabel}</Card.Title>
						<Card.Description>
							Choose a guided run or return to the project workspace.
						</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-4">
						<GuidedRunSuggestions
							suggestions={model.suggestions}
							selectedId={selectedSuggestionId}
							onSelect={selectSuggestion}
						/>
						<div class="space-y-2">
							<label for="readiness-run-prompt" class="text-sm font-medium">Run prompt</label>
							<textarea
								id="readiness-run-prompt"
								aria-label="Run prompt"
								bind:value={prompt}
								rows="5"
								class="w-full rounded-md border border-input bg-background p-3 text-sm"
							></textarea>
							<div class="flex justify-end">
								<Button onclick={() => void openProjectWithPrompt()} disabled={!prompt.trim()}>
									Use this prompt
								</Button>
							</div>
						</div>
					</Card.Content>
				</Card.Root>
			{/if}
		</main>

		<aside class="space-y-3 xl:sticky xl:top-4 xl:self-start">
			<Card.Root class="rounded-xl shadow-sm">
				<Card.Header class="border-b">
					<Card.Title>Detected context</Card.Title>
					<Card.Description>{model.globalLabel}</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-3 text-sm">
					<div>
						<p class="text-xs text-muted-foreground">Runtime</p>
						<p class="font-medium">{environment?.runtime ?? 'Not detected'}</p>
					</div>
					<div>
						<p class="text-xs text-muted-foreground">Package manager</p>
						<p class="font-medium">{environment?.packageManager ?? 'Not detected'}</p>
					</div>
					<div>
						<p class="text-xs text-muted-foreground">Next recommendation</p>
						<p class="font-medium">{selectedSuggestion?.title ?? model.summaryAction}</p>
					</div>
				</Card.Content>
			</Card.Root>
		</aside>
	</div>
</section>
```

- [ ] **Step 5: Modify setup route to render the new center and load runs**

In `src/routes/(app)/projects/[id]/setup/+page.svelte`:

1. Replace the `ProjectSetupChecklist` import with `ProjectReadinessCenter`.
2. Import `listRuns`.
3. Add `const runs = $derived(listRuns(projectId));`.
4. Pass `hasRuns={Boolean(runs.current?.length)}`.

The render block should become:

```svelte
<ProjectReadinessCenter
	{projectId}
	project={project.current}
	environment={liveEnvironment.environment}
	prepareEvents={liveEnvironment.prepareEvents}
	hasRuns={Boolean(runs.current?.length)}
	onDetect={detectProjectEnvironment}
	onSave={saveProjectEnvironment}
	onPrepare={prepareProjectEnvironment}
	services={liveServices.services}
	serviceEvents={liveServices.events}
	servicesLoading={environmentServicesLoading}
	servicesError={environmentServicesError}
	onCreateService={createProjectEnvironmentService}
	onProvisionService={provisionProjectEnvironmentService}
	onSetServiceEnabled={setProjectEnvironmentServiceEnabled}
	onUpdateServiceEnvMappings={updateProjectEnvironmentServiceEnvMappings}
/>
```

- [ ] **Step 6: Run Svelte autofixer**

Run Svelte MCP `svelte-autofixer` on:

- `ProjectReadinessCenter.svelte`
- `+page.svelte` source from `src/routes/(app)/projects/[id]/setup/+page.svelte`

Expected: no actionable issues. Apply any reported Svelte 5 fixes and run the autofixer again.

- [ ] **Step 7: Run route and component tests**

Run:

```bash
bun run test:unit -- tests/unit/routes/project-setup-page.svelte.test.ts tests/unit/lib/components/projects/project-setup-checklist.svelte.test.ts --run
```

Expected: PASS.

- [ ] **Step 8: Commit the full center**

```bash
git add src/lib/components/projects/ProjectReadinessCenter.svelte src/routes/(app)/projects/[id]/setup/+page.svelte tests/unit/routes/project-setup-page.svelte.test.ts tests/unit/lib/components/projects/project-setup-checklist.svelte.test.ts
git commit -m "feat(readiness): add project readiness center"
```

---

### Task 4: Project Page Summary and Guided Prompt Handoff

**Files:**

- Modify: `src/routes/(app)/projects/[id]/+page.svelte`
- Modify: `tests/unit/routes/project-page.svelte.test.ts`

- [ ] **Step 1: Extend project page tests**

Add these tests to `tests/unit/routes/project-page.svelte.test.ts`:

```ts
it('shows a reusable readiness summary before the run form', async () => {
	const screen = render(ProjectPage);

	await expect.element(screen.getByText('Project readiness')).toBeInTheDocument();
	await expect
		.element(screen.getByRole('link', { name: /open readiness center/i }))
		.toHaveAttribute('href', '/projects/p1/setup');
});

it('prefills the run prompt from the query string', async () => {
	vi.doMock('$app/state', () => ({
		page: {
			params: { id: 'p1' },
			url: new URL('http://localhost/projects/p1?prompt=Verify%20this%20project')
		}
	}));

	const { default: ProjectPageWithPrompt } = await import('../../../src/routes/(app)/projects/[id]/+page.svelte');
	const screen = render(ProjectPageWithPrompt);

	await expect.element(screen.getByLabelText('Run prompt')).toHaveValue('Verify this project');
});
```

If the dynamic `vi.doMock` causes module caching problems, split the query-string case into a new test file `tests/unit/routes/project-page-guided-prompt.svelte.test.ts` with the `$app/state` mock defined once at the top.

- [ ] **Step 2: Run the project page tests and verify failure**

Run:

```bash
bun run test:unit -- tests/unit/routes/project-page.svelte.test.ts --run
```

Expected: FAIL because the summary card is not rendered and the textarea has no accessible label.

- [ ] **Step 3: Modify project page imports and derived model**

In `src/routes/(app)/projects/[id]/+page.svelte`, add:

```ts
import ReadinessSummaryCard from '$lib/components/projects/ReadinessSummaryCard.svelte';
import {
	computeEnvironmentSetupState,
	computeProjectReadinessModel
} from '$lib/components/projects/environment-setup-state';
import { getProjectEnvironmentServices } from '$lib/rfc/project-environment-services.remote';
```

Replace the existing `computeEnvironmentSetupState` import with the combined import above.

Add service loading and model derivations near `liveEnvironment`:

```ts
const environmentServices = $derived(
	environmentProfileId
		? getProjectEnvironmentServices({
				projectId: page.params.id!,
				profileId: environmentProfileId
			})
		: null
);
const environmentServicesLoading = $derived(
	Boolean(environmentProfileId && environmentServices && environmentServices.current === undefined)
);
const environmentServicesError = $derived(environmentServices?.error?.message ?? null);
const readinessModel = $derived.by(() =>
	computeProjectReadinessModel(
		liveEnvironment.environment,
		environmentServices?.current ?? [],
		{ loading: environmentServicesLoading, error: environmentServicesError },
		{ hasRuns: Boolean(runs.current?.length) }
	)
);
```

- [ ] **Step 4: Prefill prompt from query string and add label**

Initialize prompt from `page.url.searchParams`:

```ts
let prompt = $state(page.url.searchParams.get('prompt') ?? '');
```

Replace the run textarea with a labelled block:

```svelte
<div class="space-y-1">
	<label for="run-prompt" class="text-sm font-medium">Run prompt</label>
	<textarea
		id="run-prompt"
		aria-label="Run prompt"
		bind:value={prompt}
		rows="3"
		placeholder="Describe what the agent should do..."
		class="w-full rounded-md border border-input bg-transparent p-2 text-sm"
	></textarea>
</div>
```

- [ ] **Step 5: Replace the setup warning with `ReadinessSummaryCard`**

Inside the environment loaded block, replace the amber warning block with:

```svelte
<ReadinessSummaryCard projectId={page.params.id!} model={readinessModel} />
```

Keep `EnvironmentPanel` below it for now, unless the UI becomes too noisy. If it is too noisy during browser QA, collapse `EnvironmentPanel` behind a details section in Task 5.

- [ ] **Step 6: Run Svelte autofixer**

Run Svelte MCP `svelte-autofixer` on `src/routes/(app)/projects/[id]/+page.svelte`.

Expected: no actionable issues. Apply fixes and run again if needed.

- [ ] **Step 7: Run project page tests**

Run:

```bash
bun run test:unit -- tests/unit/routes/project-page.svelte.test.ts --run
```

Expected: PASS.

- [ ] **Step 8: Commit project page integration**

```bash
git add src/routes/(app)/projects/[id]/+page.svelte tests/unit/routes/project-page.svelte.test.ts
git commit -m "feat(readiness): surface readiness on project page"
```

---

### Task 5: Motion, Mobile, and Accessibility Polish

**Files:**

- Modify: `src/lib/components/projects/ProjectReadinessCenter.svelte`
- Modify: `src/lib/components/projects/ReadinessRail.svelte`
- Modify: `src/lib/components/projects/GuidedRunSuggestions.svelte`
- Modify: `src/lib/components/projects/ReadinessSummaryCard.svelte`
- Modify: `src/lib/components/projects/ReadinessProgress.svelte`

- [ ] **Step 1: Add mobile-friendly rail behavior**

In `ReadinessRail.svelte`, keep the existing desktop rail and add a compact mobile step list by changing the root classes to:

```svelte
<aside class="space-y-5 rounded-xl border border-sidebar-border bg-sidebar p-4 text-sidebar-foreground lg:sticky lg:top-4">
```

Ensure each step button remains at least 44px high by keeping `py-3`.

- [ ] **Step 2: Add reduced-motion friendly transitions**

In `ProjectReadinessCenter.svelte`, import:

```ts
import { prefersReducedMotion } from 'svelte/motion';
import { fly, fade } from 'svelte/transition';
import { cubicOut } from 'svelte/easing';
```

Wrap the active central content in keyed blocks with local transitions:

```svelte
{#key activeStepId}
	<div
		in:fly={{ y: prefersReducedMotion.current ? 0 : 10, duration: prefersReducedMotion.current ? 0 : 180, easing: cubicOut }}
		out:fade={{ duration: prefersReducedMotion.current ? 0 : 90 }}
	>
		<!-- existing active step content -->
	</div>
{/key}
```

Use the wrapper once around the branch content, not around each nested control. This keeps motion contained and avoids making frequent edits feel sluggish.

- [ ] **Step 3: Preserve focus and avoid SSE focus stealing**

Do not call `.focus()` in SSE effects or after command refreshes. In `ProjectReadinessCenter.svelte`, keep:

```ts
selectedStepId = null;
```

after detect/prepare, but do not move focus. The next render should update visually and be announced via `aria-live="polite"`.

- [ ] **Step 4: Verify accessible names**

Run:

```bash
bun run test:unit -- tests/unit/lib/components/projects/readiness-components.svelte.test.ts tests/unit/lib/components/projects/project-setup-checklist.svelte.test.ts tests/unit/routes/project-page.svelte.test.ts --run
```

Expected: PASS. If a role query fails because a button name is ambiguous, adjust visible text or `aria-label` to make the control unique.

- [ ] **Step 5: Run Svelte autofixer on changed components**

Run Svelte MCP `svelte-autofixer` on each changed `.svelte` file:

- `ProjectReadinessCenter.svelte`
- `ReadinessRail.svelte`
- `GuidedRunSuggestions.svelte`
- `ReadinessSummaryCard.svelte`
- `ReadinessProgress.svelte`

Expected: no actionable issues after fixes.

- [ ] **Step 6: Commit polish**

```bash
git add src/lib/components/projects/ProjectReadinessCenter.svelte src/lib/components/projects/ReadinessRail.svelte src/lib/components/projects/GuidedRunSuggestions.svelte src/lib/components/projects/ReadinessSummaryCard.svelte src/lib/components/projects/ReadinessProgress.svelte
git commit -m "feat(readiness): polish readiness motion and accessibility"
```

---

### Task 6: Full Verification

**Files:**

- No new files expected.
- Modify only files required by test or Svelte checker failures from this task.

- [ ] **Step 1: Run project component tests**

Run:

```bash
bun run test:unit -- tests/unit/lib/components/projects/readiness-model.test.ts tests/unit/lib/components/projects/readiness-components.svelte.test.ts tests/unit/lib/components/projects/project-setup-checklist.svelte.test.ts tests/unit/lib/components/projects/environment-panel.svelte.test.ts tests/unit/lib/components/projects/project-environment-services-panel.svelte.test.ts --run
```

Expected: PASS.

- [ ] **Step 2: Run affected route tests**

Run:

```bash
bun run test:unit -- tests/unit/routes/project-setup-page.svelte.test.ts tests/unit/routes/project-page.svelte.test.ts tests/unit/routes/projects-page.svelte.test.ts --run
```

Expected: PASS.

- [ ] **Step 3: Run full unit suite**

Run:

```bash
bun run test:unit -- --run
```

Expected: PASS.

- [ ] **Step 4: Run Svelte check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 5: Manual browser verification**

Start the dev server:

```bash
bun run dev -- --host 127.0.0.1
```

Open the app and verify:

- `/projects/:id/setup` with no environment shows Runtime and `Detect environment`.
- `/projects/:id/setup` with stale prepare shows Prepare and `Prepare environment`.
- `/projects/:id/setup` ready state shows guided run suggestions.
- selecting `Verify project` fills the prompt textarea.
- `Use this prompt` returns to `/projects/:id?prompt=...`.
- `/projects/:id` shows `Project readiness` above the run form.
- project page run form is disabled when readiness is not openable.
- desktop layout has rail, main panel, and context rail without overlap.
- mobile width stacks without horizontal scrolling.
- browser reduced-motion setting disables or collapses central panel transitions.

- [ ] **Step 6: Commit any verification fixes**

If Step 1-5 required fixes, commit them:

```bash
git add src tests
git commit -m "fix(readiness): resolve readiness verification issues"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review

Spec coverage:

- Complete project -> setup -> first run path: Tasks 3 and 4.
- Semi-piloted recommendations: Tasks 1 and 3.
- Guided first run suggestions: Tasks 1, 2, 3, and 4.
- Reusable Readiness Center: Tasks 1, 3, and 4.
- Hybrid placement: Task 4.
- Native Svelte motion and reduced motion: Tasks 2 and 5.
- Existing server source of truth: all tasks keep existing remote functions and SSE state.
- Accessibility and tests: Tasks 2, 5, and 6.

Placeholder scan:

- No task contains undefined "later" work.
- Each code-changing step includes concrete code or exact replacement snippets.
- Each test step includes exact command and expected result.

Type consistency:

- `ReadinessStepId`, `ReadinessActiveStepId`, `ProjectReadinessModel`, and `GuidedRunSuggestion` are defined in Task 1 before use in later tasks.
- Component prop names match their use in tests and integration snippets.
