<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import type { ProjectEnvVarInput } from '$lib/schemas/project-agent-config';
	import { Eye, EyeOff, Lock, LockOpen, Power, PowerOff, Trash2 } from '@lucide/svelte';
	import EnvVarEditor from './EnvVarEditor.svelte';
	import { envVarDisplayValue, type AgentConfig, type RevealedEnvVars } from './agent-config-panel';

	type EnvVar = AgentConfig['envVars'][number];

	type Props = {
		projectId: string;
		envVars: EnvVar[];
		canManage?: boolean;
		actionsDisabled?: boolean;
		revealedEnvVars?: RevealedEnvVars;
		onDeleteEnvVar: (envVar: EnvVar) => void;
		onToggleEnvVar: (envVar: EnvVar) => void;
		onToggleEnvVarSensitive: (envVar: EnvVar) => void;
		onRevealEnvVar: (envVar: EnvVar) => void;
		onImportEnv: (content: string) => Promise<unknown>;
		onSaveEnvVar: (input: ProjectEnvVarInput) => Promise<unknown>;
	};

	let {
		projectId,
		envVars,
		canManage = true,
		actionsDisabled = false,
		revealedEnvVars = {},
		onDeleteEnvVar,
		onToggleEnvVar,
		onToggleEnvVarSensitive,
		onRevealEnvVar,
		onImportEnv,
		onSaveEnvVar
	}: Props = $props();

	let envImportText = $state('');

	async function importEnv() {
		const content = envImportText.trim();
		if (content.length === 0) return;
		await onImportEnv(content);
		envImportText = '';
	}
</script>

<Card.Root size="sm">
	<Card.Header>
		<Card.Title>Environment (.env)</Card.Title>
		<Card.Description>{envVars.length} configured</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		{#if envVars.length === 0}
			<p class="text-sm text-muted-foreground">No environment variables.</p>
		{:else}
			<ul class="divide-y divide-border border-y border-border">
				{#each envVars as envVar (envVar.id)}
					<li class="grid gap-2 py-2 text-sm md:grid-cols-[1fr_auto] md:items-center">
						<div class="min-w-0">
							<p class="truncate font-medium">{envVar.key}</p>
							<p class="truncate text-xs text-muted-foreground">
								{envVarDisplayValue(envVar, revealedEnvVars)}
							</p>
						</div>
						{#if canManage}
							<div class="flex gap-2">
								{#if envVar.sensitive}
									<Button
										variant="ghost"
										size="sm"
										aria-label={revealedEnvVars[envVar.id] !== undefined
											? 'Hide value'
											: 'Reveal value'}
										disabled={actionsDisabled}
										onclick={() => onRevealEnvVar(envVar)}
									>
										{#if revealedEnvVars[envVar.id] !== undefined}<EyeOff />{:else}<Eye />{/if}
									</Button>
								{/if}
								<Button
									variant="ghost"
									size="sm"
									aria-label={envVar.sensitive ? 'Mark as not sensitive' : 'Mark as sensitive'}
									disabled={actionsDisabled}
									onclick={() => onToggleEnvVarSensitive(envVar)}
								>
									{#if envVar.sensitive}<Lock />{:else}<LockOpen />{/if}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									aria-label={envVar.enabled ? 'Disable' : 'Enable'}
									disabled={actionsDisabled}
									onclick={() => onToggleEnvVar(envVar)}
								>
									{#if envVar.enabled}<Power />{:else}<PowerOff />{/if}
								</Button>
								<Button
									variant="destructive"
									size="sm"
									disabled={actionsDisabled}
									onclick={() => onDeleteEnvVar(envVar)}
								>
									<Trash2 />
									Delete
								</Button>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if canManage}
			<EnvVarEditor {projectId} onSave={onSaveEnvVar} />
			<div class="space-y-2">
				<label for="env-import" class="text-sm font-medium">Import a .env</label>
				<textarea
					id="env-import"
					class="min-h-24 w-full border border-border bg-background p-2 font-mono text-xs"
					bind:value={envImportText}
					placeholder="NODE_ENV=production
API_KEY=..."
				></textarea>
				<Button size="sm" disabled={actionsDisabled} onclick={() => void importEnv()}>Import</Button
				>
			</div>
		{/if}
	</Card.Content>
</Card.Root>
