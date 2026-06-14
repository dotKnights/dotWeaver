<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';

	type Status = 'connected' | 'disconnected' | 'needs_reconnect';

	let {
		name,
		status,
		description,
		icon,
		actions
	}: {
		name: string;
		status: Status;
		description?: string;
		icon?: Snippet;
		actions?: Snippet;
	} = $props();

	const badge = {
		connected: { label: 'Connecté', variant: 'default' as const },
		needs_reconnect: { label: 'Reconnexion requise', variant: 'secondary' as const },
		disconnected: { label: 'Non connecté', variant: 'outline' as const }
	};
</script>

<Card.Root>
	<Card.Header>
		<div class="flex items-center justify-between gap-3">
			<div class="flex items-center gap-3">
				{#if icon}{@render icon()}{/if}
				<Card.Title>{name}</Card.Title>
			</div>
			<Badge variant={badge[status].variant}>{badge[status].label}</Badge>
		</div>
		{#if description}
			<Card.Description>{description}</Card.Description>
		{/if}
	</Card.Header>
	{#if actions}
		<Card.Content class="flex flex-wrap gap-2">
			{@render actions()}
		</Card.Content>
	{/if}
</Card.Root>
