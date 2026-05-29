<script lang="ts">
	import { superForm, defaults } from 'sveltekit-superforms';
	import { zod4 as zod, zod4Client as zodClient } from 'sveltekit-superforms/adapters';
	import { createTeamSchema } from '$lib/schemas/teams';
	import { goto } from '$app/navigation';
	import { listMyTeams, createTeam } from './teams.remote';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import * as Alert from '$lib/components/ui/alert';

	let loading = $state(false);
	let createError = $state<string | null>(null);

	// Reactive query — `.current` refreshes after createTeam() and avoids SSR hydration suspense.
	const myTeams = listMyTeams();

	const { form, errors, enhance } = superForm(defaults(zod(createTeamSchema)), {
		SPA: true,
		// Prevent superForm's post-submit invalidateAll/applyAction from aborting our goto().
		invalidateAll: false,
		applyAction: false,
		validators: zodClient(createTeamSchema),
		async onUpdate({ form }) {
			if (!form.valid) return;
			createError = null;
			loading = true;
			try {
				const { slug } = await createTeam({ name: form.data.name });
				await goto('/teams/' + slug);
			} catch (e) {
				createError = e instanceof Error ? e.message : 'Failed to create team';
				loading = false;
			}
		}
	});
</script>

<div class="mx-auto flex max-w-2xl flex-col gap-6 p-6">
	<Card.Root>
		<Card.Header>
			<Card.Title>Create a team</Card.Title>
			<Card.Description>Start a new team and invite members.</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#if createError}
				<Alert.Root variant="destructive">
					<Alert.Description>{createError}</Alert.Description>
				</Alert.Root>
			{/if}

			<form method="POST" use:enhance class="space-y-4">
				<div class="space-y-2">
					<Label for="name">Team name</Label>
					<Input
						id="name"
						name="name"
						placeholder="Acme Inc."
						bind:value={$form.name}
						aria-invalid={$errors.name ? 'true' : undefined}
					/>
					{#if $errors.name}
						<p class="text-sm text-destructive">{$errors.name}</p>
					{/if}
				</div>

				<Button type="submit" disabled={loading}>
					{loading ? 'Creating…' : 'Create team'}
				</Button>
			</form>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>My teams</Card.Title>
		</Card.Header>
		<Card.Content>
			{#if myTeams.error}
				<Alert.Root variant="destructive">
					<Alert.Description>{myTeams.error.message}</Alert.Description>
				</Alert.Root>
			{:else if myTeams.current}
				{@const { teams, activeOrganizationId } = myTeams.current}
				{#if teams.length === 0}
					<p class="text-sm text-muted-foreground">You are not a member of any team yet.</p>
				{:else}
					<ul class="divide-y">
						{#each teams as team (team.id)}
							<li class="flex items-center justify-between py-2">
								<a href={'/teams/' + team.slug} class="underline underline-offset-4">
									{team.name}
								</a>
								{#if team.id === activeOrganizationId}
									<span class="text-xs font-medium text-muted-foreground">Active</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			{:else}
				<p class="text-sm text-muted-foreground">Loading teams…</p>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
