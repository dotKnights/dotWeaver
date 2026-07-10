<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import type { ProjectEnvironmentServiceKind } from '$lib/domain/project-environment-service';
	import { Database, LoaderCircle, Plus } from '@lucide/svelte';
	import type { EnvironmentServiceSummary, PrepareEvent } from './environment-setup-state';
	import ProjectEnvironmentServiceCard from './ProjectEnvironmentServiceCard.svelte';
	import {
		eventLinesFor,
		mappingsFor as currentMappingsFor,
		sensitiveValueFromMode,
		type EditableMapping
	} from './project-environment-services-panel';

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

	function mappingsFor(service: EnvironmentServiceSummary): EditableMapping[] {
		return currentMappingsFor(service, drafts);
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

	function updateMappingSensitive(
		service: EnvironmentServiceSummary,
		index: number,
		value: string | undefined
	) {
		updateMapping(service, index, {
			sensitive: sensitiveValueFromMode(value)
		});
	}

	async function saveMappings(service: EnvironmentServiceSummary) {
		if (!service.id) return;
		const serviceId = service.id;
		const nextMappings = mappingsFor(service);
		await runAction(`mappings-${serviceId}`, async () => {
			await onUpdateEnvMappings({
				projectId,
				profileId,
				serviceId,
				envMappings: nextMappings
			});
		});
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
					{@const serviceEventLines = eventLinesFor(service, serviceEvents)}
					<ProjectEnvironmentServiceCard
						{service}
						{mappings}
						{serviceEventLines}
						{busy}
						{loading}
						onProvision={(selectedService) =>
							selectedService.id &&
							void runAction(`provision-${selectedService.id}`, () =>
								onProvision({
									projectId,
									profileId,
									serviceId: selectedService.id!
								})
							)}
						onToggleEnabled={(selectedService) =>
							selectedService.id &&
							void runAction(`enabled-${selectedService.id}`, () =>
								onSetEnabled({
									projectId,
									profileId,
									serviceId: selectedService.id!,
									enabled: selectedService.enabled === false
								})
							)}
						onAddMapping={addMapping}
						onUpdateMapping={updateMapping}
						onUpdateMappingSensitive={updateMappingSensitive}
						onDeleteMapping={deleteMapping}
						onSaveMappings={(selectedService) => void saveMappings(selectedService)}
					/>
				{/each}
			</div>
		{/if}
	</Card.Content>
</Card.Root>
