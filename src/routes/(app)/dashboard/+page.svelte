<script lang="ts">
	import { authClient } from '$lib/auth-client';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';

	let { data } = $props();

	async function signOut() {
		try {
			await authClient.signOut();
		} catch {
			// proceed to login regardless
		}
		goto('/login');
	}
</script>

<div class="flex min-h-screen flex-col items-center justify-center gap-4">
	<h1 class="text-2xl font-bold">Dashboard</h1>
	{#if data.user}
		<p class="text-muted-foreground">Welcome, {data.user.name}</p>
	{/if}
	<Button variant="outline" onclick={signOut}>Sign out</Button>
</div>
