<script lang="ts">
	import type {
		ProjectEnvVar,
		ProjectMcpServer,
		ProjectSecret,
		ProjectSkill
	} from '@prisma/client';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import {
		deleteProjectEnvVar,
		deleteProjectMcpServer,
		deleteProjectSecret,
		deleteProjectSkill,
		importProjectEnvFile,
		revealProjectEnvVar,
		setProjectEnvVarEnabled,
		setProjectEnvVarSensitive,
		setProjectMcpServerEnabled,
		setProjectSkillEnabled,
		upsertProjectEnvVar,
		upsertProjectMcpServer,
		upsertProjectSecret,
		upsertProjectSkill
	} from '$lib/rfc/project-agent-config.remote';
	import {
		BookOpen,
		Eye,
		EyeOff,
		FileCog,
		KeyRound,
		Lock,
		LockOpen,
		Power,
		PowerOff,
		Server,
		Trash2
	} from '@lucide/svelte';
	import EnvVarEditor from './EnvVarEditor.svelte';
	import McpServerEditor from './McpServerEditor.svelte';
	import SecretEditor from './SecretEditor.svelte';
	import SkillEditor from './SkillEditor.svelte';
	import SkillsShCatalog from './SkillsShCatalog.svelte';

	type AgentConfig = {
		mcpServers: Array<Pick<ProjectMcpServer, 'id' | 'name' | 'transport' | 'enabled'>>;
		skills: Array<
			Pick<
				ProjectSkill,
				| 'id'
				| 'name'
				| 'description'
				| 'enabled'
				| 'sourceProvider'
				| 'sourceSkillId'
				| 'sourceHash'
			>
		>;
		secrets: Array<Pick<ProjectSecret, 'id' | 'name'> & { hasValue: boolean }>;
		envVars: Array<
			Pick<ProjectEnvVar, 'id' | 'key' | 'enabled' | 'sensitive'> & { value: string | null }
		>;
	};
	type Section = 'mcp' | 'skills' | 'secrets' | 'env';

	let { projectId, config }: { projectId: string; config: AgentConfig } = $props();

	let section = $state<Section>('mcp');
	let actionError = $state<string | null>(null);
	let busyKey = $state<string | null>(null);
	const actionsDisabled = $derived(busyKey !== null);

	async function runAction(key: string, action: () => Promise<unknown>) {
		if (busyKey) return;
		actionError = null;
		busyKey = key;
		try {
			await action();
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Action failed';
		} finally {
			busyKey = null;
		}
	}

	async function deleteSecret(secret: AgentConfig['secrets'][number]) {
		if (!confirm(`Delete secret ${secret.name}? Runs using it will fail until it is replaced.`)) {
			return;
		}
		await runAction(`secret-delete-${secret.id}`, () =>
			deleteProjectSecret({ projectId, id: secret.id })
		);
	}

	async function deleteEnvVar(envVar: AgentConfig['envVars'][number]) {
		if (!confirm(`Delete ${envVar.key}? Runs will no longer receive it.`)) return;
		await runAction(`env-delete-${envVar.id}`, () =>
			deleteProjectEnvVar({ projectId, id: envVar.id })
		);
	}

	async function toggleEnvVar(envVar: AgentConfig['envVars'][number]) {
		await runAction(`env-toggle-${envVar.id}`, () =>
			setProjectEnvVarEnabled({ projectId, id: envVar.id, enabled: !envVar.enabled })
		);
	}

	let revealedEnvVars = $state<Record<string, string>>({});

	async function revealEnvVar(envVar: AgentConfig['envVars'][number]) {
		if (revealedEnvVars[envVar.id] !== undefined) {
			const { [envVar.id]: _removed, ...rest } = revealedEnvVars;
			revealedEnvVars = rest;
			return;
		}
		await runAction(`env-reveal-${envVar.id}`, async () => {
			const result = await revealProjectEnvVar({ projectId, id: envVar.id });
			revealedEnvVars = { ...revealedEnvVars, [envVar.id]: result.value };
		});
	}

	async function toggleEnvVarSensitive(envVar: AgentConfig['envVars'][number]) {
		await runAction(`env-sensitive-${envVar.id}`, async () => {
			await setProjectEnvVarSensitive({ projectId, id: envVar.id, sensitive: !envVar.sensitive });
			const { [envVar.id]: _removed, ...rest } = revealedEnvVars;
			revealedEnvVars = rest;
		});
	}

	let envImportText = $state('');
	async function importEnv() {
		if (envImportText.trim().length === 0) return;
		await runAction('env-import', async () => {
			await importProjectEnvFile({ projectId, content: envImportText });
			envImportText = '';
		});
	}

	function skillSourceLabel(skill: AgentConfig['skills'][number]): string {
		return skill.sourceProvider === 'skills.sh' ? 'skills.sh' : skill.description;
	}
