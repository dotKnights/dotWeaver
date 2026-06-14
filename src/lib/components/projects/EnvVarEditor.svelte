<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import type { ProjectEnvVarInput } from '$lib/schemas/project-agent-config';
	import { Save } from '@lucide/svelte';

	let {
		projectId,
		onSave
	}: {
		projectId: string;
		onSave: (input: ProjectEnvVarInput) => Promise<unknown>;
	} = $props();

	let key = $state('');
	let value = $state('');
	let sensitive = $state(true);
	let saving = $state(false);
	let error = $state<string | null>(null);

	const canSave = $derived(key.trim().length > 0 && value.length > 0);

	function reset() {
		key = '';
		value = '';
		sensitive = true;
	}

	async function save() {
		if (!canSave || saving) return;
		error = null;
		saving = true;
		try {
			await onSave({ projectId, key: key.trim(), value, sensitive });
			reset();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save variable';
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
		<Label for="envvar-key">Key</Label>
		<Input id="envvar-key" bind:value={key} placeholder="DATABASE_URL" />
	</div>
	<div class="space-y-1">
		<Label for="envvar-value">Value</Label>
		<Input
			id="envvar-value"
			type={sensitive ? 'password' : 'text'}
			bind:value
			placeholder="value"
		/>
	</div>
	<Button type="submit" disabled={!canSave || saving} class="w-full md:w-auto">
		<Save />
		{saving ? 'Saving' : 'Save'}
	</Button>
	<label class="flex items-center gap-2 text-sm md:col-span-3">
		<input type="checkbox" bind:checked={sensitive} />
		Sensitive (mask value)
	</label>
</form>
