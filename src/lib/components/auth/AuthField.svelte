<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';

	type Props = {
		id: string;
		name?: string;
		label: string;
		type?: string;
		placeholder?: string;
		error?: string | string[] | null;
		value?: string;
	};

	let {
		id,
		name = id,
		label,
		type = 'text',
		placeholder,
		error = null,
		value = $bindable('')
	}: Props = $props();

	const errorMessage = $derived(
		Array.isArray(error) ? error.filter(Boolean).join(', ') : (error ?? '')
	);
</script>

<div class="space-y-2">
	<Label for={id}>{label}</Label>
	<Input
		{id}
		{name}
		{type}
		{placeholder}
		bind:value
		aria-invalid={errorMessage ? 'true' : undefined}
	/>
	{#if errorMessage}
		<p class="text-sm text-destructive">{errorMessage}</p>
	{/if}
</div>
