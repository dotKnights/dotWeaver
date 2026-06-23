<script lang="ts">
	import { Activity } from '@lucide/svelte';
	import RunEvent from './RunEvent.svelte';
	import type { DisplayTimelineEvent } from './run-event-display';

	let { events }: { events: DisplayTimelineEvent[] } = $props();

	const eventCount = $derived(`${events.length} ${events.length === 1 ? 'event' : 'events'}`);
</script>

<section class="rounded-xl border bg-card shadow-sm">
	<div class="flex items-center justify-between gap-3 border-b px-4 py-3">
		<div class="flex items-center gap-2">
			<Activity class="h-4 w-4 text-muted-foreground" />
			<h2 class="text-sm font-semibold">Timeline</h2>
		</div>
		<span class="rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">
			{eventCount}
		</span>
	</div>

	{#if events.length === 0}
		<div class="px-4 py-8 text-sm text-muted-foreground">No events yet.</div>
	{:else}
		<ol class="space-y-2 px-4 py-4">
			{#each events as item (item.key)}
				<li><RunEvent event={item.event} /></li>
			{/each}
		</ol>
	{/if}
</section>
