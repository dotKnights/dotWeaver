<script lang="ts">
	import type { GithubTrigger } from '@prisma/client';
	import { page } from '$app/state';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { describeTriggerConditions } from '$lib/components/triggers/trigger-form';
	import {
		createGithubTrigger,
		deleteGithubTrigger,
		listGithubTriggers,
		toggleGithubTrigger
	} from '$lib/rfc/github-triggers.remote';
	import { getProjectCapabilities } from '$lib/rfc/projects.remote';

	const projectId = $derived(page.params.id!);
	const triggers = $derived(listGithubTriggers(projectId));
	const capabilities = $derived(getProjectCapabilities(projectId));
	const canManage = $derived(capabilities.current?.['project.config.manage'] ?? false);

	let actionError = $state<string | null>(null);
	let pendingTriggerId = $state<string | null>(null);
	let triggerToDelete = $state<GithubTrigger | null>(null);
	/** Etats optimistes du toggle, réconciliés par le refresh de la query. */
	let optimisticEnabled = $state<Record<string, boolean>>({});

	function isEnabled(trigger: GithubTrigger): boolean {
		return optimisticEnabled[trigger.id] ?? trigger.enabled;
	}

	async function handleToggle(trigger: GithubTrigger): Promise<void> {
		const next = !isEnabled(trigger);
		actionError = null;
		optimisticEnabled = { ...optimisticEnabled, [trigger.id]: next };
		try {
			await toggleGithubTrigger({ triggerId: trigger.id, enabled: next });
		} catch (e) {
			// Retour à l'état serveur : l'optimisme ne doit pas masquer un refus.
			optimisticEnabled = { ...optimisticEnabled, [trigger.id]: !next };
			actionError = e instanceof Error ? e.message : 'Failed to update trigger';
		}
	}

	async function handleDuplicate(trigger: GithubTrigger): Promise<void> {
		actionError = null;
		pendingTriggerId = trigger.id;
		try {
			await createGithubTrigger({
				projectId,
				name: `${trigger.name} (copy)`.slice(0, 120),
				description: trigger.description ?? undefined,
				enabled: false,
				conditions:
					trigger.eventType === 'ISSUES_OPENED'
						? { eventType: 'ISSUES_OPENED', labelFilter: trigger.labelFilter ?? '' }
						: trigger.eventType === 'ISSUE_COMMENT_CREATED'
							? {
									eventType: 'ISSUE_COMMENT_CREATED',
									labelFilter: trigger.labelFilter ?? '',
									commentKeyword: trigger.commentKeyword ?? undefined
								}
							: {
									eventType: 'PULL_REQUEST_REVIEW_SUBMITTED',
									baseBranchPattern: trigger.baseBranchPattern ?? undefined
								},
				runTemplate: {
					agent: trigger.agent === 'codex' ? 'codex' : 'claude',
					model: trigger.model,
					runBaseBranch: trigger.runBaseBranch,
					promptTemplate: trigger.promptTemplate
				}
			});
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Failed to duplicate trigger';
		} finally {
			pendingTriggerId = null;
		}
	}

	async function handleDelete(): Promise<void> {
		if (!triggerToDelete) return;
		const target = triggerToDelete;
		actionError = null;
		pendingTriggerId = target.id;
		try {
			await deleteGithubTrigger({ triggerId: target.id });
			triggerToDelete = null;
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Failed to delete trigger';
		} finally {
			pendingTriggerId = null;
		}
	}
</script>