</script>

<section class="space-y-3">
	<div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
		<h2 class="text-lg font-medium">Agent config</h2>
		<div class="grid grid-cols-4 border border-border md:w-auto">
			<Button
				variant={section === 'mcp' ? 'default' : 'ghost'}
				aria-pressed={section === 'mcp'}
				onclick={() => (section = 'mcp')}
				class="justify-start"
			>
				<Server />
				MCP
			</Button>
			<Button
				variant={section === 'skills' ? 'default' : 'ghost'}
				aria-pressed={section === 'skills'}
				onclick={() => (section = 'skills')}
				class="justify-start"
			>
				<BookOpen />
				Skills
			</Button>
			<Button
				variant={section === 'secrets' ? 'default' : 'ghost'}
				aria-pressed={section === 'secrets'}
				onclick={() => (section = 'secrets')}
				class="justify-start"
			>
				<KeyRound />
				Secrets
			</Button>
			<Button
				variant={section === 'env' ? 'default' : 'ghost'}
				aria-pressed={section === 'env'}
				onclick={() => (section = 'env')}
				class="justify-start"
			>
				<FileCog />
				.env
			</Button>
		</div>
	</div>

	{#if actionError}
		<p class="text-sm break-words text-destructive" role="alert">{actionError}</p>
	{/if}

	{#if section === 'mcp'}
		<Card.Root size="sm">
			<Card.Header>
				<Card.Title>MCP servers</Card.Title>
				<Card.Description>{config.mcpServers.length} configured</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				{#if config.mcpServers.length === 0}
					<p class="text-sm text-muted-foreground">No MCP servers.</p>
				{:else}
					<ul class="divide-y divide-border border-y border-border">
						{#each config.mcpServers as server (server.id)}
							<li class="grid gap-2 py-2 text-sm md:grid-cols-[1fr_auto] md:items-center">
								<div class="min-w-0">
									<p class="truncate font-medium">{server.name}</p>
									<p class="text-xs text-muted-foreground">
										{server.transport} · {server.enabled ? 'enabled' : 'disabled'}
									</p>
								</div>
								<div class="flex flex-wrap gap-2">
									<Button
										variant="outline"
										size="sm"
										disabled={actionsDisabled}
										onclick={() =>
											void runAction(`mcp-enable-${server.id}`, () =>
												setProjectMcpServerEnabled({
													projectId,
													id: server.id,
													enabled: !server.enabled
												})
											)}
									>
										{#if server.enabled}
											<PowerOff />
											Disable
										{:else}
											<Power />
											Enable
										{/if}
									</Button>
									<Button
										variant="destructive"
										size="sm"
										disabled={actionsDisabled}
										onclick={() =>
											void runAction(`mcp-delete-${server.id}`, () =>
												deleteProjectMcpServer({ projectId, id: server.id })
											)}
									>
										<Trash2 />
										Delete
									</Button>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
				<McpServerEditor {projectId} onSave={upsertProjectMcpServer} />
			</Card.Content>
		</Card.Root>
	{:else if section === 'skills'}
		<Card.Root size="sm">
			<Card.Header>
				<Card.Title>Skills</Card.Title>
				<Card.Description>{config.skills.length} configured</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				{#if config.skills.length === 0}
					<p class="text-sm text-muted-foreground">No skills.</p>
				{:else}
					<ul class="divide-y divide-border border-y border-border">
						{#each config.skills as skill (skill.id)}
							<li class="grid gap-2 py-2 text-sm md:grid-cols-[1fr_auto] md:items-center">
								<div class="min-w-0">
									<p class="truncate font-medium">{skill.name}</p>
									<p class="truncate text-xs text-muted-foreground">
										{skillSourceLabel(skill)} · {skill.enabled ? 'enabled' : 'disabled'}
									</p>
								</div>
								<div class="flex flex-wrap gap-2">
									<Button
										variant="outline"
										size="sm"
										disabled={actionsDisabled}
										onclick={() =>
											void runAction(`skill-enable-${skill.id}`, () =>
												setProjectSkillEnabled({
													projectId,
													id: skill.id,
													enabled: !skill.enabled
												})
											)}
									>
										{#if skill.enabled}
											<PowerOff />
											Disable
										{:else}
											<Power />
											Enable
										{/if}
									</Button>
									<Button
										variant="destructive"
										size="sm"
										disabled={actionsDisabled}
										onclick={() =>
											void runAction(`skill-delete-${skill.id}`, () =>
												deleteProjectSkill({ projectId, id: skill.id })
											)}
									>
										<Trash2 />
										Delete
									</Button>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
				<SkillsShCatalog
					{projectId}
					existingSkillNames={config.skills.map((skill) => skill.name)}
				/>
				<SkillEditor {projectId} onSave={upsertProjectSkill} />
			</Card.Content>
		</Card.Root>
	{:else if section === 'secrets'}
		<Card.Root size="sm">
			<Card.Header>
				<Card.Title>Secrets</Card.Title>
				<Card.Description>{config.secrets.length} configured</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				{#if config.secrets.length === 0}
					<p class="text-sm text-muted-foreground">No secrets.</p>
				{:else}
					<ul class="divide-y divide-border border-y border-border">
						{#each config.secrets as secret (secret.id)}
							<li class="grid gap-2 py-2 text-sm md:grid-cols-[1fr_auto] md:items-center">
								<div class="min-w-0">
									<p class="truncate font-medium">{secret.name}</p>
									<p class="text-xs text-muted-foreground">
										{secret.hasValue ? 'stored' : 'missing'}
									</p>
								</div>
								<Button
									variant="destructive"
									size="sm"
									disabled={actionsDisabled}
									onclick={() => void deleteSecret(secret)}
								>
									<Trash2 />
									Delete
								</Button>
							</li>
						{/each}
					</ul>
				{/if}
				<SecretEditor {projectId} onSave={upsertProjectSecret} />
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root size="sm">
			<Card.Header>
				<Card.Title>Environment (.env)</Card.Title>
				<Card.Description>{config.envVars.length} configured</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				{#if config.envVars.length === 0}
					<p class="text-sm text-muted-foreground">No environment variables.</p>
				{:else}
					<ul class="divide-y divide-border border-y border-border">
						{#each config.envVars as envVar (envVar.id)}
							<li class="grid gap-2 py-2 text-sm md:grid-cols-[1fr_auto] md:items-center">
								<div class="min-w-0">
									<p class="truncate font-medium">{envVar.key}</p>
									<p class="truncate text-xs text-muted-foreground">
										{envVar.sensitive
											? (revealedEnvVars[envVar.id] ?? '••••••')
											: envVar.value}{envVar.enabled ? '' : ' · disabled'}
									</p>
								</div>
								<div class="flex gap-2">
									{#if envVar.sensitive}
										<Button
											variant="ghost"
											size="sm"
											aria-label={revealedEnvVars[envVar.id] !== undefined
												? 'Hide value'
												: 'Reveal value'}
											disabled={actionsDisabled}
											onclick={() => void revealEnvVar(envVar)}
										>
											{#if revealedEnvVars[envVar.id] !== undefined}<EyeOff />{:else}<Eye />{/if}
										</Button>
									{/if}
									<Button
										variant="ghost"
										size="sm"
										aria-label={envVar.sensitive ? 'Mark as not sensitive' : 'Mark as sensitive'}
										disabled={actionsDisabled}
										onclick={() => void toggleEnvVarSensitive(envVar)}
									>
										{#if envVar.sensitive}<Lock />{:else}<LockOpen />{/if}
									</Button>
									<Button
										variant="ghost"
										size="sm"
										aria-label={envVar.enabled ? 'Disable' : 'Enable'}
										disabled={actionsDisabled}
										onclick={() => void toggleEnvVar(envVar)}
									>
										{#if envVar.enabled}<Power />{:else}<PowerOff />{/if}
									</Button>
									<Button
										variant="destructive"
										size="sm"
										disabled={actionsDisabled}
										onclick={() => void deleteEnvVar(envVar)}
									>
										<Trash2 />
										Delete
									</Button>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
				<EnvVarEditor {projectId} onSave={upsertProjectEnvVar} />
				<div class="space-y-2">
					<label for="env-import" class="text-sm font-medium">Import a .env</label>
					<textarea
						id="env-import"
						class="min-h-24 w-full border border-border bg-background p-2 font-mono text-xs"
						bind:value={envImportText}
						placeholder="NODE_ENV=production
API_KEY=..."
					></textarea>
					<Button size="sm" disabled={actionsDisabled} onclick={() => void importEnv()}>
						Import
					</Button>
				</div>
			</Card.Content>
		</Card.Root>
	{/if}
</section>
