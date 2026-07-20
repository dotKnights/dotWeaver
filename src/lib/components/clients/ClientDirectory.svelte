<script lang="ts">
	import { browser } from '$app/environment';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import {
		createClient,
		deleteClient,
		inviteClient,
		listClients,
		removeClientContact
	} from '$lib/rfc/client-access.remote';
	import {
		AlertCircle,
		Building2,
		Check,
		Copy,
		LoaderCircle,
		MailPlus,
		Plus,
		Trash2,
		UserRound
	} from '@lucide/svelte';

	type ClientRole = 'admin' | 'member';

	type ClientMember = {
		id: string;
		role: string;
		user: {
			name: string | null;
			email: string | null;
		} | null;
	};

	type ClientInvitation = {
		id: string;
		email: string;
		role: string;
		status: string;
	};

	type ClientOrganization = {
		id: string;
		name: string;
		slug: string;
		members: ClientMember[];
		invitations: ClientInvitation[];
	};

	const clients = listClients();

	let clientName = $state('');
	let createError = $state<string | null>(null);
	let creating = $state(false);

	let inviteEmailByClient = $state<Record<string, string>>({});
	let inviteRoleByClient = $state<Record<string, ClientRole>>({});
	let inviteErrorByClient = $state<Record<string, string | null>>({});
	let invitingClientId = $state<string | null>(null);
	let copiedInvitationId = $state<string | null>(null);
	let removingMemberId = $state<string | null>(null);
	let deletingClientId = $state<string | null>(null);
	let mutationError = $state<string | null>(null);

	const clientList = $derived((clients.current ?? []) as ClientOrganization[]);
	const hasClients = $derived(clientList.length > 0);

	function invitationUrl(invitationId: string): string {
		const path = `/accept-client-invitation/${invitationId}`;
		return browser ? `${window.location.origin}${path}` : path;
	}

	function setInviteEmail(clientId: string, value: string) {
		inviteEmailByClient = { ...inviteEmailByClient, [clientId]: value };
	}

	function setInviteRole(clientId: string, value: string) {
		inviteRoleByClient = {
			...inviteRoleByClient,
			[clientId]: value === 'admin' ? 'admin' : 'member'
		};
	}

	function setInviteError(clientId: string, message: string | null) {
		inviteErrorByClient = { ...inviteErrorByClient, [clientId]: message };
	}

	async function copyInvitation(invitationId: string) {
		if (!browser) return;
		await navigator.clipboard.writeText(invitationUrl(invitationId));
		copiedInvitationId = invitationId;
	}

	async function handleCreate(event: SubmitEvent) {
		event.preventDefault();
		if (!clientName.trim() || creating) return;

		createError = null;
		creating = true;
		try {
			await createClient({ name: clientName.trim() });
			clientName = '';
			await clients.refresh();
		} catch (e) {
			createError = e instanceof Error ? e.message : 'Failed to create client';
		} finally {
			creating = false;
		}
	}

	async function handleRemoveContact(clientId: string, memberId: string) {
		if (removingMemberId) return;
		mutationError = null;
		removingMemberId = memberId;
		try {
			await removeClientContact({ clientOrganizationId: clientId, clientMemberId: memberId });
			await clients.refresh();
		} catch (e) {
			mutationError = e instanceof Error ? e.message : 'Failed to remove contact';
		} finally {
			removingMemberId = null;
		}
	}

	async function handleDeleteClient(clientId: string) {
		if (deletingClientId) return;
		mutationError = null;
		deletingClientId = clientId;
		try {
			await deleteClient({ clientOrganizationId: clientId });
			await clients.refresh();
		} catch (e) {
			mutationError = e instanceof Error ? e.message : 'Failed to delete client';
		} finally {
			deletingClientId = null;
		}
	}

	async function handleInvite(event: SubmitEvent, clientId: string) {
		event.preventDefault();
		const email = inviteEmailByClient[clientId]?.trim();
		if (!email || invitingClientId) return;

		setInviteError(clientId, null);
		invitingClientId = clientId;
		try {
			await inviteClient({
				clientOrganizationId: clientId,
				email,
				role: inviteRoleByClient[clientId] ?? 'member'
			});
			setInviteEmail(clientId, '');
			await clients.refresh();
		} catch (e) {
			setInviteError(clientId, e instanceof Error ? e.message : 'Failed to invite client');
		} finally {
			invitingClientId = null;
		}
	}
