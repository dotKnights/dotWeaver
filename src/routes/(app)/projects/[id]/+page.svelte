<script lang="ts">
	import { page } from '$app/state';
	import AgentConfigPanel from '$lib/components/projects/AgentConfigPanel.svelte';
	import { getProject, listProjectBranches } from '$lib/rfc/projects.remote';
	import { getProjectAgentConfig } from '$lib/rfc/project-agent-config.remote';
	import { listRuns, startRun } from '$lib/rfc/runs.remote';
	import { RUN_MODELS, type RunModel } from '$lib/schemas/runs';
	import { Button } from '$lib/components/ui/button';
	import * as Select from '$lib/components/ui/select';

	const project = $derived(getProject(page.params.id!));
	const branches = $derived(listProjectBranches(page.params.id!));
	const agentConfig = $derived(getProjectAgentConfig(page.params.id!));
	const runs = $derived(listRuns(page.params.id!));

	let prompt = $state('');
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
	const enabledAgentConfigItems = $derived.by(() => {
		const config = agentConfig.current;
		if (!config) return 0;
		return (
			config.mcpServers.filter((server) => server.enabled).length +
			config.skills.filter((skill) => skill.enabled).length
		);
	});
	const hasEnabledAgentConfig = $derived(enabledAgentConfigItems > 0);

	async function handleStart() {
		if (!prompt.trim()) return;
		startError = null;
		starting = true;
		try {
			await startRun({
				projectId: page.params.id!,
				prompt,
				baseBranch: selectedBaseBranch || undefined,
				model: model || undefined,
				useProjectAgentConfig
			});
			prompt = '';
			baseBranch = '';
			useProjectAgentConfig = true;
		} catch (e) {
			startError = e instanceof Error ? e.message : 'Failed to start run';
		} finally {
			starting = false;
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
				<Select.Root
					type="single"
					value={model || undefined}
					onValueChange={(v) => (model = (v as RunModel) ?? '')}
				>
					<Select.Trigger class="w-full sm:w-52">
						{RUN_MODELS.find((m) => m.value === model)?.label ?? 'Default model'}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="" label="Default model" />
						{#each RUN_MODELS as m (m.value)}
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
				<Button
					onclick={handleStart}
					disabled={starting || !prompt.trim() || !selectedBaseBranch}
					class="w-full sm:w-auto"
				>
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
									<span class="ml-3 shrink-0 text-xs text-muted-foreground">{run.status}</span>
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
