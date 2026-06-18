<script lang="ts">
	import { page } from '$app/state';
	import Markdown from '$lib/components/runs/Markdown.svelte';
	import { getCdcDocument } from '$lib/rfc/cdc-documents.remote';

	const document = $derived(getCdcDocument(page.params.cdcId!));
</script>

<div class="mx-auto max-w-5xl space-y-6 p-6">
	{#if document.error}
		<p class="text-sm text-red-500">{document.error.message}</p>
	{:else if document.current}
		<div class="flex items-center justify-between">
			<h1 class="text-2xl font-semibold">{document.current.title}</h1>
			<a href={`/projects/${document.current.project.id}`} class="text-sm hover:underline"
				>← Project</a
			>
		</div>
		<dl class="grid grid-cols-2 gap-2 text-sm">
			<dt class="text-muted-foreground">Project</dt>
			<dd>{document.current.project.owner}/{document.current.project.name}</dd>
			<dt class="text-muted-foreground">Version</dt>
			<dd>v{document.current.version}</dd>
			<dt class="text-muted-foreground">Run</dt>
			<dd>
				<a
					href={`/projects/${document.current.project.id}/runs/${document.current.run.id}`}
					class="hover:underline"
				>
					{document.current.run.id.slice(0, 8)} ({document.current.run.status})
				</a>
			</dd>
			<dt class="text-muted-foreground">Created</dt>
			<dd>{new Date(document.current.createdAt).toLocaleString()}</dd>
		</dl>
		<article class="rounded-md border p-4">
			<Markdown source={document.current.markdown} />
		</article>
	{:else}
		<p class="text-sm text-muted-foreground">Loading CDC document…</p>
	{/if}
</div>
