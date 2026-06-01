<script lang="ts">
	import { page } from '$app/state';
	import { getRun } from '$lib/rfc/runs.remote';

	const run = $derived(getRun(page.params.runId!));

	function summarize(payload: unknown): string {
		const text = JSON.stringify(payload);
		return text.length > 300 ? text.slice(0, 300) + '…' : text;
	}
</script>

<div class="mx-auto max-w-3xl space-y-4 p-6">
	{#if run.error}
		<p class="text-sm text-red-500">{run.error.message}</p>
	{:else if run.current}
		<div class="flex items-center justify-between">
			<h1 class="text-xl font-semibold">Run</h1>
			<a href={`/projects/${page.params.id}`} class="text-sm hover:underline">← Project</a>
		</div>
		<dl class="grid grid-cols-2 gap-2 text-sm">
			<dt class="text-muted-foreground">Status</dt>
			<dd>{run.current.status}</dd>
			<dt class="text-muted-foreground">Branch</dt>
			<dd>{run.current.agentBranch}</dd>
		</dl>
		{#if run.current.error}
			<p class="text-sm text-red-500">{run.current.error}</p>
		{/if}
		<div>
			<h2 class="mb-1 text-sm font-medium">Prompt</h2>
			<pre class="whitespace-pre-wrap rounded-md border p-2 text-xs">{run.current.prompt}</pre>
		</div>
		<div>
			<h2 class="mb-1 text-sm font-medium">Events</h2>
			{#if run.current.events.length === 0}
				<p class="text-sm text-muted-foreground">No events recorded.</p>
			{:else}
				<ul class="space-y-1">
					{#each run.current.events as event (event.id)}
						<li class="rounded border p-2 text-xs">
							<span class="font-mono text-muted-foreground">{event.type}</span>
							<div class="mt-1 break-all">{summarize(event.payload)}</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{:else}
		<p class="text-sm text-muted-foreground">Loading run…</p>
	{/if}
</div>
