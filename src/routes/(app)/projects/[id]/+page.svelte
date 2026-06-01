<script lang="ts">
	import { page } from '$app/state';
	import { getProject } from '$lib/rfc/projects.remote';
	import { listRuns, startRun } from '$lib/rfc/runs.remote';
	import { RUN_MODELS, type RunModel } from '$lib/schemas/runs';
	import { Button } from '$lib/components/ui/button';

	const project = $derived(getProject(page.params.id!));
	const runs = $derived(listRuns(page.params.id!));

	let prompt = $state('');
	let model = $state<'' | RunModel>('');
	let starting = $state(false);
	let startError = $state<string | null>(null);

	async function handleStart() {
		if (!prompt.trim()) return;
		startError = null;
		starting = true;
		try {
			await startRun({ projectId: page.params.id!, prompt, model: model || undefined });
			prompt = '';
		} catch (e) {
			startError = e instanceof Error ? e.message : 'Failed to start run';
		} finally {
			starting = false;
		}
	}
</script>

<div class="mx-auto max-w-3xl space-y-6 p-6">
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
			<div class="flex items-center gap-2">
				<select
					bind:value={model}
					aria-label="Model"
					class="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
				>
					<option value="">Default model</option>
					{#each RUN_MODELS as m (m.value)}
						<option value={m.value}>{m.label}</option>
					{/each}
				</select>
				<Button onclick={handleStart} disabled={starting || !prompt.trim()}>
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
