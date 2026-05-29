<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { acceptInvitation } from '../../teams/teams.remote';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import * as Alert from '$lib/components/ui/alert';

	const id = $derived(page.params.id ?? '');

	let loading = $state(false);
	let acceptError = $state<string | null>(null);

	async function accept() {
		acceptError = null;
		loading = true;
		try {
			await acceptInvitation(id);
			goto('/teams');
		} catch (e) {
			acceptError = e instanceof Error ? e.message : 'Failed to accept invitation';
			loading = false;
		}
	}
</script>

<div class="flex min-h-screen items-center justify-center p-6">
	<Card.Root class="w-full max-w-md">
		<Card.Header>
			<Card.Title>Accept invitation</Card.Title>
			<Card.Description>You have been invited to join a team.</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#if acceptError}
				<Alert.Root variant="destructive">
					<Alert.Description>{acceptError}</Alert.Description>
				</Alert.Root>
			{/if}

			<Button class="w-full" disabled={loading} onclick={accept}>
				{loading ? 'Accepting…' : 'Accept invitation'}
			</Button>
		</Card.Content>
	</Card.Root>
</div>
