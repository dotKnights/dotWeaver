<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import {
		deleteProjectMcpServer,
		deleteProjectSecret,
		deleteProjectSkill,
		setProjectMcpServerEnabled,
		setProjectSkillEnabled,
		upsertProjectMcpServer,
		upsertProjectSecret,
		upsertProjectSkill
	} from '$lib/rfc/project-agent-config.remote';
	import { BookOpen, KeyRound, Power, PowerOff, Server, Trash2 } from '@lucide/svelte';
	import McpServerEditor from './McpServerEditor.svelte';
	import SecretEditor from './SecretEditor.svelte';
	import SkillEditor from './SkillEditor.svelte';

	type AgentConfig = {
		mcpServers: Array<{
			id: string;
			name: string;
			transport: string;
			enabled: boolean;
		}>;
		skills: Array<{
			id: string;
			name: string;
			description: string;
			enabled: boolean;
		}>;
		secrets: Array<{
			id: string;
			name: string;
			hasValue: boolean;
		}>;
	};
	type Section = 'mcp' | 'skills' | 'secrets';

	let { projectId, config }: { projectId: string; config: AgentConfig } = $props();

	let section = $state<Section>('mcp');
	let actionError = $state<string | null>(null);
	let busyKey = $state<string | null>(null);

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
</script>

<section class="space-y-3">
	<div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
		<h2 class="text-lg font-medium">Agent config</h2>
		<div class="grid grid-cols-3 border border-border md:w-auto">
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
										disabled={busyKey === `mcp-enable-${server.id}`}
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
										disabled={busyKey === `mcp-delete-${server.id}`}
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
										{skill.description} · {skill.enabled ? 'enabled' : 'disabled'}
									</p>
								</div>
								<div class="flex flex-wrap gap-2">
									<Button
										variant="outline"
										size="sm"
										disabled={busyKey === `skill-enable-${skill.id}`}
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
										disabled={busyKey === `skill-delete-${skill.id}`}
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
				<SkillEditor {projectId} onSave={upsertProjectSkill} />
			</Card.Content>
		</Card.Root>
	{:else}
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
									disabled={busyKey === `secret-delete-${secret.id}`}
									onclick={() =>
										void runAction(`secret-delete-${secret.id}`, () =>
											deleteProjectSecret({ projectId, id: secret.id })
										)}
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
	{/if}
</section>
