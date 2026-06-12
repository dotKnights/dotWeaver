<script lang="ts">
	import { Circle, CircleCheck, LoaderCircle } from '@lucide/svelte';
	import type { TodoItem, TodoStatus } from './todos';

	let { todos }: { todos: TodoItem[] } = $props();

	const ordered = $derived(
		[...todos].sort((a, b) => {
			const rank: Record<TodoStatus, number> = { in_progress: 0, pending: 1, completed: 2 };
			return rank[a.status] - rank[b.status];
		})
	);
</script>

<aside class="rounded-md border bg-card p-3">
	<h2 class="mb-2 text-sm font-medium">Plan actuel</h2>
	{#if ordered.length === 0}
		<p class="text-sm text-muted-foreground">Aucune todo active.</p>
	{:else}
		<ul class="space-y-2">
			{#each ordered as todo, index (`${todo.status}-${todo.content}-${index}`)}
				<li class="flex gap-2 text-sm">
					{#if todo.status === 'completed'}
						<CircleCheck class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
					{:else if todo.status === 'in_progress'}
						<LoaderCircle class="mt-0.5 h-4 w-4 shrink-0 text-primary" />
					{:else}
						<Circle class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
					{/if}
					<span class={todo.status === 'completed' ? 'text-muted-foreground line-through' : ''}>
						{todo.activeForm || todo.content}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</aside>
