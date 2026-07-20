<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import {
		LoaderCircle,
		Plus,
		RotateCcw,
		Save,
		ToggleLeft,
		ToggleRight,
		Trash2
	} from '@lucide/svelte';
	import type { EnvironmentServiceSummary, PrepareEvent } from './environment-setup-state';
	import {
		messagesFor,
		outputsFor,
		outputValue,
		sensitiveModeLabel,
		sensitiveModeValue,
		serviceLabel,
		sourceFieldsFor,
		sourceFieldValue,
		statusVariant,
		type EditableMapping
	} from './project-environment-services-panel';

	type Props = {
		service: EnvironmentServiceSummary;
		mappings: EditableMapping[];
		serviceEventLines: Array<PrepareEvent & { label: string }>;
		busy?: string | null;
		loading?: boolean;
		onProvision: (service: EnvironmentServiceSummary) => void;
		onToggleEnabled: (service: EnvironmentServiceSummary) => void;
		onAddMapping: (service: EnvironmentServiceSummary) => void;
		onUpdateMapping: (
			service: EnvironmentServiceSummary,
			index: number,
			patch: Partial<EditableMapping>
		) => void;
		onUpdateMappingSensitive: (
			service: EnvironmentServiceSummary,
			index: number,
			value: string | undefined
		) => void;
		onDeleteMapping: (service: EnvironmentServiceSummary, index: number) => void;
		onSaveMappings: (service: EnvironmentServiceSummary) => void;
	};

	let {
		service,
		mappings,
		serviceEventLines,
		busy = null,
		loading = false,
		onProvision,
		onToggleEnabled,
		onAddMapping,
		onUpdateMapping,
		onUpdateMappingSensitive,
		onDeleteMapping,
		onSaveMappings
	}: Props = $props();

	const serviceOutputs = $derived(outputsFor(service));
	const sourceFields = $derived(sourceFieldsFor(service));
	const mappingWarnings = $derived(messagesFor(service.mappingWarnings));
	const mappingErrors = $derived(messagesFor(service.mappingErrors));
</script>

