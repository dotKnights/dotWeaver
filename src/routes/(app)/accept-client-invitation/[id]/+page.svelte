<script lang="ts">
	import { goto, refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { acceptClientInvitation } from '$lib/rfc/client-access.remote';
	import { AlertCircle, Check, LoaderCircle } from '@lucide/svelte';

	const id = $derived(page.params.id ?? '');

	let loading = $state(false);
	let acceptError = $state<string | null>(null);
	let accepted = $state(false);

	async function accept() {
		if (!id || loading) return;

		acceptError = null;
		loading = true;
		try {
			await acceptClientInvitation(id);
			accepted = true;
			await refreshAll({ includeLoadFunctions: false });
			await goto('/projects');
		} catch (e) {
			acceptError = e instanceof Error ? e.message : 'Failed to accept invitation';
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Accept client invitation | dotWeaver</title>
</svelte:head>

<div class="flex min-h-[calc(100dvh-3rem)] items-center justify-center p-6">
	<Card.Root class="w-full max-w-md rounded-lg shadow-sm">
		<Card.Header class="border-b">
			<Card.Title>Accept client invitation</Card.Title>
			<Card.Description
				>Join the client space and open the projects shared with you.</Card.Description
			>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#if acceptError}
				<Alert.Root variant="destructive">
					<AlertCircle class="size-4" strokeWidth={1.8} />
					<Alert.Description>{acceptError}</Alert.Description>
				</Alert.Root>
			{/if}

			<Button class="w-full" disabled={loading || accepted || !id} onclick={accept}>
				{#if accepted}
					<Check class="size-4" strokeWidth={1.8} />
					Accepted
				{:else if loading}
					<LoaderCircle class="size-4 animate-spin" strokeWidth={1.8} />
					Accepting
				{:else}
					Accept invitation
				{/if}
			</Button>
		</Card.Content>
	</Card.Root>
</div>
