<script lang="ts">
	import { listMyTeams, setActiveTeam } from '$lib/rfc/teams.remote';

	let { children } = $props();

	// Reactive query: `.current` updates on refresh (e.g. after creating/switching a team),
	// and avoids the SSR hydration suspense that `{#await}` would require.
	const myTeams = listMyTeams();

	async function onChangeTeam(event: Event) {
		const id = (event.currentTarget as HTMLSelectElement).value;
		if (!id) return;
		await setActiveTeam(id);
	}
</script>

<header class="flex items-center justify-between border-b px-6 py-3">
	<a href="/dashboard" class="text-lg font-semibold">dotWeaver</a>

	{#if myTeams.current}
		{@const { teams, activeOrganizationId } = myTeams.current}
		{#if teams.length === 0}
			<a href="/teams" class="text-sm underline underline-offset-4">Create a team</a>
		{:else}
			<select
				value={activeOrganizationId ?? ''}
				onchange={onChangeTeam}
				class="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
			>
				<option value="" disabled>Select a team</option>
				{#each teams as team (team.id)}
					<option value={team.id}>{team.name}</option>
				{/each}
			</select>
		{/if}
	{/if}
</header>

{@render children()}
