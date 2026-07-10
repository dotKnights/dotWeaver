<script lang="ts">
	import { authClient } from '$lib/auth-client';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { listMyTeams } from '$lib/rfc/teams.remote';
	import { Cable, FolderKanban, LogOut, PlayCircle, Users } from '@lucide/svelte';

	let { data } = $props();
	const myTeams = listMyTeams();
	const hasInternalTeams = $derived(myTeams.current?.hasInternalTeams ?? false);

	const displayName = $derived(
		data.user?.name?.trim() || data.user?.email || 'dotWeaver workspace'
	);
	const identityLine = $derived(
		data.user?.email && data.user.email !== displayName ? data.user.email : 'Signed in'
	);

	async function signOut() {
		try {
			await authClient.signOut();
		} catch {
			// proceed to login regardless
		}
		goto('/login');
	}

	function initials(value: string | null | undefined) {
		const parts = (value ?? 'DW').trim().split(/\s+/).filter(Boolean);
		if (parts.length > 1) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
		return (parts[0]?.slice(0, 2) || 'DW').toUpperCase();
	}
</script>

<svelte:head>
	<title>Dashboard | dotWeaver</title>
</svelte:head>

<div class="space-y-6">
	<section class="rounded-lg border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
		<div class="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
			<div class="min-w-0 space-y-4">
				<div class="flex min-w-0 items-center gap-3">
					{#if data.user}
						<span
							class="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted text-xs font-semibold text-muted-foreground"
							aria-hidden="true"
						>
							{initials(displayName)}
						</span>
						<p class="min-w-0 text-sm text-muted-foreground">
							<span class="text-foreground">Welcome, {displayName}</span>
							<span class="block truncate">{identityLine}</span>
						</p>
					{:else}
						<p class="text-sm text-muted-foreground">Welcome to your workspace.</p>
					{/if}
				</div>

				<div class="max-w-3xl space-y-2">
					<h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">Dashboard</h1>
					<p class="text-sm text-muted-foreground">
						{hasInternalTeams
							? 'Jump back into projects, teams, and connected services from one quiet workspace.'
							: 'Jump back into the projects shared with your account.'}
					</p>
				</div>
			</div>

			<Button variant="outline" onclick={signOut} class="w-full sm:w-fit">
				<LogOut class="size-4" strokeWidth={1.8} />
				Sign out
			</Button>
		</div>
	</section>

	<section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Workspace shortcuts">
		<a
			href="/projects"
			class="group flex min-w-0 items-center gap-3 rounded-lg border bg-background p-4 transition-colors hover:border-primary/40 hover:bg-muted/35 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
		>
			<span class="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card">
				<FolderKanban class="size-4" strokeWidth={1.8} />
			</span>
			<span class="min-w-0">
				<span class="block truncate text-sm font-medium">Projects</span>
				<span class="block truncate text-xs text-muted-foreground">Open imported repositories</span>
			</span>
		</a>

		{#if hasInternalTeams}
			<a
				href="/teams"
				class="group flex min-w-0 items-center gap-3 rounded-lg border bg-background p-4 transition-colors hover:border-primary/40 hover:bg-muted/35 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
			>
				<span class="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card">
					<Users class="size-4" strokeWidth={1.8} />
				</span>
				<span class="min-w-0">
					<span class="block truncate text-sm font-medium">Teams</span>
					<span class="block truncate text-xs text-muted-foreground">Manage shared workspaces</span>
				</span>
			</a>
		{/if}

		{#if hasInternalTeams}
			<a
				href="/settings/connectors"
				class="group flex min-w-0 items-center gap-3 rounded-lg border bg-background p-4 transition-colors hover:border-primary/40 hover:bg-muted/35 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
			>
				<span class="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card">
					<Cable class="size-4" strokeWidth={1.8} />
				</span>
				<span class="min-w-0">
					<span class="block truncate text-sm font-medium">Connectors</span>
					<span class="block truncate text-xs text-muted-foreground"
						>Link GitHub, Gmail, and Poke</span
					>
				</span>
			</a>
		{/if}

		{#if hasInternalTeams}
			<a
				href="/projects"
				class="group flex min-w-0 items-center gap-3 rounded-lg border bg-background p-4 transition-colors hover:border-primary/40 hover:bg-muted/35 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
			>
				<span class="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card">
					<PlayCircle class="size-4" strokeWidth={1.8} />
				</span>
				<span class="min-w-0">
					<span class="block truncate text-sm font-medium">Next run</span>
					<span class="block truncate text-xs text-muted-foreground">Pick a project and start</span>
				</span>
			</a>
		{/if}
	</section>

	<section class="rounded-lg border bg-muted/20 p-5">
		<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
			<div class="min-w-0 space-y-1">
				<h2 class="truncate text-sm font-medium">
					{hasInternalTeams ? 'Ready for the next run?' : 'Open shared projects'}
				</h2>
				<p class="text-sm text-muted-foreground">
					{hasInternalTeams
						? 'Open a project, choose a base branch, and hand off the next change.'
						: 'Review the projects your team has shared with you.'}
				</p>
			</div>
			<Button href="/projects" class="w-full sm:w-fit">Open projects</Button>
		</div>
	</section>
</div>
