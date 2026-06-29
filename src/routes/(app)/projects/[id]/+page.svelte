<script lang="ts">
	import { page } from '$app/state';
	import AgentConfigPanel from '$lib/components/projects/AgentConfigPanel.svelte';
	import EnvironmentPanel from '$lib/components/projects/EnvironmentPanel.svelte';
	import { computeEnvironmentSetupState } from '$lib/components/projects/environment-setup-state';
	import { createProjectEnvironmentLiveState } from '$lib/components/projects/project-environment-live.svelte';
	import { getProject, listProjectBranches } from '$lib/rfc/projects.remote';
	import { getProjectAgentConfig } from '$lib/rfc/project-agent-config.remote';
	import {
		detectProjectEnvironment,
		getProjectEnvironment,
		getProjectEnvironmentPrepareEvents,
		prepareProjectEnvironment,
		saveProjectEnvironment
	} from '$lib/rfc/project-environments.remote';
	import { listRuns, startRun } from '$lib/rfc/runs.remote';
	import {
		CLAUDE_RUN_MODELS,
		CODEX_RUN_MODELS,
		RUN_AGENTS,
		type RunAgent,
		type RunModel
	} from '$lib/schemas/runs';
	import { Button } from '$lib/components/ui/button';
	import * as Select from '$lib/components/ui/select';

	const project = $derived(getProject(page.params.id!));
	const branches = $derived(listProjectBranches(page.params.id!));
	const agentConfig = $derived(getProjectAgentConfig(page.params.id!));
	const environment = $derived(getProjectEnvironment(page.params.id!));
	const environmentProfileId = $derived(environment.current?.id ?? '');
	const environmentPrepareEvents = $derived(
		environmentProfileId
			? getProjectEnvironmentPrepareEvents({
					projectId: page.params.id!,
					profileId: environmentProfileId
				})
			: null
	);
	const liveEnvironment = createProjectEnvironmentLiveState({
		projectId: () => page.params.id!,
		profileId: () => environmentProfileId,
		environment: () => environment.current,
		prepareEvents: () => environmentPrepareEvents?.current ?? []
	});
	const setupState = $derived.by(() => computeEnvironmentSetupState(liveEnvironment.environment));
	const runs = $derived(listRuns(page.params.id!));

	let prompt = $state('');
	let agent = $state<RunAgent>('claude');
	let baseBranch = $state('');
	let model = $state<'' | RunModel>('');
	let useProjectAgentConfig = $state(true);
	let starting = $state(false);
	let startError = $state<string | null>(null);
	const availableBranches = $derived.by(() => {
		const projectDefault = project.current?.defaultBranch;
		const loaded = branches.current ?? [];
		if (!projectDefault) return loaded;
		return [projectDefault, ...loaded.filter((branch) => branch !== projectDefault)];
	});
	const selectedBaseBranch = $derived(baseBranch || project.current?.defaultBranch || '');
	const selectedBaseBranchLabel = $derived(selectedBaseBranch || 'Base branch');
	const availableModels = $derived(agent === 'codex' ? CODEX_RUN_MODELS : CLAUDE_RUN_MODELS);
	const selectedAgentLabel = $derived(
		RUN_AGENTS.find((candidate) => candidate.value === agent)?.label ?? 'Agent'
	);
	const selectedModelLabel = $derived(
		availableModels.find((candidate) => candidate.value === model)?.label ?? 'Default model'
	);
	const enabledAgentConfigItems = $derived.by(() => {
		const config = agentConfig.current;
		if (!config) return 0;
		return (
			config.mcpServers.filter((server) => server.enabled).length +
			config.skills.filter((skill) => skill.enabled).length
		);
	});
	const hasEnabledAgentConfig = $derived(enabledAgentConfigItems > 0);
	const canOpenProject = $derived(setupState.primaryAction === 'open_project');
	const canStartRun = $derived(
		canOpenProject && !starting && !!prompt.trim() && !!selectedBaseBranch
	);

	async function handleStart() {
		if (!prompt.trim() || !selectedBaseBranch || !canOpenProject) return;
		startError = null;
		starting = true;
		try {
			await startRun({
				projectId: page.params.id!,
				prompt,
				agent,
				baseBranch: selectedBaseBranch || undefined,
				model: model || undefined,
				useProjectAgentConfig
			});
			prompt = '';
			baseBranch = '';
			model = '';
			useProjectAgentConfig = true;
		} catch (e) {
			startError = e instanceof Error ? e.message : 'Failed to start run';
		} finally {
			starting = false;
		}
	}

	function handleAgentChange(value: string | undefined) {
		agent = value === 'codex' ? 'codex' : 'claude';
		if (!availableModels.some((candidate) => candidate.value === model)) {
			model = '';
		}
	}
</script>

