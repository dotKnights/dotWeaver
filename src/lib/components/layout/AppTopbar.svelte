<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import * as Select from '$lib/components/ui/select';
	import { cn } from '$lib/utils.js';
	import { Command, Plus } from '@lucide/svelte';
	import { isNavItemActive, navItems as allNavItems, type TeamOption } from './navigation';

	type Props = {
		teams?: TeamOption[];
		activeTeamId?: string | null;
		teamsLoading?: boolean;
		hasInternalTeams?: boolean;
		hasClientAccess?: boolean;
		onChangeTeam?: (id: string) => void | Promise<void>;
	};

	let {
		teams = [],
		activeTeamId = null,
		teamsLoading = false,
		hasInternalTeams = false,
		hasClientAccess = false,
		onChangeTeam
	}: Props = $props();

	const navItems = $derived(
		allNavItems.filter((item) => !item.requiresInternalTeam || hasInternalTeams)
	);
	const activeTeamName = $derived(
		teams.find((team) => team.id === activeTeamId)?.name ?? 'Select team'
	);

	function isActive(href: string) {
		return isNavItemActive(page.url.pathname, href);
	}

	async function handleTeamChange(id: string) {
		if (!id || id === activeTeamId) return;
		await onChangeTeam?.(id);
	}
</script>

<header class="sticky top-0 z-20 border-b border-sidebar-border bg-sidebar text-sidebar-foreground">
	<div class="flex h-16 items-center justify-between gap-3 px-3 sm:px-4">
		<a href="/dashboard" class="flex min-w-0 items-center gap-2.5" aria-label="dotWeaver dashboard">
			<span
				class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"
				aria-hidden="true"
			>
				<Command class="size-4" strokeWidth={1.8} />
			</span>
			<span class="truncate text-sm font-semibold tracking-tight">dotWeaver</span>
		</a>

		<div class="flex w-[min(48vw,13rem)] shrink-0 justify-end">
			{#if teamsLoading}
				<div
					class="flex h-9 w-full items-center rounded-lg border border-sidebar-border bg-sidebar-accent/45 px-3 text-xs text-sidebar-foreground/55"
				>
					Loading
				</div>
			{:else if teams.length === 0 && hasClientAccess}
				<div
					class="flex h-9 w-full items-center rounded-lg border border-sidebar-border bg-sidebar-accent/45 px-3 text-xs text-sidebar-foreground/65"
				>
					Client access
				</div>
			{:else if teams.length === 0}
				<Button
					href="/teams"
					variant="outline"
					size="sm"
					class="h-9 w-full justify-start border-sidebar-border bg-sidebar-accent/55 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
				>
					<Plus class="size-3.5" strokeWidth={1.8} />
					<span class="truncate">Create team</span>
				</Button>
			{:else}
				<Select.Root type="single" value={activeTeamId ?? ''} onValueChange={handleTeamChange}>
					<Select.Trigger
						size="sm"
						class="h-9 w-full border-sidebar-border bg-sidebar-accent/55 text-sidebar-foreground hover:bg-sidebar-accent focus-visible:border-sidebar-ring focus-visible:ring-sidebar-ring/50"
						aria-label="Select active team"
					>
						<span class="min-w-0 truncate">{activeTeamName}</span>
					</Select.Trigger>
					<Select.Content class="max-h-72 min-w-48">
						{#each teams as team (team.id)}
							<Select.Item value={team.id} label={team.name} />
						{/each}
					</Select.Content>
				</Select.Root>
			{/if}
		</div>
	</div>

	<nav
		aria-label="Primary"
		class="flex h-14 gap-1 overflow-x-auto border-t border-sidebar-border px-2 py-2"
	>
		{#each navItems as item (item.href)}
			{@const Icon = item.icon}
			{@const active = isActive(item.href)}
			<a
				href={item.href}
				aria-current={active ? 'page' : undefined}
				class={cn(
					'flex h-10 min-w-20 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors focus-visible:ring-1 focus-visible:ring-sidebar-ring focus-visible:outline-none',
					active
						? 'bg-sidebar-primary text-sidebar-primary-foreground'
						: 'text-sidebar-foreground/68 hover:bg-sidebar-accent hover:text-sidebar-foreground'
				)}
			>
				<Icon class="size-3.5 shrink-0" strokeWidth={1.8} />
				<span class="truncate">{item.label}</span>
			</a>
		{/each}
	</nav>
</header>
