<script lang="ts">
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
	import { BookOpen, FileCog, KeyRound, Power, PowerOff, Server, Trash2 } from '@lucide/svelte';
	import AgentConfigEnvSection from './AgentConfigEnvSection.svelte';
	import McpServerEditor from './McpServerEditor.svelte';
	import SecretEditor from './SecretEditor.svelte';
	import SkillEditor from './SkillEditor.svelte';
	import SkillsShCatalog from './SkillsShCatalog.svelte';
	import {
		skillSourceLabel,
		type AgentConfig,
		type AgentConfigSection,
		type RevealedEnvVars
	} from './agent-config-panel';

	type Props = {
		projectId: string;
		config: AgentConfig;
		canManage?: boolean;
	};

	let { projectId, config, canManage = true }: Props = $props();

	let section = $state<AgentConfigSection>('mcp');
	let actionError = $state<string | null>(null);
	let busyKey = $state<string | null>(null);
	const actionsDisabled = $derived(!canManage || busyKey !== null);

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

	let revealedEnvVars = $state<RevealedEnvVars>({});

	function hideEnvVarValue(id: string) {
		const next = { ...revealedEnvVars };
		delete next[id];
		revealedEnvVars = next;
	}

	async function revealEnvVar(envVar: AgentConfig['envVars'][number]) {
		if (revealedEnvVars[envVar.id] !== undefined) {
			hideEnvVarValue(envVar.id);
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
			hideEnvVarValue(envVar.id);
		});
	}

	async function importEnv(content: string) {
		await runAction('env-import', async () => {
			await importProjectEnvFile({ projectId, content });
		});
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
								{#if canManage}
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
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
				{#if canManage}
					<McpServerEditor {projectId} onSave={upsertProjectMcpServer} />
				{/if}
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
								{#if canManage}
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
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
				{#if canManage}
					<SkillsShCatalog
						{projectId}
						existingSkillNames={config.skills.map((skill) => skill.name)}
					/>
					<SkillEditor {projectId} onSave={upsertProjectSkill} />
				{/if}
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
								{#if canManage}
									<Button
										variant="destructive"
										size="sm"
										disabled={actionsDisabled}
										onclick={() => void deleteSecret(secret)}
									>
										<Trash2 />
										Delete
									</Button>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
				{#if canManage}
					<SecretEditor {projectId} onSave={upsertProjectSecret} />
				{/if}
			</Card.Content>
		</Card.Root>
	{:else}
		<AgentConfigEnvSection
			{projectId}
			{canManage}
			envVars={config.envVars}
			{actionsDisabled}
			{revealedEnvVars}
			onDeleteEnvVar={(envVar) => void deleteEnvVar(envVar)}
			onToggleEnvVar={(envVar) => void toggleEnvVar(envVar)}
			onToggleEnvVarSensitive={(envVar) => void toggleEnvVarSensitive(envVar)}
			onRevealEnvVar={(envVar) => void revealEnvVar(envVar)}
			onImportEnv={importEnv}
			onSaveEnvVar={upsertProjectEnvVar}
		/>
	{/if}
</section>
