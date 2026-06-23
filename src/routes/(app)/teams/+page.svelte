<script lang="ts">
	import { superForm, defaults } from 'sveltekit-superforms';
	import { zod4 as zod, zod4Client as zodClient } from 'sveltekit-superforms/adapters';
	import { createTeamSchema } from '$lib/schemas/teams';
	import { goto } from '$app/navigation';
	import { listMyTeams, createTeam } from '$lib/rfc/teams.remote';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { AlertCircle, ArrowRight, LoaderCircle, Plus, Users } from '@lucide/svelte';
	import { fromAction } from 'svelte/attachments';

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
	const enhanceAttachment = fromAction(enhance);
</script>

<svelte:head>
	<title>Teams | dotWeaver</title>
</svelte:head>

<div class="space-y-6">
	<header class="border-b pb-5">
		<div class="max-w-3xl space-y-1">
			<h1 class="text-2xl font-semibold tracking-tight">Teams</h1>
			<p class="text-sm text-muted-foreground">
				Create shared workspaces and choose the active team for your runs.
			</p>
		</div>
	</header>

	<div class="grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
		<Card.Root class="rounded-lg shadow-sm">
			<Card.Header class="border-b">
				<Card.Title>Create a team</Card.Title>
				<Card.Description>Start a workspace for projects, members, and runs.</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				{#if createError}
					<Alert.Root variant="destructive">
						<AlertCircle class="size-4" strokeWidth={1.8} />
						<Alert.Description>{createError}</Alert.Description>
					</Alert.Root>
				{/if}

				<form method="POST" {@attach enhanceAttachment} class="space-y-4">
					<div class="space-y-2">
						<Label for="name">Team name</Label>
						<Input
							id="name"
							name="name"
							placeholder="Core platform"
							bind:value={$form.name}
							aria-invalid={$errors.name ? 'true' : undefined}
						/>
						{#if $errors.name}
							<p class="text-sm text-destructive">{$errors.name}</p>
						{/if}
					</div>

					<Button type="submit" disabled={loading} class="w-full sm:w-fit">
						{#if loading}
							<LoaderCircle class="size-4 animate-spin" strokeWidth={1.8} />
							Creating
						{:else}
							<Plus class="size-4" strokeWidth={1.8} />
							Create team
						{/if}
					</Button>
				</form>
			</Card.Content>
		</Card.Root>

		<Card.Root class="rounded-lg shadow-sm">
			<Card.Header class="border-b">
				<Card.Title>My teams</Card.Title>
				<Card.Description>Open a team or check which one is currently active.</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if myTeams.error}
					<Alert.Root variant="destructive">
						<AlertCircle class="size-4" strokeWidth={1.8} />
						<Alert.Description>{myTeams.error.message}</Alert.Description>
					</Alert.Root>
				{:else if myTeams.current}
					{@const { teams, activeOrganizationId } = myTeams.current}
					{#if teams.length === 0}
						<div class="rounded-lg border bg-muted/20 p-4">
							<div class="flex min-w-0 gap-3">
								<span
									class="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground"
								>
									<Users class="size-4" strokeWidth={1.8} />
								</span>
								<div class="min-w-0 space-y-1">
									<p class="text-sm font-medium">No teams yet</p>
									<p class="text-sm text-muted-foreground">
										Create your first team to start sharing projects.
									</p>
								</div>
							</div>
						</div>
					{:else}
						<ul class="overflow-hidden rounded-lg border">
							{#each teams as team (team.id)}
								<li class="border-b last:border-b-0">
									<a
										href={'/teams/' + team.slug}
										class="group grid min-w-0 gap-3 p-3 transition-colors hover:bg-muted/35 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
									>
										<div class="min-w-0 space-y-1">
											<p class="truncate text-sm font-medium">{team.name}</p>
											<p class="truncate text-xs text-muted-foreground">/{team.slug}</p>
										</div>
										<div class="flex min-w-0 items-center gap-2 sm:justify-end">
											{#if team.id === activeOrganizationId}
												<Badge
													variant="outline"
													class="rounded-full border-primary/25 bg-primary/5 text-primary"
												>
													Active team
												</Badge>
											{/if}
											<ArrowRight
												class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
												strokeWidth={1.8}
											/>
										</div>
									</a>
								</li>
							{/each}
						</ul>
					{/if}
				{:else}
					<div
						class="flex items-center gap-2 rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground"
					>
						<LoaderCircle class="size-4 animate-spin" strokeWidth={1.8} />
						Loading teams
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</div>
