<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import type { ProjectEnvironmentServiceKind } from '$lib/domain/project-environment-service';
	import {
		Database,
		LoaderCircle,
		Plus,
		RotateCcw,
		Save,
		ToggleLeft,
		ToggleRight,
		Trash2
	} from '@lucide/svelte';
	import type {
		EnvironmentServiceOutputSummary,
		EnvironmentServiceSourceFieldSummary,
		EnvironmentServiceSummary,
		PrepareEvent
	} from './environment-setup-state';
	import { eventLabel } from './environment-setup-state';

	type EditableMapping = {
		key: string;
		template: string;
		enabled: boolean;
		sensitive: 'auto' | boolean;
	};

	type Props = {
		projectId: string;
		profileId: string;
		services?: EnvironmentServiceSummary[];
		serviceEvents?: (serviceId: string) => PrepareEvent[];
		loading?: boolean;
		error?: string | null;
		onCreate: (input: {
			projectId: string;
			profileId: string;
			kind: ProjectEnvironmentServiceKind;
		}) => Promise<unknown>;
		onProvision: (input: {
			projectId: string;
			profileId: string;
			serviceId: string;
		}) => Promise<unknown>;
		onSetEnabled: (input: {
			projectId: string;
			profileId: string;
			serviceId: string;
			enabled: boolean;
		}) => Promise<unknown>;
		onUpdateEnvMappings: (input: {
			projectId: string;
			profileId: string;
			serviceId: string;
			envMappings: EditableMapping[];
		}) => Promise<unknown>;
	};

	let {
		projectId,
		profileId,
		services = [],
		serviceEvents = () => [],
		loading = false,
		error = null,
		onCreate,
		onProvision,
		onSetEnabled,
		onUpdateEnvMappings
	}: Props = $props();
	let busy = $state<string | null>(null);
	let actionError = $state<string | null>(null);
	let drafts = $state<Record<string, EditableMapping[]>>({});

	function serviceLabel(service: EnvironmentServiceSummary): string {
		return service.name ?? service.kind ?? 'service';
	}

	function outputsFor(service: EnvironmentServiceSummary): EnvironmentServiceOutputSummary[] {
		return Array.isArray(service.outputs)
			? service.outputs.filter(
					(output): output is EnvironmentServiceOutputSummary =>
						!!output && typeof output === 'object' && typeof output.key === 'string'
				)
			: [];
	}

	function sourceFieldsFor(
		service: EnvironmentServiceSummary
	): EnvironmentServiceSourceFieldSummary[] {
		return Array.isArray(service.sourceFields)
			? service.sourceFields.filter(
					(field): field is EnvironmentServiceSourceFieldSummary =>
						!!field && typeof field === 'object' && typeof field.key === 'string'
				)
			: [];
	}

	function sourceFieldValue(field: EnvironmentServiceSourceFieldSummary): string {
		if (field.sensitive) return 'masked';
		if (typeof field.value === 'string' && field.value.length > 0) return field.value;
		return field.hasValue ? 'set' : 'missing';
	}

	function messagesFor(value: unknown): string[] {
		if (!Array.isArray(value)) return [];
		return value.filter(
			(message): message is string => typeof message === 'string' && message.length > 0
		);
	}

	function eventLinesFor(service: EnvironmentServiceSummary): Array<PrepareEvent & { label: string }> {
		if (!service.id) return [];
		return serviceEvents(service.id)
			.map((event) => ({ ...event, label: eventLabel(event) }))
			.filter((event) => event.label.length > 0);
	}

	function serviceMappingsFor(service: EnvironmentServiceSummary): EditableMapping[] {
		if (!Array.isArray(service.envMappings)) return [];
		return service.envMappings
			.filter(
				(mapping): mapping is EditableMapping =>
					!!mapping &&
					typeof mapping === 'object' &&
					typeof mapping.key === 'string' &&
					typeof mapping.template === 'string'
			)
			.map((mapping) => ({
				key: mapping.key,
				template: mapping.template,
				enabled: mapping.enabled !== false,
				sensitive:
					mapping.sensitive === true || mapping.sensitive === false ? mapping.sensitive : 'auto'
			}));
	}

	function mappingsFor(service: EnvironmentServiceSummary): EditableMapping[] {
		if (service.id && drafts[service.id]) return drafts[service.id];
		return serviceMappingsFor(service);
	}

	function mappingEquals(left: EditableMapping, right: EditableMapping): boolean {
		return (
			left.key === right.key &&
			left.template === right.template &&
			left.enabled === right.enabled &&
			left.sensitive === right.sensitive
		);
	}

	function mappingsEqual(left: EditableMapping[], right: EditableMapping[]): boolean {
		return (
			left.length === right.length &&
			left.every((mapping, index) => mappingEquals(mapping, right[index]))
		);
	}

	function setMappings(serviceId: string, mappings: EditableMapping[]) {
		drafts = { ...drafts, [serviceId]: mappings };
	}

	function addMapping(service: EnvironmentServiceSummary) {
		if (!service.id) return;
		setMappings(service.id, [
			...mappingsFor(service),
			{ key: '', template: '', enabled: true, sensitive: 'auto' }
		]);
	}

	function updateMapping(
		service: EnvironmentServiceSummary,
		index: number,
		patch: Partial<EditableMapping>
	) {
		if (!service.id) return;
		setMappings(
			service.id,
			mappingsFor(service).map((mapping, mappingIndex) =>
				mappingIndex === index ? { ...mapping, ...patch } : mapping
			)
		);
	}

	function deleteMapping(service: EnvironmentServiceSummary, index: number) {
		if (!service.id) return;
		setMappings(
			service.id,
			mappingsFor(service).filter((_, mappingIndex) => mappingIndex !== index)
		);
	}

	function sensitiveModeValue(mapping: EditableMapping): 'auto' | 'true' | 'false' {
		if (mapping.sensitive === true) return 'true';
		if (mapping.sensitive === false) return 'false';
		return 'auto';
	}

	function sensitiveModeLabel(value: 'auto' | 'true' | 'false'): string {
		if (value === 'true') return 'Sensitive';
		if (value === 'false') return 'Not sensitive';
		return 'Auto sensitivity';
	}

	function updateMappingSensitive(
		service: EnvironmentServiceSummary,
		index: number,
		value: string | undefined
	) {
		updateMapping(service, index, {
			sensitive: value === 'true' ? true : value === 'false' ? false : 'auto'
		});
	}

	async function saveMappings(service: EnvironmentServiceSummary) {
		if (!service.id) return;
		const serviceId = service.id;
		await runAction(`mappings-${serviceId}`, async () => {
			await onUpdateEnvMappings({
				projectId,
				profileId,
				serviceId,
				envMappings: mappingsFor(service)
			});
		});
	}

	function outputValue(output: EnvironmentServiceOutputSummary): string {
		if (output.sensitive) return 'masked';
		return output.value ?? '';
	}

	function statusVariant(status: string | null | undefined) {
		if (status === 'failed') return 'destructive';
		if (status === 'ready') return 'secondary';
		return 'outline';
	}

	async function runAction(key: string, action: () => Promise<unknown>) {
		if (busy) return;
		busy = key;
		actionError = null;
		try {
			await action();
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Service action failed';
		} finally {
			busy = null;
		}
	}

	$effect(() => {
		let nextDrafts = drafts;
		for (const service of services) {
			if (!service.id || !drafts[service.id]) continue;
			if (!mappingsEqual(drafts[service.id], serviceMappingsFor(service))) continue;
			if (nextDrafts === drafts) nextDrafts = { ...drafts };
			delete nextDrafts[service.id];
		}
		if (nextDrafts !== drafts) drafts = nextDrafts;
	});
