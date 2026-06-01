<script lang="ts">
	import { page } from '$app/state';
	import { getRun, getRunDiff, approveRun, cancelRun } from '$lib/rfc/runs.remote';
	import { Button } from '$lib/components/ui/button';
	import RunEvent from '$lib/components/runs/RunEvent.svelte';
	import { normalizeEvent, type DisplayEvent } from '$lib/components/runs/run-event-display';

	const run = $derived(getRun(page.params.runId!));
	const isReview = $derived(run.current?.status === 'awaiting_review');
	const diff = $derived(isReview ? getRunDiff(page.params.runId!) : undefined);

	let busy = $state(false);
	let actionError = $state<string | null>(null);
	let prUrl = $state<string | null>(null);

	const ACTIVE_CANCELABLE = ['queued', 'preparing', 'running'];
	let canceling = $state(false);
	async function cancel() {
		canceling = true;
		try {
			await cancelRun(page.params.runId!);
		} catch {
			/* surfaced via run.error on refresh */
		} finally {
			canceling = false;
		}
	}

	const ACTIVE = ['queued', 'preparing', 'running', 'pushing'];
	let liveEvents = $state<Array<{ seq: number; payload: unknown }>>([]);

	$effect(() => {
		const status = run.current?.status;
		if (!status || !ACTIVE.includes(status)) return;
		const runId = page.params.runId!;
		const es = new EventSource(`/api/runs/${runId}/events`);
		es.onmessage = (e) => {
			const seq = Number(e.lastEventId);
			if (liveEvents.some((x) => x.seq === seq)) return;
			let payload: unknown = e.data;
			try {
				payload = JSON.parse(e.data);
			} catch {
				/* garde le texte brut */
			}
			liveEvents = [...liveEvents, { seq, payload }];
		};
		es.addEventListener('done', () => {
			es.close();
			getRun(runId).refresh();
		});
		es.onerror = () => {
			/* EventSource se reconnecte tout seul ; replay idempotent par seq */
		};
		return () => es.close();
	});

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

	const displayEvents = $derived.by<DisplayEvent[]>(() => {
		const source =
			liveEvents.length > 0
				? liveEvents.map((e) => e.payload)
				: (run.current?.events ?? []).map((e) => e.payload);
		return source.flatMap((p) => normalizeEvent(p)).filter((e) => e.kind !== 'hidden');
	});
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
			<dt class="text-muted-foreground">Model</dt>
			<dd>{run.current.model ?? 'default'}</dd>
			<dt class="text-muted-foreground">Branch</dt>
			<dd>{run.current.agentBranch}</dd>
		</dl>
		{#if run.current.error}
			<p class="text-sm text-red-500">{run.current.error}</p>
		{/if}

		{#if ACTIVE_CANCELABLE.includes(run.current.status)}
			<button
				onclick={cancel}
				disabled={canceling}
				class="rounded-md border px-3 py-1 text-sm hover:bg-accent"
			>
				{canceling ? 'Canceling…' : 'Cancel run'}
			</button>
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
				{#if diff?.error}
					<p class="text-sm text-red-500">Could not load the diff: {diff.error.message}</p>
				{:else if diff?.current}
					<ul class="text-xs">
						{#each diff.current.files as f (f.path)}
							<li class="flex justify-between border-b py-1">
								<span class="font-mono">{f.status} {f.path}</span>
								<span class="text-muted-foreground"
									>+{f.additions ?? '?'} -{f.deletions ?? '?'}</span
								>
							</li>
						{/each}
					</ul>
					{#if diff.current.files.length > 0}
						<pre class="max-h-96 overflow-auto rounded-md border bg-muted/30 p-2 text-xs">{diff
								.current.patch}{diff.current.truncated ? '\n… (diff tronqué)' : ''}</pre>
					{:else}
						<p class="text-sm text-muted-foreground">No changes in this run.</p>
					{/if}
					<div class="flex gap-2">
						{#if diff.current.files.length > 0}
							<Button onclick={() => act('push_pr')} disabled={busy}>Push & PR</Button>
							<Button variant="outline" onclick={() => act('push')} disabled={busy}
								>Push branch</Button
							>
						{/if}
						<Button variant="outline" onclick={() => act('abandon')} disabled={busy}>Abandon</Button
						>
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">Loading diff…</p>
				{/if}
			</section>
		{/if}

		<div>
			<h2 class="mb-1 text-sm font-medium">Prompt</h2>
			<pre class="rounded-md border p-2 text-xs whitespace-pre-wrap">{run.current.prompt}</pre>
		</div>
		<div>
			<h2 class="mb-1 text-sm font-medium">Events</h2>
			{#if displayEvents.length === 0}
				<p class="text-sm text-muted-foreground">No events yet.</p>
			{:else}
				<ul class="space-y-2">
					{#each displayEvents as event, i (i)}
						<li><RunEvent {event} /></li>
					{/each}
				</ul>
			{/if}
		</div>
	{:else}
		<p class="text-sm text-muted-foreground">Loading run…</p>
	{/if}
</div>
