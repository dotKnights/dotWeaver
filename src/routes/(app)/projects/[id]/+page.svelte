<script lang="ts">
	import { page } from '$app/state';
	import { getProject } from '$lib/rfc/projects.remote';

	const project = getProject(page.params.id!);
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
		<p class="text-sm text-muted-foreground">
			Running agents on this project comes in the next phase.
		</p>
	{:else}
		<p class="text-sm text-muted-foreground">Loading project…</p>
	{/if}
</div>