</script>

<Card.Root size="sm">
	<Card.Header class="border-b border-border">
		<div class="flex items-start justify-between gap-3">
			<div class="min-w-0 space-y-1">
				<Card.Title>Services</Card.Title>
				<Card.Description>
					Persistent services are injected into prepared project environments.
				</Card.Description>
			</div>
			<Card.Action>
				<Database class="size-4 text-muted-foreground" />
			</Card.Action>
		</div>
	</Card.Header>
	<Card.Content class="space-y-3">
		{#if actionError}
			<p class="text-sm break-words text-destructive" role="alert">{actionError}</p>
		{/if}

		<div class="flex flex-wrap gap-2">
			<Button
				variant="outline"
				size="sm"
				disabled={!profileId || !!busy || loading || !!error}
				onclick={() =>
					void runAction('create-postgres', () =>
						onCreate({ projectId, profileId, kind: 'postgres' })
					)}
			>
				{#if busy === 'create-postgres'}
					<LoaderCircle class="animate-spin" />
				{:else}
					<Plus />
				{/if}
				Add Postgres
			</Button>
			<Button
				variant="outline"
				size="sm"
				disabled={!profileId || !!busy || loading || !!error}
				onclick={() =>
					void runAction('create-redis', () => onCreate({ projectId, profileId, kind: 'redis' }))}
			>
				{#if busy === 'create-redis'}
					<LoaderCircle class="animate-spin" />
				{:else}
					<Plus />
				{/if}
				Add Redis
			</Button>
		</div>

		{#if error}
			<p class="text-sm break-words text-destructive" role="alert">{error}</p>
		{:else if loading}
			<p class="text-sm text-muted-foreground">Loading services...</p>
		{:else if services.length === 0}
			<p class="text-sm text-muted-foreground">No services configured.</p>
		{:else}
			<div class="space-y-2">
				{#each services as service (service.id ?? service.name ?? service.kind)}
					{@const mappings = mappingsFor(service)}
					{@const sourceFields = sourceFieldsFor(service)}
					{@const mappingWarnings = messagesFor(service.mappingWarnings)}
					{@const mappingErrors = messagesFor(service.mappingErrors)}
					{@const serviceEventLines = eventLinesFor(service)}
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
								onclick={() =>
									service.id &&
									void runAction(`provision-${service.id}`, () =>
										onProvision({ projectId, profileId, serviceId: service.id! })
									)}
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
								onclick={() =>
									service.id &&
									void runAction(`enabled-${service.id}`, () =>
										onSetEnabled({
											projectId,
											profileId,
											serviceId: service.id!,
											enabled: service.enabled === false
										})
									)}
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

						{#if outputsFor(service).length > 0}
							<ul class="mt-3 space-y-1 text-xs text-muted-foreground">
								{#each outputsFor(service) as output (output.key)}
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
									onclick={() => addMapping(service)}
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
												<span class="font-medium text-foreground"
													>{mapping.key || 'New variable'}</span
												>
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
														updateMapping(service, index, {
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
														updateMapping(service, index, {
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
													onValueChange={(value) => updateMappingSensitive(service, index, value)}
												>
													<Select.Trigger
														aria-label={`Sensitivity ${index + 1}`}
														class="w-full"
														size="sm"
													>
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
												onclick={() => deleteMapping(service, index)}
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
														updateMapping(service, index, {
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
									onclick={() => void saveMappings(service)}
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
				{/each}
			</div>
		{/if}
	</Card.Content>
</Card.Root>
