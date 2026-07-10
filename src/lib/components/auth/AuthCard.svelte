<script lang="ts">
	import * as Alert from '$lib/components/ui/alert';
	import * as Card from '$lib/components/ui/card';
	import type { Snippet } from 'svelte';

	type Props = {
		title: string;
		description: string;
		authError?: string | null;
		footerText: string;
		footerHref: string;
		footerLinkLabel: string;
		children: Snippet;
	};

	let {
		title,
		description,
		authError = null,
		footerText,
		footerHref,
		footerLinkLabel,
		children
	}: Props = $props();
</script>

<div class="flex min-h-screen items-center justify-center">
	<Card.Root class="w-full max-w-md">
		<Card.Header>
			<Card.Title>{title}</Card.Title>
			<Card.Description>{description}</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#if authError}
				<Alert.Root variant="destructive">
					<Alert.Description>{authError}</Alert.Description>
				</Alert.Root>
			{/if}

			{@render children()}
		</Card.Content>
		<Card.Footer>
			<p class="text-sm text-muted-foreground">
				{footerText}
				<a href={footerHref} class="text-foreground underline underline-offset-4">
					{footerLinkLabel}
				</a>
			</p>
		</Card.Footer>
	</Card.Root>
</div>
