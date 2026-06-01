<script lang="ts">
	import type { DisplayEvent } from './run-event-display';
	import Markdown from './Markdown.svelte';
	import {
		Bot,
		Brain,
		Terminal,
		FilePlus2,
		Pencil,
		FileText,
		Search,
		Wrench,
		CornerDownRight,
		TriangleAlert,
		CircleCheck,
		CircleX,
		Clock,
		Braces
	} from '@lucide/svelte';

	let { event }: { event: DisplayEvent } = $props();

	const toolIcons: Record<string, typeof Wrench> = {
		Bash: Terminal,
		Write: FilePlus2,
		Edit: Pencil,
		NotebookEdit: Pencil,
		Read: FileText,
		Glob: Search,
		Grep: Search
	};

	function metaParts(turns: number | null, cost: number | null, ms: number | null): string[] {
		const parts: string[] = [];
		if (turns != null) parts.push(`${turns} ${turns === 1 ? 'turn' : 'turns'}`);
		if (cost != null) parts.push(`$${cost.toFixed(4)}`);
		if (ms != null) parts.push(`${(ms / 1000).toFixed(1)}s`);
		return parts;
	}
</script>

{#if event.kind === 'session_start'}
	<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
		<Bot class="h-3.5 w-3.5 shrink-0" />
		<span>Session · {event.model}</span>
	</div>
{:else if event.kind === 'thinking'}
	<details class="rounded-md border bg-muted/30 px-3 py-2 text-xs">
		<summary
			class="flex cursor-pointer items-center gap-1.5 text-muted-foreground select-none hover:text-foreground"
		>
			<Brain class="h-3.5 w-3.5 shrink-0" />
			Thinking
		</summary>
		<pre
			class="mt-2 font-sans break-words whitespace-pre-wrap text-muted-foreground">{event.text}</pre>
	</details>
{:else if event.kind === 'assistant_text'}
	<div class="rounded-md border bg-card px-3.5 py-3 shadow-sm">
		<Markdown source={event.markdown} />
	</div>
{:else if event.kind === 'tool_use'}
	{@const Icon = toolIcons[event.tool] ?? Wrench}
	<div class="rounded-md border bg-muted/30 px-3 py-2">
		<div class="flex items-center gap-1.5 text-xs font-medium">
			<Icon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			{event.title}
		</div>
		{#if event.detail}
			<pre
				class="mt-1.5 max-h-40 overflow-auto font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">{event.detail}</pre>
		{/if}
	</div>
{:else if event.kind === 'tool_result'}
	<details
		class={['rounded-md border px-3 py-2 text-xs', event.isError && 'border-destructive/40']}
	>
		<summary
			class={[
				'flex cursor-pointer items-center gap-1.5 select-none',
				event.isError ? 'text-destructive' : 'text-muted-foreground hover:text-foreground'
			]}
		>
			{#if event.isError}
				<TriangleAlert class="h-3.5 w-3.5 shrink-0" />
				Tool error
			{:else}
				<CornerDownRight class="h-3.5 w-3.5 shrink-0" />
				Tool result
			{/if}
		</summary>
		<pre
			class="mt-2 max-h-60 overflow-auto font-mono break-words whitespace-pre-wrap">{event.text}</pre>
	</details>
{:else if event.kind === 'result'}
	{@const meta = metaParts(event.numTurns, event.costUsd, event.durationMs)}
	<div
		class={[
			'rounded-md border bg-card px-3.5 py-3 text-sm',
			event.isError && 'border-destructive/50'
		]}
	>
		<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
			<span class={['flex items-center gap-1.5 font-medium', event.isError && 'text-destructive']}>
				{#if event.isError}
					<CircleX class="h-4 w-4 shrink-0" />
				{:else}
					<CircleCheck class="h-4 w-4 shrink-0" />
				{/if}
				{event.subtype || (event.isError ? 'error' : 'done')}
			</span>
			{#each meta as part (part)}
				<span class="text-xs text-muted-foreground">{part}</span>
			{/each}
		</div>
		{#if event.text}<div class="mt-2"><Markdown source={event.text} /></div>{/if}
	</div>
{:else if event.kind === 'subagent'}
	<div class="flex items-center gap-1.5 border-l-2 pl-3 text-xs text-muted-foreground">
		<CornerDownRight class="h-3.5 w-3.5 shrink-0" />
		<span class="truncate">subagent: {event.label}{event.status ? ` (${event.status})` : ''}</span>
	</div>
{:else if event.kind === 'rate_limit'}
	{#if event.status !== 'allowed'}
		<div class="flex items-center gap-1.5 text-xs text-destructive">
			<Clock class="h-3.5 w-3.5 shrink-0" />
			Rate limit: {event.status}
		</div>
	{/if}
{:else if event.kind === 'raw'}
	<details class="rounded-md border px-3 py-2 text-xs">
		<summary
			class="flex cursor-pointer items-center gap-1.5 text-muted-foreground select-none hover:text-foreground"
		>
			<Braces class="h-3.5 w-3.5 shrink-0" />
			Event
		</summary>
		<pre class="mt-2 overflow-auto break-all">{event.json}</pre>
	</details>
{/if}
