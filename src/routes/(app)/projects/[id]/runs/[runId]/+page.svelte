<script lang="ts">
	import { page } from '$app/state';
	import { getRun, getRunDiff, approveRun } from '$lib/rfc/runs.remote';
	import { Button } from '$lib/components/ui/button';

	const run = $derived(getRun(page.params.runId!));
	const isReview = $derived(run.current?.status === 'awaiting_review');
	const diff = $derived(isReview ? getRunDiff(page.params.runId!) : undefined);

	let busy = $state(false);
	let actionError = $state<string | null>(null);
	let prUrl = $state<string | null>(null);

	async function act(action: 'push_pr' | 'push' | 'abandon') {
		actionError = null;
		busy = true;
		try {
			const res = await approveRun({ runId: page.params.runId!, action });
			prUrl = res.pullRequestUrl ?? null;
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Action failed';
		} finally {
			busy = false;
		}
	}

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

		{#if prUrl}
			<p class="text-sm">
				Pull request: <a href={prUrl} target="_blank" rel="noreferrer" class="underline">{prUrl}</a>
			</p>
		{/if}

		{#if isReview}
			<section class="space-y-2">
				<h2 class="text-sm font-medium">Review changes</h2>
				{#if actionError}
					<p class="text-sm text-red-500">{actionError}</p>
				{/if}
				{#if diff?.current}
					<ul class="text-xs">
						{#each diff.current.files as f (f.path)}
							<li class="flex justify-between border-b py-1">
								<span class="font-mono">{f.status} {f.path}</span>
								<span class="text-muted-foreground">+{f.additions ?? '?'} -{f.deletions ?? '?'}</span>
							</li>
						{/each}
					</ul>
					{#if diff.current.files.length > 0}
						<pre class="max-h-96 overflow-auto rounded-md border bg-muted/30 p-2 text-xs">{diff.current.patch}{diff.current.truncated ? '\n… (diff tronqué)' : ''}</pre>
					{:else}
						<p class="text-sm text-muted-foreground">No changes in this run.</p>
					{/if}
					<div class="flex gap-2">
						<Button onclick={() => act('push_pr')} disabled={busy}>Push & PR</Button>
						<Button variant="outline" onclick={() => act('push')} disabled={busy}>Push branch</Button>
						<Button variant="outline" onclick={() => act('abandon')} disabled={busy}>Abandon</Button>
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">Loading diff…</p>
				{/if}
			</section>
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
