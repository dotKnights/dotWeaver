<script lang="ts">
	import { renderMarkdown } from './markdown';

	let { source }: { source: string } = $props();
	const html = $derived(renderMarkdown(source));
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify in renderMarkdown -->
<div class="prose prose-sm max-w-none text-sm">{@html html}</div>