<div class="rounded-md border border-border p-3">
	<div class="flex items-start justify-between gap-3">
		<div class="min-w-0">
			<p class="truncate text-sm font-medium">{serviceLabel(service)}</p>
			<p class="text-xs text-muted-foreground">{service.kind ?? 'custom'}</p>
		</div>
		<Badge variant={statusVariant(service.status)}>{service.status ?? 'unknown'}</Badge>
	</div>

	<div class="mt-3 flex flex-wrap gap-2">
		<Button
			size="sm"
			variant="outline"
			disabled={!service.id || !!busy || service.enabled === false}
			onclick={() => onProvision(service)}
		>
			{#if busy === `provision-${service.id}`}
				<LoaderCircle class="animate-spin" />
			{:else}
				<RotateCcw />
			{/if}
			Provision
		</Button>
		<Button
			size="sm"
			variant="outline"
			disabled={!service.id || !!busy}
			onclick={() => onToggleEnabled(service)}
		>
			{#if busy === `enabled-${service.id}`}
				<LoaderCircle class="animate-spin" />
			{:else if service.enabled === false}
				<ToggleLeft />
			{:else}
				<ToggleRight />
			{/if}
			{service.enabled === false ? 'Enable' : 'Disable'}
		</Button>
	</div>

	{#if serviceEventLines.length > 0}
		<div class="mt-3 space-y-1 text-xs text-muted-foreground">
			<p>Service log</p>
			<ul class="space-y-1">
				{#each serviceEventLines as event, index (`${event.id ?? event.seq ?? index}-${event.label}`)}
					<li class="grid grid-cols-[auto_1fr] gap-2">
						<span class="uppercase">{event.type ?? 'event'}</span>
						<span class="break-words">{event.label}</span>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if serviceOutputs.length > 0}
		<ul class="mt-3 space-y-1 text-xs text-muted-foreground">
			{#each serviceOutputs as output (output.key)}
				<li class="flex flex-wrap gap-x-1">
					<span>{output.key}</span>
					<span aria-hidden="true">:</span>
					<span>{outputValue(output)}</span>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="mt-3 space-y-3 border-t border-border pt-3">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<p class="text-sm font-medium">Environment variables</p>
			<Button
				size="xs"
				variant="outline"
				disabled={!service.id || !!busy || loading}
				onclick={() => onAddMapping(service)}
			>
				<Plus />
				Add variable
			</Button>
		</div>

		{#if mappings.length === 0}
			<p class="text-xs text-muted-foreground">No variables mapped.</p>
		{:else}
			<div class="space-y-2">
				{#each mappings as mapping, index (index)}
					<div
						class="grid gap-2 rounded-sm border border-border/60 p-2 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,0.6fr)_auto] md:items-end"
					>
						<p class="text-xs break-words text-muted-foreground md:col-span-4">
							<span class="font-medium text-foreground">{mapping.key || 'New variable'}</span>
							<span> maps to </span>
							<code>{mapping.template || 'empty template'}</code>
						</p>
						<label class="grid min-w-0 gap-1 text-xs font-medium text-muted-foreground">
							<span>Variable name</span>
							<Input
								aria-label={`Variable name ${index + 1}`}
								value={mapping.key}
								disabled={!!busy}
								oninput={(event) =>
									onUpdateMapping(service, index, {
										key: (event.currentTarget as HTMLInputElement).value
									})}
							/>
						</label>
						<label class="grid min-w-0 gap-1 text-xs font-medium text-muted-foreground">
							<span>Template</span>
							<Input
								aria-label={`Template ${index + 1}`}
								value={mapping.template}
								disabled={!!busy}
								oninput={(event) =>
									onUpdateMapping(service, index, {
										template: (event.currentTarget as HTMLInputElement).value
									})}
							/>
						</label>
						<label class="grid min-w-0 gap-1 text-xs font-medium text-muted-foreground">
							<span>Sensitivity</span>
							<Select.Root
								type="single"
								value={sensitiveModeValue(mapping)}
								disabled={!!busy}
								onValueChange={(value) => onUpdateMappingSensitive(service, index, value)}
							>
								<Select.Trigger aria-label={`Sensitivity ${index + 1}`} class="w-full" size="sm">
									{sensitiveModeLabel(sensitiveModeValue(mapping))}
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="auto" label="Auto sensitivity" />
									<Select.Item value="true" label="Sensitive" />
									<Select.Item value="false" label="Not sensitive" />
								</Select.Content>
							</Select.Root>
						</label>
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label={`Delete variable ${mapping.key || index + 1}`}
							disabled={!!busy}
							onclick={() => onDeleteMapping(service, index)}
						>
							<Trash2 />
						</Button>
						<label
							class="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground md:col-span-4"
						>
							<input
								type="checkbox"
								checked={mapping.enabled}
								disabled={!!busy}
								onchange={(event) =>
									onUpdateMapping(service, index, {
										enabled: (event.currentTarget as HTMLInputElement).checked
									})}
							/>
							Enabled
						</label>
					</div>
				{/each}
			</div>
		{/if}

		{#if sourceFields.length > 0}
			<div class="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
				<span>Sources</span>
				{#each sourceFields as field (field.key)}
					<Badge variant="outline">
						{field.key}: {sourceFieldValue(field)}
					</Badge>
				{/each}
			</div>
		{/if}

		{#each mappingWarnings as warning, warningIndex (`warning-${warningIndex}`)}
			<p class="text-xs break-words text-amber-700 dark:text-amber-300">{warning}</p>
		{/each}

		{#each mappingErrors as error, errorIndex (`error-${errorIndex}`)}
			<p class="text-xs break-words text-destructive" role="alert">{error}</p>
		{/each}

		<div class="flex justify-end">
			<Button
				size="sm"
				disabled={!service.id || !!busy || loading}
				onclick={() => onSaveMappings(service)}
			>
				{#if busy === `mappings-${service.id}`}
					<LoaderCircle class="animate-spin" />
				{:else}
					<Save />
				{/if}
				Save variables
			</Button>
		</div>
	</div>

	{#if service.lastError}
		<p class="mt-3 text-xs break-words text-destructive">{service.lastError}</p>
	{/if}
</div>
