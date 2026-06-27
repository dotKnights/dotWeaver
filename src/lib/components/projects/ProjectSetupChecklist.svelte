<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import type { ProjectEnvironmentServiceKind } from '$lib/domain/project-environment-service';
	import type { ProjectEnvironmentProfileInput } from '$lib/schemas/project-environments';
	import { CheckCircle2, Circle, LoaderCircle, Play, RefreshCw } from '@lucide/svelte';
	import EnvironmentPanel from './EnvironmentPanel.svelte';
	import ProjectEnvironmentServicesPanel from './ProjectEnvironmentServicesPanel.svelte';
	import {
		computeEnvironmentSetupState,
		type EnvironmentProfile,
		type EnvironmentServiceSummary,
		type PrepareEvent,
		type SetupStepStatus
	} from './environment-setup-state';

	type ProjectSummary = {
		owner: string;
		name: string;
		defaultBranch: string;
	};

	type SetupStep = {
		title: string;
		state: {
			status: SetupStepStatus;
			label: string;
		};
	};

	type KeyedQueuedPrepare = {
		key: string;
		queued: boolean;
	};

	type ServiceEnvMappingInput = {
		key: string;
		template: string;
		enabled: boolean;
		sensitive: 'auto' | boolean;
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

	let primaryBusy = $state(false);
	let primaryError = $state<string | null>(null);
	let primaryPrepareQueue = $state<KeyedQueuedPrepare>({ key: '', queued: false });

	const setupState = $derived.by(() =>
		computeEnvironmentSetupState(environment, services, {
			loading: servicesLoading,
			error: servicesError
		})
	);
	const prepareStateKey = $derived(
		[
			projectId,
			environment?.id ?? '',
			environment?.lastPrepareStatus ?? '',
			environment?.lastPreparedFingerprint ?? '',
			environment?.currentFingerprint ?? ''
		].join(':')
	);
	const primaryPrepareQueued = $derived(
		primaryPrepareQueue.key === prepareStateKey && primaryPrepareQueue.queued
	);
	const primaryPrepareRunning = $derived(setupState.prepare.status === 'running');
	const primaryPrepareUnavailable = $derived(
		setupState.primaryAction === 'prepare' && !environment?.id
	);
	const primaryDisabled = $derived(
		primaryBusy || primaryPrepareRunning || primaryPrepareUnavailable || primaryPrepareQueued
	);
	const primaryLabel = $derived.by(() => {
		if (setupState.primaryAction === 'detect') return 'Detect environment';
		if (primaryPrepareRunning || primaryBusy || primaryPrepareQueued)
			return 'Preparing environment';
		return 'Prepare environment';
	});
	const checklistSteps = $derived<SetupStep[]>([
		{ title: 'Runtime', state: setupState.runtime },
		{ title: 'Environment', state: setupState.envVars },
		{ title: 'Services', state: setupState.services },
		{ title: 'Prepare', state: setupState.prepare }
	]);

	function statusVariant(
		status: SetupStepStatus
	): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (status === 'failed') return 'destructive';
		if (status === 'ready') return 'secondary';
		return 'outline';
	}

	async function runPrimaryAction() {
		if (primaryDisabled) return;
		primaryError = null;
		primaryBusy = true;

		try {
			if (setupState.primaryAction === 'detect') {
				await onDetect({ projectId });
			} else if (setupState.primaryAction === 'prepare' && environment?.id) {
				await onPrepare({ projectId, profileId: environment.id, force: false });
				primaryPrepareQueue = { key: prepareStateKey, queued: true };
			}
		} catch (error) {
			primaryError = error instanceof Error ? error.message : 'Setup action failed';
		} finally {
			primaryBusy = false;
		}
	}
</script>

<section class="space-y-4">
	<header class="border-b border-border pb-4">
		<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
			<div class="min-w-0 space-y-1">
				<p class="text-xs font-medium text-muted-foreground">Project setup</p>
				<h1 class="truncate text-lg font-semibold">Setup {project.owner}/{project.name}</h1>
				<p class="max-w-2xl text-sm text-muted-foreground">
					Confirm the runtime, environment settings, and preparation status before agents run.
				</p>
			</div>
			<Badge variant="outline" class="w-fit shrink-0">{project.defaultBranch}</Badge>
		</div>
	</header>

	<div class="grid gap-3 md:grid-cols-4" aria-label="Setup checklist">
		{#each checklistSteps as step (step.title)}
			<Card.Root size="sm">
				<Card.Content class="space-y-3">
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0 space-y-1">
							<p class="truncate text-sm font-medium">{step.title}</p>
							<p class="text-xs break-words text-muted-foreground">{step.state.label}</p>
						</div>
						<span class="mt-0.5 text-muted-foreground" aria-hidden="true">
							{#if step.state.status === 'ready' || step.state.status === 'optional'}
								<CheckCircle2 class="size-4" />
							{:else if step.state.status === 'running'}
								<LoaderCircle class="size-4 animate-spin" />
							{:else}
								<Circle class="size-4" />
							{/if}
						</span>
					</div>
					<Badge variant={statusVariant(step.state.status)}>{step.state.status}</Badge>
				</Card.Content>
			</Card.Root>
		{/each}
	</div>

	<EnvironmentPanel {projectId} {environment} {prepareEvents} {onDetect} {onSave} {onPrepare} />

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

	<footer
		class="sticky bottom-0 z-10 flex flex-col gap-3 border-t border-border bg-background/95 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between"
	>
		<div class="min-w-0 space-y-1">
			<p class="text-sm font-medium">Next setup action</p>
			{#if primaryError}
				<p class="text-sm break-words text-destructive" role="alert">{primaryError}</p>
			{/if}
		</div>

		{#if setupState.primaryAction === 'open_project'}
			<Button href={`/projects/${projectId}`} class="w-full sm:w-fit">
				<Play />
				Open project
			</Button>
		{:else}
			<Button
				onclick={() => void runPrimaryAction()}
				disabled={primaryDisabled}
				class="w-full sm:w-fit"
			>
				{#if setupState.primaryAction === 'prepare' && (primaryBusy || primaryPrepareRunning || primaryPrepareQueued)}
					<LoaderCircle class="animate-spin" />
				{:else if setupState.primaryAction === 'detect'}
					<RefreshCw />
				{:else}
					<Play />
				{/if}
				{primaryLabel}
			</Button>
		{/if}
	</footer>
</section>
