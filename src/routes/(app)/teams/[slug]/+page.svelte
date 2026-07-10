<script lang="ts">
	import { superForm, defaults } from 'sveltekit-superforms';
	import { zod4 as zod, zod4Client as zodClient } from 'sveltekit-superforms/adapters';
	import { inviteSchema } from '$lib/schemas/teams';
	import { page } from '$app/state';
	import { getTeam, inviteMember, cancelInvitation, removeMember } from '$lib/rfc/teams.remote';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import * as Alert from '$lib/components/ui/alert';
	import ClientDirectory from '$lib/components/clients/ClientDirectory.svelte';

	const slug = $derived(page.params.slug ?? '');
	// Reactive query keyed by slug: `.current` avoids SSR hydration suspense and updates on refresh.
	const teamQuery = $derived(getTeam(slug));

	let inviteError = $state<string | null>(null);
	let inviteLoading = $state(false);
	let lastLink = $state<string | null>(null);

	const { form, errors, enhance } = superForm(defaults(zod(inviteSchema)), {
		SPA: true,
		validators: zodClient(inviteSchema),
		async onUpdate({ form }) {
			if (!form.valid) return;
			const organizationId = teamQuery.current?.org.id;
			if (!organizationId) return;
			inviteError = null;
			inviteLoading = true;
			try {
				const { invitationId } = await inviteMember({
					email: form.data.email,
					role: form.data.role,
					organizationId
				});
				lastLink = `${location.origin}/accept-invitation/${invitationId}`;
				await getTeam(slug).refresh();
			} catch (e) {
				inviteError = e instanceof Error ? e.message : 'Failed to invite member';
			} finally {
				inviteLoading = false;
			}
		}
	});

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
	}
</script>

<div class="mx-auto flex max-w-5xl flex-col gap-6 p-6">
	{#if teamQuery.error}
		<Alert.Root variant="destructive">
			<Alert.Description>{teamQuery.error.message}</Alert.Description>
		</Alert.Root>
	{:else if teamQuery.current}
		{@const { org, pendingInvitations } = teamQuery.current}
		<h1 class="text-2xl font-semibold">{org.name}</h1>

		<Card.Root>
			<Card.Header>
				<Card.Title>Members</Card.Title>
			</Card.Header>
			<Card.Content>
				<ul class="divide-y">
					{#each org.members as member (member.id)}
						<li class="flex items-center justify-between py-2">
							<div>
								<span>{member.user?.email ?? member.user?.name}</span>
								<span class="text-xs text-muted-foreground">({member.role})</span>
							</div>
							{#if member.role !== 'owner'}
								<Button
									variant="outline"
									size="sm"
									onclick={async () => {
										await removeMember({ organizationId: org.id, memberIdOrEmail: member.id });
										await getTeam(slug).refresh();
									}}
								>
									Remove
								</Button>
							{/if}
						</li>
					{/each}
				</ul>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Invite a member</Card.Title>
			</Card.Header>
			<Card.Content class="space-y-4">
				{#if inviteError}
					<Alert.Root variant="destructive">
						<Alert.Description>{inviteError}</Alert.Description>
					</Alert.Root>
				{/if}

				<form method="POST" use:enhance class="space-y-4">
					<div class="space-y-2">
						<Label for="email">Email</Label>
						<Input
							id="email"
							name="email"
							type="email"
							placeholder="member@example.com"
							bind:value={$form.email}
							aria-invalid={$errors.email ? 'true' : undefined}
						/>
						{#if $errors.email}
							<p class="text-sm text-destructive">{$errors.email}</p>
						{/if}
					</div>

					<div class="space-y-2">
						<Label for="role">Role</Label>
						<select
							id="role"
							name="role"
							bind:value={$form.role}
							class="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
						>
							<option value="member">Member</option>
							<option value="admin">Admin</option>
						</select>
						{#if $errors.role}
							<p class="text-sm text-destructive">{$errors.role}</p>
						{/if}
					</div>

					<Button type="submit" disabled={inviteLoading}>
						{inviteLoading ? 'Sending…' : 'Send invitation'}
					</Button>
				</form>

				{#if lastLink}
					<div class="flex items-center gap-2 rounded-md border p-3">
						<code class="flex-1 truncate text-xs">{lastLink}</code>
						<Button variant="outline" size="sm" onclick={() => lastLink && copy(lastLink)}>
							Copy link
						</Button>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Pending invitations</Card.Title>
			</Card.Header>
			<Card.Content>
				{#if pendingInvitations.length === 0}
					<p class="text-sm text-muted-foreground">No pending invitations.</p>
				{:else}
					<ul class="divide-y">
						{#each pendingInvitations as inv (inv.id)}
							<li class="flex items-center justify-between gap-2 py-2">
								<div>
									<span>{inv.email}</span>
									<span class="text-xs text-muted-foreground">({inv.role})</span>
								</div>
								<div class="flex gap-2">
									<Button
										variant="outline"
										size="sm"
										onclick={() => copy(`${location.origin}/accept-invitation/${inv.id}`)}
									>
										Copy link
									</Button>
									<Button
										variant="outline"
										size="sm"
										onclick={async () => {
											await cancelInvitation(inv.id);
											await getTeam(slug).refresh();
										}}
									>
										Cancel
									</Button>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</Card.Content>
		</Card.Root>

		<ClientDirectory />
	{:else}
		<p class="text-sm text-muted-foreground">Loading team…</p>
	{/if}
</div>
