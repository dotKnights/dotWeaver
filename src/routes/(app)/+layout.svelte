<script lang="ts">
	import { listMyTeams, setActiveTeam } from '$lib/rfc/teams.remote';
	import * as Select from '$lib/components/ui/select';

	let { children } = $props();

	// Reactive query: `.current` updates on refresh (e.g. after creating/switching a team),
	// and avoids the SSR hydration suspense that `{#await}` would require.
	const myTeams = listMyTeams();

	async function onChangeTeam(id: string) {
		if (!id) return;
		await setActiveTeam(id);
	}
</script>

<header class="flex items-center justify-between border-b px-6 py-3">
	<div class="flex items-center gap-4">
		<a href="/dashboard" class="text-lg font-semibold">dotWeaver</a>
		<a href="/projects" class="text-sm font-medium hover:underline">Projects</a>
		<a href="/mail" class="text-sm font-medium hover:underline">Mail</a>
		<a href="/settings/connectors" class="text-sm font-medium hover:underline">Connecteurs</a>
	</div>

	{#if myTeams.current}
		{@const { teams, activeOrganizationId } = myTeams.current}
		{#if teams.length === 0}
			<a href="/teams" class="text-sm underline underline-offset-4">Create a team</a>
		{:else}
			<Select.Root type="single" value={activeOrganizationId ?? ''} onValueChange={onChangeTeam}>
				<Select.Trigger>
					{teams.find((t) => t.id === activeOrganizationId)?.name ?? 'Select a team'}
				</Select.Trigger>
				<Select.Content>
					{#each teams as team (team.id)}
						<Select.Item value={team.id} label={team.name} />
					{/each}
				</Select.Content>
			</Select.Root>
		{/if}
	{/if}
</header>

{@render children()}
