<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import type { ProjectSecretInput } from '$lib/schemas/project-agent-config';
	import { Save } from '@lucide/svelte';

	let {
		projectId,
		onSave
	}: {
		projectId: string;
		onSave: (input: ProjectSecretInput) => Promise<unknown>;
	} = $props();

	let name = $state('');
	let value = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);

	const canSave = $derived(name.trim().length > 0 && value.length > 0);

	function reset() {
		name = '';
		value = '';
	}

	async function save() {
		if (!canSave || saving) return;
		error = null;
		saving = true;
		try {
			await onSave({ projectId, name: name.trim(), value });
			reset();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save secret';
		} finally {
			saving = false;
		}
	}
</script>

<form
	class="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end"
	onsubmit={(event) => {
		event.preventDefault();
		void save();
	}}
>
	{#if error}
		<p class="text-sm break-words text-destructive md:col-span-3" role="alert">{error}</p>
	{/if}

	<div class="space-y-1">
		<Label for="secret-name">Name</Label>
		<Input id="secret-name" bind:value={name} placeholder="linear_api_key" />
	</div>
	<div class="space-y-1">
		<Label for="secret-value">Value</Label>
		<Input
			id="secret-value"
			bind:value
			type="password"
			autocomplete="off"
			placeholder="Stored encrypted"
		/>
	</div>
	<Button type="submit" disabled={!canSave || saving} class="w-full md:w-auto">
		<Save />
		{saving ? 'Saving' : 'Save secret'}
	</Button>
</form>
