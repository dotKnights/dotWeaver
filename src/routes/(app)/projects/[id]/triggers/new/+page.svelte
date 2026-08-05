<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import TriggerForm from '$lib/components/triggers/TriggerForm.svelte';
	import { emptyTriggerFormValues } from '$lib/components/triggers/trigger-form';
	import type { CreateGithubTriggerInput } from '$lib/schemas/github-triggers';
	import { createGithubTrigger } from '$lib/rfc/github-triggers.remote';

	const projectId = $derived(page.params.id!);
	const listHref = $derived(`/projects/${projectId}/triggers`);

	let values = $state(emptyTriggerFormValues());
	let submitting = $state(false);
	let error = $state<string | null>(null);

	async function handleSubmit(payload: Omit<CreateGithubTriggerInput, 'projectId'>): Promise<void> {
		error = null;
		submitting = true;
		try {
			await createGithubTrigger({ ...payload, projectId });
			await goto(listHref);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to create trigger';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="mx-auto max-w-4xl space-y-6 bg-white p-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-semibold text-neutral-900">New trigger</h1>
		<a href={listHref} class="text-sm text-neutral-500 hover:underline">← Triggers</a>
	</div>

	<TriggerForm
		bind:values
		submitLabel="Save trigger"
		{submitting}
		{error}
		cancelHref={listHref}
		onsubmit={handleSubmit}
	/>
</div>
