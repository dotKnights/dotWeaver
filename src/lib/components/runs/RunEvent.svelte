<script lang="ts">
	import type { DisplayEvent } from './run-event-display';
	import Markdown from './Markdown.svelte';

	let { event }: { event: DisplayEvent } = $props();

	function fmtCost(c: number | null): string {
		return c == null ? '' : ` · $${c.toFixed(4)}`;
	}
	function fmtDur(ms: number | null): string {
		return ms == null ? '' : ` · ${(ms / 1000).toFixed(1)}s`;
	}
</script>

{#if event.kind === 'session_start'}
	<p class="text-xs text-muted-foreground">Session · {event.model}</p>
{:else if event.kind === 'thinking'}
	<details class="rounded border bg-muted/20 p-2 text-xs">
		<summary class="cursor-pointer text-muted-foreground">🧠 Thinking</summary>
		<pre class="mt-1 whitespace-pre-wrap break-words">{event.text}</pre>
	</details>
{:else if event.kind === 'assistant_text'}
	<div class="rounded-md border p-3"><Markdown source={event.markdown} /></div>
{:else if event.kind === 'tool_use'}
	<div class="rounded-md border p-2 text-xs">
		<span class="font-medium">🔧 {event.title}</span>
		<pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-muted-foreground">{event.detail}</pre>
	</div>
{:else if event.kind === 'tool_result'}
	<details class="rounded border p-2 text-xs" class:border-red-400={event.isError}>
		<summary class="cursor-pointer {event.isError ? 'text-red-500' : 'text-muted-foreground'}">
			{event.isError ? '⚠️ Tool error' : '↳ Tool result'}
		</summary>
		<pre class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono">{event.text}</pre>
	</details>
{:else if event.kind === 'result'}
	<div class="rounded-md border p-3 text-sm" class:border-red-400={event.isError}>
		<p class="font-medium">
			{event.isError ? '✗' : '✓'}
			{event.subtype || (event.isError ? 'error' : 'done')}{event.numTurns != null
				? ` · ${event.numTurns} turns`
				: ''}{fmtCost(event.costUsd)}{fmtDur(event.durationMs)}
		</p>
		{#if event.text}<div class="mt-1"><Markdown source={event.text} /></div>{/if}
	</div>
{:else if event.kind === 'subagent'}
	<p class="border-l-2 pl-3 text-xs text-muted-foreground">
		⤷ subagent: {event.label}{event.status ? ` (${event.status})` : ''}
	</p>
{:else if event.kind === 'rate_limit'}
	{#if event.status !== 'allowed'}
		<p class="text-xs text-amber-600">Rate limit: {event.status}</p>
	{/if}
{:else if event.kind === 'raw'}
	<pre class="overflow-auto rounded border p-2 text-xs break-all">{event.json}</pre>
{/if}
