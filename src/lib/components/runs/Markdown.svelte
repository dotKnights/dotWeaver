<script lang="ts">
	import { renderMarkdown } from './markdown';

	let { source }: { source: string } = $props();
	const html = $derived(renderMarkdown(source));
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify in renderMarkdown -->
<div class="md text-sm leading-relaxed break-words">{@html html}</div>

<style>
	.md :global(> :first-child) {
		margin-top: 0;
	}
	.md :global(> :last-child) {
		margin-bottom: 0;
	}
	.md :global(p) {
		margin: 0.4rem 0;
	}
	.md :global(h1),
	.md :global(h2),
	.md :global(h3),
	.md :global(h4) {
		font-weight: 600;
		line-height: 1.3;
		margin: 0.75rem 0 0.35rem;
	}
	.md :global(h1) {
		font-size: 1.1rem;
	}
	.md :global(h2) {
		font-size: 1rem;
	}
	.md :global(h3),
	.md :global(h4) {
		font-size: 0.9rem;
	}
	.md :global(ul),
	.md :global(ol) {
		margin: 0.4rem 0;
		padding-left: 1.25rem;
	}
	.md :global(ul) {
		list-style: disc;
	}
	.md :global(ol) {
		list-style: decimal;
	}
	.md :global(li) {
		margin: 0.15rem 0;
	}
	.md :global(a) {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.md :global(code) {
		font-family: ui-monospace, 'SFMono-Regular', monospace;
		font-size: 0.82em;
		background: var(--muted);
		padding: 0.1em 0.35em;
		border-radius: 0.25rem;
	}
	.md :global(pre) {
		background: var(--muted);
		border-radius: 0.4rem;
		padding: 0.65rem 0.8rem;
		overflow-x: auto;
		margin: 0.5rem 0;
	}
	.md :global(pre code) {
		background: none;
		padding: 0;
		font-size: 0.8rem;
	}
	.md :global(blockquote) {
		border-left: 2px solid var(--border);
		padding-left: 0.75rem;
		color: var(--muted-foreground);
		margin: 0.5rem 0;
	}
	.md :global(strong) {
		font-weight: 600;
	}
	.md :global(hr) {
		border: 0;
		border-top: 1px solid var(--border);
		margin: 0.75rem 0;
	}
	.md :global(table) {
		border-collapse: collapse;
		font-size: 0.8rem;
		margin: 0.5rem 0;
	}
	.md :global(th),
	.md :global(td) {
		border: 1px solid var(--border);
		padding: 0.25rem 0.5rem;
		text-align: left;
	}
</style>