<div class="mx-auto max-w-5xl space-y-6 p-6">
	{#if project.error}
		<p class="text-sm text-red-500">{project.error.message}</p>
	{:else if project.current}
		<div class="flex items-center justify-between">
			<h1 class="text-2xl font-semibold">{project.current.owner}/{project.current.name}</h1>
			<a href="/projects" class="text-sm hover:underline">← Projects</a>
		</div>
		<dl class="grid grid-cols-2 gap-2 text-sm">
			<dt class="text-muted-foreground">Default branch</dt>
			<dd>{project.current.defaultBranch}</dd>
			<dt class="text-muted-foreground">Visibility</dt>
			<dd>{project.current.private ? 'Private' : 'Public'}</dd>
		</dl>

		{#if environment.error}
			<p class="text-sm text-red-500">{environment.error.message}</p>
		{:else if environment.current !== undefined}
			{#key `${page.params.id}:${environment.current?.id ?? 'none'}`}
				{#if setupState.primaryAction !== 'open_project'}
					<div class="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
						<span>Project setup is not complete.</span>
						<a href={`/projects/${page.params.id}/setup`} class="ml-2 font-medium underline">
							Open setup
						</a>
					</div>
				{/if}
				<EnvironmentPanel
					projectId={page.params.id!}
					environment={liveEnvironment.environment}
					prepareEvents={liveEnvironment.prepareEvents}
					onDetect={() => detectProjectEnvironment({ projectId: page.params.id! })}
					onSave={saveProjectEnvironment}
					onPrepare={prepareProjectEnvironment}
				/>
			{/key}
		{:else}
			<p class="text-sm text-muted-foreground">Loading environment</p>
		{/if}

		{#if agentConfig.error}
			<p class="text-sm text-red-500">{agentConfig.error.message}</p>
		{:else if agentConfig.current}
			<AgentConfigPanel projectId={page.params.id!} config={agentConfig.current} />
		{:else}
			<p class="text-sm text-muted-foreground">Loading agent config…</p>
		{/if}

		<section class="space-y-2">
			<h2 class="text-lg font-medium">Run an agent</h2>
			{#if startError}
				<p class="text-sm text-red-500">{startError}</p>
			{/if}
			<textarea
				bind:value={prompt}
				rows="3"
				placeholder="Describe what the agent should do…"
				class="w-full rounded-md border border-input bg-transparent p-2 text-sm"
			></textarea>
			<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
				<div class="w-full space-y-1 sm:w-52">
					<Select.Root
						type="single"
						value={selectedBaseBranch || undefined}
						onValueChange={(v) => (baseBranch = v ?? '')}
						disabled={!project.current || !!branches.error || availableBranches.length === 0}
					>
						<Select.Trigger class="w-full">
							{selectedBaseBranchLabel}
						</Select.Trigger>
						<Select.Content>
							{#each availableBranches as branch (branch)}
								<Select.Item value={branch} label={branch} />
							{/each}
						</Select.Content>
					</Select.Root>
					{#if branches.error}
						<p class="text-xs text-destructive">Could not load branches. Default branch only.</p>
					{/if}
				</div>
				<Select.Root type="single" value={agent} onValueChange={handleAgentChange}>
					<Select.Trigger class="w-full sm:w-44">
						{selectedAgentLabel}
					</Select.Trigger>
					<Select.Content>
						{#each RUN_AGENTS as candidate (candidate.value)}
							<Select.Item value={candidate.value} label={candidate.label} />
						{/each}
					</Select.Content>
				</Select.Root>
				<Select.Root
					type="single"
					value={model || undefined}
					onValueChange={(v) => (model = (v as RunModel) ?? '')}
				>
					<Select.Trigger class="w-full sm:w-52">
						{selectedModelLabel}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="" label="Default model" />
						{#each availableModels as m (m.value)}
							<Select.Item value={m.value} label={m.label} />
						{/each}
					</Select.Content>
				</Select.Root>
				<label class="flex w-full items-center gap-2 text-sm sm:w-auto">
					<input
						type="checkbox"
						bind:checked={useProjectAgentConfig}
						class="h-4 w-4 accent-primary"
					/>
					<span>
						Use project agent config
						{#if hasEnabledAgentConfig && useProjectAgentConfig}
							<span class="block text-xs text-muted-foreground">
								{enabledAgentConfigItems} enabled
							</span>
						{:else if hasEnabledAgentConfig}
							<span class="block text-xs text-destructive">Disabled for this run</span>
						{/if}
					</span>
				</label>
				<Button onclick={handleStart} disabled={!canStartRun} class="w-full sm:w-auto">
					{starting ? 'Starting…' : 'Run'}
				</Button>
			</div>
		</section>

		<section class="space-y-2">
			<h2 class="text-lg font-medium">Runs</h2>
			{#if runs.current}
				{#if runs.current.length === 0}
					<p class="text-sm text-muted-foreground">No runs yet.</p>
				{:else}
					<ul class="space-y-2">
						{#each runs.current as run (run.id)}
							<li>
								<a
									href={`/projects/${page.params.id}/runs/${run.id}`}
									class="flex items-center justify-between rounded-md border p-3 hover:bg-accent"
								>
									<span class="truncate text-sm">{run.prompt}</span>
									<span class="ml-3 shrink-0 text-xs text-muted-foreground">
										{run.agent === 'codex' ? 'Codex' : 'Claude'} · {run.status}
									</span>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			{:else}
				<p class="text-sm text-muted-foreground">Loading runs…</p>
			{/if}
		</section>
	{:else}
		<p class="text-sm text-muted-foreground">Loading project…</p>
	{/if}
</div>
