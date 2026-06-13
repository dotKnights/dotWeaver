<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import type { ProjectMcpServerInput } from '$lib/schemas/project-agent-config';
	import { Plus } from '@lucide/svelte';

	type Transport = ProjectMcpServerInput['transport'];

	let {
		projectId,
		onSave
	}: {
		projectId: string;
		onSave: (input: ProjectMcpServerInput) => Promise<unknown>;
	} = $props();

	let name = $state('');
	let transport = $state<Transport>('http');
	let url = $state('');
	let command = $state('');
	let args = $state('');
	let headersJson = $state('{}');
	let envName = $state('');
	let secretName = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);

	const canSave = $derived(
		name.trim().length > 0 &&
			(transport === 'stdio' ? command.trim().length > 0 : url.trim().length > 0)
	);

	function parseHeaders(): Record<string, string> {
		const trimmed = headersJson.trim();
		if (!trimmed) return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new Error('Headers must be valid JSON');
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('Headers must be a JSON object');
		}
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value !== 'string') throw new Error(`Header ${key} must be a string`);
			headers[key] = value;
		}
		return headers;
	}

	function buildEnv(): Record<string, { secretName: string }> {
		const envKey = envName.trim();
		const secretKey = secretName.trim();
		if (!envKey && !secretKey) return {};
		if (!envKey || !secretKey) throw new Error('Env and secret names must be filled together');
		return { [envKey]: { secretName: secretKey } };
	}

	function reset() {
		name = '';
		url = '';
		command = '';
		args = '';
		headersJson = '{}';
		envName = '';
		secretName = '';
	}

	async function save() {
		if (!canSave || saving) return;
		error = null;
		saving = true;
		try {
			const base = {
				projectId,
				name: name.trim(),
				transport,
				enabled: true,
				env: buildEnv()
			};
			const input: ProjectMcpServerInput =
				transport === 'stdio'
					? {
							...base,
							transport,
							command: command.trim(),
							args: args.split(/\s+/).filter(Boolean)
						}
					: {
							...base,
							transport,
							url: url.trim(),
							headers: parseHeaders()
						};
			await onSave(input);
			reset();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save MCP server';
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

	<div class="grid gap-3 md:grid-cols-[1fr_12rem]">
		<div class="space-y-1">
			<Label for="mcp-name">Name</Label>
			<Input id="mcp-name" bind:value={name} placeholder="linear" />
		</div>
		<div class="space-y-1">
			<Label>Transport</Label>
			<Select.Root
				type="single"
				value={transport}
				onValueChange={(value) => (transport = (value as Transport | undefined) ?? 'http')}
			>
				<Select.Trigger class="w-full">{transport}</Select.Trigger>
				<Select.Content>
					<Select.Item value="http" label="http" />
					<Select.Item value="sse" label="sse" />
					<Select.Item value="stdio" label="stdio" />
				</Select.Content>
			</Select.Root>
		</div>
	</div>

	{#if transport === 'stdio'}
		<div class="grid gap-3 md:grid-cols-[1fr_1fr]">
			<div class="space-y-1">
				<Label for="mcp-command">Command</Label>
				<Input id="mcp-command" bind:value={command} placeholder="bunx" />
			</div>
			<div class="space-y-1">
				<Label for="mcp-args">Args</Label>
				<Input id="mcp-args" bind:value={args} placeholder="linear-mcp" />
			</div>
		</div>
	{:else}
		<div class="grid gap-3 md:grid-cols-[1fr_1fr]">
			<div class="space-y-1">
				<Label for="mcp-url">URL</Label>
				<Input id="mcp-url" bind:value={url} placeholder="https://example.com/mcp" />
			</div>
			<div class="space-y-1">
				<Label for="mcp-headers">Headers JSON</Label>
				<Input id="mcp-headers" bind:value={headersJson} spellcheck="false" />
			</div>
		</div>
	{/if}

	<div class="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
		<div class="space-y-1">
			<Label for="mcp-env-name">Env</Label>
			<Input id="mcp-env-name" bind:value={envName} placeholder="LINEAR_API_KEY" />
		</div>
		<div class="space-y-1">
			<Label for="mcp-secret-name">Secret</Label>
			<Input id="mcp-secret-name" bind:value={secretName} placeholder="linear_api_key" />
		</div>
		<Button type="submit" disabled={!canSave || saving} class="w-full md:w-auto">
			<Plus />
			{saving ? 'Saving' : 'Add MCP'}
		</Button>
	</div>
</form>
