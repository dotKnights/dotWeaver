<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import TriggerForm from '$lib/components/triggers/TriggerForm.svelte';
	import {
		emptyTriggerFormValues,
		triggerToFormValues
	} from '$lib/components/triggers/trigger-form';
	import type { CreateGithubTriggerInput } from '$lib/schemas/github-triggers';
	import { getGithubTrigger, updateGithubTrigger } from '$lib/rfc/github-triggers.remote';

	const projectId = $derived(page.params.id!);
	const triggerId = $derived(page.params.triggerId!);
	const listHref = $derived(`/projects/${projectId}/triggers`);
	const trigger = $derived(getGithubTrigger({ triggerId }));

	let values = $state(emptyTriggerFormValues());
	let loadedTriggerId = $state<string | null>(null);
	let submitting = $state(false);
	let error = $state<string | null>(null);

	// Hydrate le formulaire une seule fois par trigger : un refresh de la query ne doit pas
	// écraser les modifications en cours de saisie.
	$effect(() => {
		const loaded = trigger.current;
		if (!loaded || loadedTriggerId === loaded.id) return;
		values = triggerToFormValues(loaded);
		loadedTriggerId = loaded.id;
	});

	async function handleSubmit(payload: Omit<CreateGithubTriggerInput, 'projectId'>): Promise<void> {
		error = null;
		submitting = true;
		try {
			await updateGithubTrigger({ ...payload, triggerId });
			await goto(listHref);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to update trigger';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="mx-auto max-w-4xl space-y-6 bg-white p-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-semibold text-neutral-900">Edit trigger</h1>
		<a href={listHref} class="text-sm text-neutral-500 hover:underline">← Triggers</a>
	</div>

	{#if trigger.error}
		<p class="text-sm text-red-600">{trigger.error.message}</p>
	{:else if loadedTriggerId}
		<TriggerForm
			bind:values
			submitLabel="Update trigger"
			{submitting}
			{error}
			cancelHref={listHref}
			onsubmit={handleSubmit}
		/>
	{:else}
		<p class="text-sm text-neutral-500">Loading trigger…</p>
	{/if}
</div>
