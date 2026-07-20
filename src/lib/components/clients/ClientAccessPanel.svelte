<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Alert from '$lib/components/ui/alert';
	import * as Card from '$lib/components/ui/card';
	import { permissionPresets, permissionRegistry } from '$lib/authz/permissions';
	import type { PermissionPresetKey } from '$lib/authz/permissions';
	import {
		getProjectAccess,
		listClients,
		removeProjectAccess,
		upsertProjectAccess
	} from '$lib/rfc/client-access.remote';
	import {
		AlertCircle,
		KeyRound,
		LoaderCircle,
		ShieldCheck,
		Trash2,
		UsersRound
	} from '@lucide/svelte';

	type SubjectType = 'client_organization' | 'client_member';

	type ClientMember = {
		id: string;
		role: string;
		user: {
			name: string | null;
			email: string | null;
		} | null;
	};

	type ClientOrganization = {
		id: string;
		name: string;
		members: ClientMember[];
	};

	type AccessGrant = {
		id: string;
		subjectType: SubjectType;
		subjectId: string;
		permissions: string[];
	};

	type SubjectOption = {
		value: string;
		subjectType: SubjectType;
		subjectId: string;
		label: string;
		description: string;
	};

	type Props = {
		projectId: string;
		canManageAccess?: boolean;
	};

	let { projectId, canManageAccess = true }: Props = $props();

	const clientsQuery = $derived(canManageAccess ? listClients() : null);
	const accessQuery = $derived(canManageAccess ? getProjectAccess(projectId) : null);
	const presetEntries = Object.entries(permissionPresets) as Array<
		[PermissionPresetKey, (typeof permissionPresets)[PermissionPresetKey]]
	>;
	const permissionLabels: ReadonlyMap<string, string> = new Map(
		permissionRegistry.permissions.map((permission) => [permission.key, permission.label])
	);

	let selectedSubject = $state('');
	let selectedPreset = $state<PermissionPresetKey>('project_access');
	let saving = $state(false);
	let removingSubject = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	const clients = $derived((clientsQuery?.current ?? []) as ClientOrganization[]);
	const grants = $derived((accessQuery?.current ?? []) as AccessGrant[]);
	const subjectOptions = $derived.by(() => {
		const options: SubjectOption[] = [];

		for (const client of clients) {
			options.push({
				value: subjectValue('client_organization', client.id),
				subjectType: 'client_organization',
				subjectId: client.id,
				label: client.name,
				description: 'All current and future members'
			});

			for (const member of client.members) {
				options.push({
					value: subjectValue('client_member', member.id),
					subjectType: 'client_member',
					subjectId: member.id,
					label: member.user?.email ?? member.user?.name ?? 'Unknown user',
					description: `${client.name} member`
				});
			}
		}

		return options;
	});

	function subjectValue(subjectType: SubjectType, subjectId: string) {
		return `${subjectType}:${subjectId}`;
	}

	function parseSubject(value: string): { subjectType: SubjectType; subjectId: string } | null {
		const [subjectType, subjectId] = value.split(':');
		if ((subjectType !== 'client_organization' && subjectType !== 'client_member') || !subjectId) {
			return null;
		}

		return { subjectType, subjectId };
	}

	function subjectLabel(subjectType: SubjectType, subjectId: string): string {
		return (
			subjectOptions.find((option) => option.value === subjectValue(subjectType, subjectId))
				?.label ?? subjectId
		);
	}

	function presetLabelForPermissions(permissions: string[]): string {
		const permissionSet = new Set(permissions);
		const exactPreset = presetEntries.find(([, preset]) => {
			return (
				preset.permissions.length === permissions.length &&
				preset.permissions.every((permission) => permissionSet.has(permission))
			);
		});

		return exactPreset?.[1].label ?? 'Custom';
	}

	function permissionLabel(permission: string): string {
		return permissionLabels.get(permission) ?? permission;
	}

	async function refreshAccess() {
		await accessQuery?.refresh();
	}

	async function handleGrant(event: SubmitEvent) {
		event.preventDefault();
		const subject = parseSubject(selectedSubject);
		if (!subject || saving) return;

		actionError = null;
		saving = true;
		try {
			await upsertProjectAccess({
				projectId,
				subjectType: subject.subjectType,
				subjectId: subject.subjectId,
				preset: selectedPreset
			});
			await refreshAccess();
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Failed to update project access';
		} finally {
			saving = false;
		}
	}

	async function handleRemove(grant: AccessGrant) {
		const key = subjectValue(grant.subjectType, grant.subjectId);
		if (removingSubject) return;

		actionError = null;
		removingSubject = key;
		try {
			await removeProjectAccess({
				projectId,
				subjectType: grant.subjectType,
				subjectId: grant.subjectId
			});
			await refreshAccess();
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Failed to remove project access';
		} finally {
			removingSubject = null;
		}
	}
</script>