</script>

<section class="space-y-4" aria-label="External clients">
	<div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
		<div class="min-w-0 space-y-1">
			<h2 class="text-lg font-medium">External clients</h2>
			<p class="text-sm text-muted-foreground">
				Create client spaces, invite contacts, then grant access from each project.
			</p>
		</div>
	</div>

	<Card.Root class="rounded-lg shadow-sm">
		<Card.Header class="border-b">
			<div class="min-w-0">
				<Card.Title>Create client</Card.Title>
				<Card.Description>Use one client space per customer or partner.</Card.Description>
			</div>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#if createError}
				<Alert.Root variant="destructive">
					<AlertCircle class="size-4" strokeWidth={1.8} />
					<Alert.Description>{createError}</Alert.Description>
				</Alert.Root>
			{/if}

			<form
				class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
				onsubmit={handleCreate}
			>
				<div class="min-w-0 space-y-2">
					<Label for="client-name">Client name</Label>
					<Input
						id="client-name"
						name="name"
						placeholder="Acme"
						value={clientName}
						oninput={(event) => (clientName = (event.currentTarget as HTMLInputElement).value)}
					/>
				</div>
				<Button type="submit" disabled={creating || !clientName.trim()} class="w-full sm:w-fit">
					{#if creating}
						<LoaderCircle class="size-4 animate-spin" strokeWidth={1.8} />
						Creating
					{:else}
						<Plus class="size-4" strokeWidth={1.8} />
						Create
					{/if}
				</Button>
			</form>
		</Card.Content>
	</Card.Root>

	<Card.Root class="rounded-lg shadow-sm">
		<Card.Header class="border-b">
			<div class="min-w-0">
				<Card.Title>Client directory</Card.Title>
				<Card.Description>{clientList.length} client spaces</Card.Description>
			</div>
		</Card.Header>
		<Card.Content>
			{#if mutationError}
				<Alert.Root variant="destructive" class="mb-4">
					<AlertCircle class="size-4" strokeWidth={1.8} />
					<Alert.Description>{mutationError}</Alert.Description>
				</Alert.Root>
			{/if}
			{#if clients.error}
				<Alert.Root variant="destructive">
					<AlertCircle class="size-4" strokeWidth={1.8} />
					<Alert.Description>{clients.error.message}</Alert.Description>
				</Alert.Root>
			{:else if clients.current}
				{#if !hasClients}
					<div class="rounded-lg border bg-muted/20 p-4">
						<div class="flex min-w-0 gap-3">
							<span
								class="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground"
							>
								<Building2 class="size-4" strokeWidth={1.8} />
							</span>
							<div class="min-w-0 space-y-1">
								<p class="text-sm font-medium">No clients yet</p>
								<p class="text-sm text-muted-foreground">
									Create a client before sharing project access.
								</p>
							</div>
						</div>
					</div>
				{:else}
					<ul class="space-y-3">
						{#each clientList as client (client.id)}
							<li class="rounded-lg border bg-background p-4">
								<div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
									<div class="min-w-0 space-y-3">
										<div class="flex min-w-0 items-start gap-3">
											<span
												class="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground"
											>
												<Building2 class="size-4" strokeWidth={1.8} />
											</span>
											<div class="min-w-0 flex-1">
												<p class="truncate text-sm font-medium">{client.name}</p>
												<p class="truncate text-xs text-muted-foreground">/{client.slug}</p>
											</div>
											<Button
												variant="ghost"
												size="sm"
												class="shrink-0 text-destructive hover:text-destructive"
												aria-label="Delete client"
												disabled={deletingClientId === client.id}
												onclick={() => void handleDeleteClient(client.id)}
											>
												{#if deletingClientId === client.id}
													<LoaderCircle class="size-4 animate-spin" strokeWidth={1.8} />
												{:else}
													<Trash2 class="size-4" strokeWidth={1.8} />
												{/if}
											</Button>
										</div>

										<div class="space-y-2">
											<p class="text-xs font-medium text-muted-foreground">Members</p>
											{#if client.members.length === 0}
												<p class="text-sm text-muted-foreground">No account created yet.</p>
											{:else}
												<ul class="divide-y rounded-lg border">
													{#each client.members as member (member.id)}
														<li class="flex min-w-0 items-center justify-between gap-3 p-2">
															<div class="flex min-w-0 items-center gap-2">
																<UserRound
																	class="size-4 shrink-0 text-muted-foreground"
																	strokeWidth={1.8}
																/>
																<span class="truncate text-sm">
																	{member.user?.email ?? member.user?.name ?? 'Unknown user'}
																</span>
															</div>
															<div class="flex shrink-0 items-center gap-2">
																<Badge variant="outline">{member.role}</Badge>
																<Button
																	variant="ghost"
																	size="sm"
																	aria-label="Remove contact"
																	disabled={removingMemberId === member.id}
																	onclick={() => void handleRemoveContact(client.id, member.id)}
																>
																	{#if removingMemberId === member.id}
																		<LoaderCircle class="size-3.5 animate-spin" strokeWidth={1.8} />
																	{:else}
																		<Trash2 class="size-3.5" strokeWidth={1.8} />
																	{/if}
																</Button>
															</div>
														</li>
													{/each}
												</ul>
											{/if}
										</div>

										{#if client.invitations.length > 0}
											<div class="space-y-2">
												<p class="text-xs font-medium text-muted-foreground">Pending invitations</p>
												<ul class="divide-y rounded-lg border">
													{#each client.invitations as invitation (invitation.id)}
														<li
															class="grid gap-2 p-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
														>
															<div class="min-w-0">
																<p class="truncate text-sm">{invitation.email}</p>
																<p class="truncate text-xs text-muted-foreground">
																	{invitation.role} · {invitation.status}
																</p>
															</div>
															<Button
																variant="outline"
																size="sm"
																onclick={() => void copyInvitation(invitation.id)}
															>
																{#if copiedInvitationId === invitation.id}
																	<Check class="size-3.5" strokeWidth={1.8} />
																	Copied
																{:else}
																	<Copy class="size-3.5" strokeWidth={1.8} />
																	Copy link
																{/if}
															</Button>
														</li>
													{/each}
												</ul>
											</div>
										{/if}
									</div>

									<form class="space-y-3" onsubmit={(event) => handleInvite(event, client.id)}>
										<div class="space-y-2">
											<Label for={`client-email-${client.id}`}>Invite email</Label>
											<Input
												id={`client-email-${client.id}`}
												type="email"
												placeholder="client@example.com"
												value={inviteEmailByClient[client.id] ?? ''}
												oninput={(event) =>
													setInviteEmail(
														client.id,
														(event.currentTarget as HTMLInputElement).value
													)}
											/>
										</div>
										<div class="space-y-2">
											<Label for={`client-role-${client.id}`}>Role</Label>
											<select
												id={`client-role-${client.id}`}
												class="h-8 w-full rounded-none border border-input bg-transparent px-2 text-xs"
												value={inviteRoleByClient[client.id] ?? 'member'}
												onchange={(event) =>
													setInviteRole(
														client.id,
														(event.currentTarget as HTMLSelectElement).value
													)}
											>
												<option value="member">Member</option>
												<option value="admin">Admin</option>
											</select>
										</div>
										{#if inviteErrorByClient[client.id]}
											<p class="text-sm text-destructive" role="alert">
												{inviteErrorByClient[client.id]}
											</p>
										{/if}
										<Button
											type="submit"
											variant="outline"
											disabled={invitingClientId === client.id ||
												!(inviteEmailByClient[client.id] ?? '').trim()}
											class="w-full"
										>
											{#if invitingClientId === client.id}
												<LoaderCircle class="size-4 animate-spin" strokeWidth={1.8} />
												Sending
											{:else}
												<MailPlus class="size-4" strokeWidth={1.8} />
												Send invitation
											{/if}
										</Button>
									</form>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			{:else}
				<div
					class="flex items-center gap-2 rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground"
				>
					<LoaderCircle class="size-4 animate-spin" strokeWidth={1.8} />
					Loading clients
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</section>
