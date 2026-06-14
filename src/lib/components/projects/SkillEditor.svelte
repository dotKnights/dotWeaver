<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import type { ProjectSkillInput } from '$lib/schemas/project-agent-config';
	import { Plus } from '@lucide/svelte';

	let {
		projectId,
		onSave
	}: {
		projectId: string;
		onSave: (input: ProjectSkillInput) => Promise<unknown>;
	} = $props();

	let name = $state('');
	let description = $state('');
	let body = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);

	const canSave = $derived(
		name.trim().length > 0 && description.trim().length > 0 && body.trim().length > 0
	);

	function reset() {
		name = '';
		description = '';
		body = '';
	}

	async function save() {
		if (!canSave || saving) return;
		error = null;
		saving = true;
		try {
			await onSave({
				projectId,
				name: name.trim(),
				description: description.trim(),
				body: body.trim(),
				enabled: true
			});
			reset();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save skill';
		} finally {
			saving = false;
		}
	}
</script>

<form
	class="grid gap-3"
	onsubmit={(event) => {
		event.preventDefault();
		void save();
	}}
>
	{#if error}
		<p class="text-sm break-words text-destructive" role="alert">{error}</p>
	{/if}

	<div class="grid gap-3 md:grid-cols-[12rem_1fr]">
		<div class="space-y-1">
			<Label for="skill-name">Name</Label>
			<Input id="skill-name" bind:value={name} placeholder="review" />
		</div>
		<div class="space-y-1">
			<Label for="skill-description">Description</Label>
			<Input id="skill-description" bind:value={description} placeholder="Review code changes" />
		</div>
	</div>

	<div class="space-y-1">
		<Label for="skill-body">SKILL.md</Label>
		<textarea
			id="skill-body"
			bind:value={body}
			rows="8"
			spellcheck="false"
			class="min-h-40 w-full rounded-none border border-input bg-transparent px-2.5 py-2 font-mono text-xs transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
		></textarea>
	</div>

	<div class="flex justify-end">
		<Button type="submit" disabled={!canSave || saving}>
			<Plus />
			{saving ? 'Saving' : 'Add skill'}
		</Button>
	</div>
</form>
