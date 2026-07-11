<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { listMyTeams, setActiveTeam } from '$lib/rfc/teams.remote';
	import AppSidebar from '$lib/components/layout/AppSidebar.svelte';
	import AppTopbar from '$lib/components/layout/AppTopbar.svelte';
	import { page } from '$app/stores';
	
	let { children } = $props();

	// Reactive query: `.current` updates on refresh (e.g. after creating/switching a team),
	// and avoids the SSR hydration suspense that `{#await}` would require.
	const myTeams = listMyTeams();
	const teams = $derived(
		myTeams.current?.teams.map((team) => ({
			id: team.id,
			name: team.name || 'Untitled team'
		})) ?? []
	);
	const activeTeamId = $derived(myTeams.current?.activeOrganizationId ?? null);
	const teamsLoading = $derived(!myTeams.current);

	async function onChangeTeam(id: string) {
		if (!id) return;
		await setActiveTeam(id);
		await refreshAll({ includeLoadFunctions: false });
	}
</script>


{#if $page.url.pathname !== '/oe'}
<div class="min-h-[100dvh] bg-background text-foreground">
	<div class="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:block lg:w-72">
		<AppSidebar {teams} {activeTeamId} {teamsLoading} {onChangeTeam} />
	</div>

	<div class="lg:hidden">
		<AppTopbar {teams} {activeTeamId} {teamsLoading} {onChangeTeam} />
	</div>

	<main class="min-h-[100dvh] px-4 py-5 sm:px-6 lg:ml-72 lg:px-8 lg:py-7">
		<div class="mx-auto w-full max-w-7xl">
			{@render children()}
		</div>
	</main>
</div>
{:else}

{@render children()}

{/if}