{#if canManageAccess}
	<section class="space-y-3" aria-label="Project client access">
		<Card.Root size="sm">
			<Card.Header class="border-b">
				<div class="min-w-0 space-y-1">
					<Card.Title>Client access</Card.Title>
					<Card.Description
						>Grant project-scoped permissions to client spaces or members.</Card.Description
					>
				</div>
			</Card.Header>
			<Card.Content class="space-y-4">
				{#if actionError}
					<Alert.Root variant="destructive">
						<AlertCircle class="size-4" strokeWidth={1.8} />
						<Alert.Description>{actionError}</Alert.Description>
					</Alert.Root>
				{/if}

				{#if clientsQuery?.error}
					<Alert.Root variant="destructive">
						<AlertCircle class="size-4" strokeWidth={1.8} />
						<Alert.Description>{clientsQuery.error.message}</Alert.Description>
					</Alert.Root>
				{:else if accessQuery?.error}
					<Alert.Root variant="destructive">
						<AlertCircle class="size-4" strokeWidth={1.8} />
						<Alert.Description>{accessQuery.error.message}</Alert.Description>
					</Alert.Root>
				{:else if clientsQuery?.current && accessQuery?.current}
					<form
						class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(12rem,16rem)_auto]"
						onsubmit={handleGrant}
					>
						<label class="min-w-0 space-y-2">
							<span class="text-xs font-medium">Client or member</span>
							<select
								class="h-8 w-full rounded-none border border-input bg-transparent px-2 text-xs"
								value={selectedSubject}
								onchange={(event) =>
									(selectedSubject = (event.currentTarget as HTMLSelectElement).value)}
							>
								<option value="">Select access target</option>
								{#each subjectOptions as option (option.value)}
									<option value={option.value}>{option.label} - {option.description}</option>
								{/each}
							</select>
						</label>

						<label class="min-w-0 space-y-2">
							<span class="text-xs font-medium">Preset</span>
							<select
								class="h-8 w-full rounded-none border border-input bg-transparent px-2 text-xs"
								value={selectedPreset}
								onchange={(event) =>
									(selectedPreset = (event.currentTarget as HTMLSelectElement)
										.value as PermissionPresetKey)}
							>
								{#each presetEntries as [key, preset] (key)}
									<option value={key}>{preset.label}</option>
								{/each}
							</select>
						</label>

						<Button
							type="submit"
							disabled={saving || !selectedSubject || subjectOptions.length === 0}
							class="w-full self-end lg:w-fit"
						>
							{#if saving}
								<LoaderCircle class="size-4 animate-spin" strokeWidth={1.8} />
								Saving
							{:else}
								<KeyRound class="size-4" strokeWidth={1.8} />
								Grant access
							{/if}
						</Button>
					</form>

					{#if subjectOptions.length === 0}
						<div class="rounded-lg border bg-muted/20 p-4">
							<div class="flex min-w-0 gap-3">
								<span
									class="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground"
								>
									<UsersRound class="size-4" strokeWidth={1.8} />
								</span>
								<div class="min-w-0 space-y-1">
									<p class="text-sm font-medium">No clients available</p>
									<p class="text-sm text-muted-foreground">
										Create a client from the team page before granting project access.
									</p>
								</div>
							</div>
						</div>
					{/if}

					<div class="space-y-2">
						<h3 class="text-sm font-medium">Current grants</h3>
						{#if grants.length === 0}
							<p class="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
								No client access granted for this project.
							</p>
						{:else}
							<ul class="divide-y rounded-lg border">
								{#each grants as grant (grant.id)}
									<li class="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
										<div class="min-w-0 space-y-2">
											<div class="flex min-w-0 flex-wrap items-center gap-2">
												<ShieldCheck
													class="size-4 shrink-0 text-muted-foreground"
													strokeWidth={1.8}
												/>
												<p class="truncate text-sm font-medium">
													{subjectLabel(grant.subjectType, grant.subjectId)}
												</p>
												<Badge variant="outline" class="shrink-0">
													{presetLabelForPermissions(grant.permissions)}
												</Badge>
											</div>
											<div class="flex flex-wrap gap-1">
												{#each grant.permissions as permission (permission)}
													<Badge variant="secondary">{permissionLabel(permission)}</Badge>
												{/each}
											</div>
										</div>
										<Button
											variant="destructive"
											size="sm"
											disabled={removingSubject ===
												subjectValue(grant.subjectType, grant.subjectId)}
											onclick={() => void handleRemove(grant)}
											class="w-full lg:w-fit"
										>
											{#if removingSubject === subjectValue(grant.subjectType, grant.subjectId)}
												<LoaderCircle class="size-3.5 animate-spin" strokeWidth={1.8} />
												Removing
											{:else}
												<Trash2 class="size-3.5" strokeWidth={1.8} />
												Remove
											{/if}
										</Button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{:else}
					<div
						class="flex items-center gap-2 rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground"
					>
						<LoaderCircle class="size-4 animate-spin" strokeWidth={1.8} />
						Loading access
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	</section>
{/if}