<div class="mx-auto max-w-4xl space-y-6 bg-white p-6">
	<div class="flex items-start justify-between gap-4">
		<div class="space-y-1">
			<h1 class="text-2xl font-semibold text-neutral-900">GitHub Triggers</h1>
			<p class="text-sm text-neutral-500">
				Automatically start agent runs when GitHub events occur on this project.
			</p>
		</div>
		<div class="flex shrink-0 items-center gap-3">
			<a href={`/projects/${projectId}`} class="text-sm text-neutral-500 hover:underline">
				← Project
			</a>
			{#if canManage}
				<Button
					href={`/projects/${projectId}/triggers/new`}
					class="bg-[#2A34F5] text-white hover:bg-[#2A34F5]/90"
				>
					Add trigger
				</Button>
			{/if}
		</div>
	</div>

	{#if actionError}
		<p class="border border-red-200 bg-red-50 p-3 text-sm text-red-700">{actionError}</p>
	{/if}

	{#if triggers.error}
		<p class="text-sm text-red-600">{triggers.error.message}</p>
	{:else if triggers.current}
		{#if triggers.current.length === 0}
			<div class="border border-dashed border-neutral-300 bg-white p-10 text-center">
				<p class="text-sm font-medium text-neutral-900">No triggers yet.</p>
				<p class="mt-1 text-sm text-neutral-500">
					Add one to start automating your workflow.
				</p>
				{#if canManage}
					<Button
						href={`/projects/${projectId}/triggers/new`}
						class="mt-4 bg-[#2A34F5] text-white hover:bg-[#2A34F5]/90"
					>
						Add trigger
					</Button>
				{/if}
			</div>
		{:else}
			<ul class="space-y-3">
				{#each triggers.current as trigger (trigger.id)}
					<li class="border border-neutral-200 bg-white p-4">
						<div class="flex items-start justify-between gap-4">
							<div class="flex min-w-0 items-start gap-3">
								<button
									type="button"
									role="switch"
									aria-checked={isEnabled(trigger)}
									aria-label={`${isEnabled(trigger) ? 'Disable' : 'Enable'} ${trigger.name}`}
									disabled={!canManage}
									onclick={() => handleToggle(trigger)}
									class={`mt-1 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
										isEnabled(trigger) ? 'bg-[#2A34F5]' : 'bg-neutral-300'
									}`}
								>
									<span
										class={`h-4 w-4 rounded-full bg-white transition-transform ${
											isEnabled(trigger) ? 'translate-x-4' : 'translate-x-0.5'
										}`}
									></span>
								</button>
								<div class="min-w-0 space-y-1">
									<div class="flex items-center gap-2">
										<h2 class="truncate font-medium text-neutral-900">{trigger.name}</h2>
										{#if !isEnabled(trigger)}
											<Badge variant="outline">Disabled</Badge>
										{/if}
									</div>
									<p class="text-sm text-neutral-500">{describeTriggerConditions(trigger)}</p>
									<p class="text-xs text-neutral-500">
										Agent: {trigger.agent === 'codex' ? 'Codex' : 'Claude'} · Model:
										{trigger.model} · Branch: {trigger.runBaseBranch}
									</p>
								</div>
							</div>
							{#if canManage}
								<div class="flex shrink-0 items-center gap-2">
									<Button variant="outline" href={`/projects/${projectId}/triggers/${trigger.id}`}>
										Edit
									</Button>
									<Button
										variant="ghost"
										disabled={pendingTriggerId === trigger.id}
										onclick={() => handleDuplicate(trigger)}
									>
										Duplicate
									</Button>
									<Button
										variant="ghost"
										class="text-red-600 hover:text-red-700"
										disabled={pendingTriggerId === trigger.id}
										onclick={() => (triggerToDelete = trigger)}
									>
										Delete
									</Button>
								</div>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	{:else}
		<p class="text-sm text-neutral-500">Loading triggers…</p>
	{/if}
</div>

<AlertDialog.Root
	open={triggerToDelete !== null}
	onOpenChange={(open) => {
		if (!open) triggerToDelete = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete this trigger?</AlertDialog.Title>
			<AlertDialog.Description>
				“{triggerToDelete?.name}” will stop creating runs. Runs it already created are kept.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				class="bg-red-600 text-white hover:bg-red-700"
				disabled={pendingTriggerId !== null}
				onclick={handleDelete}
			>
				Delete
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
