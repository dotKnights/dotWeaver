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
		teams.find((team) => team.id === activeTeamId)?.name ?? 'Select a team'
	);

	function isActive(href: string) {
		return isNavItemActive(page.url.pathname, href);
	}

	async function handleTeamChange(id: string) {
		if (!id || id === activeTeamId) return;
		await onChangeTeam?.(id);
	}
</script>

<aside
	class="flex h-[100dvh] w-72 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
>
	<div class="flex h-20 shrink-0 items-center gap-3 border-b border-sidebar-border px-4">
		<a href="/dashboard" class="flex min-w-0 items-center gap-3" aria-label="dotWeaver dashboard">
			<span
				class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"
				aria-hidden="true"
			>
				<Command class="size-[1.125rem]" strokeWidth={1.8} />
			</span>
			<span class="min-w-0">
				<span class="block truncate text-sm font-semibold tracking-tight">dotWeaver</span>
				<span class="block truncate text-xs text-sidebar-foreground/55">AI command center</span>
			</span>
		</a>
	</div>

	<div class="space-y-2 border-b border-sidebar-border px-4 py-4">
		<p class="px-1 text-[11px] font-medium text-sidebar-foreground/55">Team</p>
		{#if teamsLoading}
			<div
				class="flex h-9 w-full items-center rounded-lg border border-sidebar-border bg-sidebar-accent/45 px-3 text-xs text-sidebar-foreground/55"
			>
				Loading teams
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
				Create team
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
				<Select.Content class="max-h-72 min-w-52">
					{#each teams as team (team.id)}
						<Select.Item value={team.id} label={team.name} />
					{/each}
				</Select.Content>
			</Select.Root>
		{/if}
	</div>

	<nav aria-label="Primary" class="flex-1 space-y-1 px-3 py-4">
		{#each navItems as item (item.href)}
			{@const Icon = item.icon}
			{@const active = isActive(item.href)}
			<a
				href={item.href}
				aria-current={active ? 'page' : undefined}
				class={cn(
					'flex h-10 min-w-0 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:ring-1 focus-visible:ring-sidebar-ring focus-visible:outline-none',
					active
						? 'bg-sidebar-primary text-sidebar-primary-foreground'
						: 'text-sidebar-foreground/68 hover:bg-sidebar-accent hover:text-sidebar-foreground'
				)}
			>
				<Icon class="size-4 shrink-0" strokeWidth={1.8} />
				<span class="truncate">{item.label}</span>
			</a>
		{/each}
	</nav>
</aside>
