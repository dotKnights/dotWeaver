<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import {
		NODE_PACKAGE_MANAGERS,
		PYTHON_PACKAGE_MANAGERS,
		type ProjectEnvironmentPackageManager,
		type ProjectEnvironmentRuntime
	} from '$lib/domain/project-environment';
	import type { ProjectEnvironmentProfileInput } from '$lib/schemas/project-environments';
	import { LoaderCircle, Save } from '@lucide/svelte';

	type EnvironmentProfile = Record<string, unknown> & {
		id?: string | null;
		runtime?: string | null;
		packageManager?: string | null;
		installCommand?: string | null;
		testCommand?: string | null;
		buildCommand?: string | null;
		devCommand?: string | null;
	};

	type Props = {
		projectId: string;
		environment?: EnvironmentProfile | null;
		onSave: (input: ProjectEnvironmentProfileInput) => Promise<unknown>;
	};

	const RUNTIME_OPTIONS: ProjectEnvironmentRuntime[] = ['node', 'python', 'custom'];
	const PACKAGE_MANAGER_OPTIONS: Record<
		ProjectEnvironmentRuntime,
		ProjectEnvironmentPackageManager[]
	> = {
		node: [...NODE_PACKAGE_MANAGERS],
		python: [...PYTHON_PACKAGE_MANAGERS],
		custom: ['custom']
	};

	let { projectId, environment = null, onSave }: Props = $props();

	let selectedRuntime = $state<ProjectEnvironmentRuntime | null>(null);
	let selectedPackageManager = $state<ProjectEnvironmentPackageManager | null>(null);
	let installCommandOverride = $state<string | null>(null);
	let testCommandOverride = $state<string | null>(null);
	let buildCommandOverride = $state<string | null>(null);
	let devCommandOverride = $state<string | null>(null);
	let saving = $state(false);
	let error = $state<string | null>(null);

	const runtime = $derived(selectedRuntime ?? normalizeRuntime(environment?.runtime));
	const packageManagerOptions = $derived(PACKAGE_MANAGER_OPTIONS[runtime]);
	const packageManager = $derived.by(() => {
		const selected = selectedPackageManager ?? environment?.packageManager;
		return normalizePackageManager(selected, runtime);
	});
	const installCommand = $derived(installCommandOverride ?? environment?.installCommand ?? '');
	const testCommand = $derived(testCommandOverride ?? environment?.testCommand ?? '');
	const buildCommand = $derived(buildCommandOverride ?? environment?.buildCommand ?? '');
	const devCommand = $derived(devCommandOverride ?? environment?.devCommand ?? '');
	const canSave = $derived(packageManagerOptions.includes(packageManager));

	function normalizeRuntime(value: unknown): ProjectEnvironmentRuntime {
		return RUNTIME_OPTIONS.includes(value as ProjectEnvironmentRuntime)
			? (value as ProjectEnvironmentRuntime)
			: 'node';
	}

	function normalizePackageManager(
		value: unknown,
		selectedRuntime: ProjectEnvironmentRuntime
	): ProjectEnvironmentPackageManager {
		const options = PACKAGE_MANAGER_OPTIONS[selectedRuntime];
		return options.includes(value as ProjectEnvironmentPackageManager)
			? (value as ProjectEnvironmentPackageManager)
			: options[0];
	}

	function handleRuntimeChange(value: string | undefined) {
		const nextRuntime = normalizeRuntime(value);
		selectedRuntime = nextRuntime;
		selectedPackageManager = normalizePackageManager(packageManager, nextRuntime);
	}

	async function save() {
		if (!canSave || saving) return;
		error = null;
		saving = true;
		try {
			await onSave({
				projectId,
				name: 'default',
				runtime,
				adapterId: runtime,
				packageManager,
				installCommand,
				testCommand,
				buildCommand,
				devCommand
			});
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save environment';
		} finally {
			saving = false;
		}
	}
</script>

<form
	class="space-y-3 border-t border-border pt-3"
	onsubmit={(event) => {
		event.preventDefault();
		void save();
	}}
>
	{#if error}
		<p class="text-sm break-words text-destructive" role="alert">{error}</p>
	{/if}

	<div class="grid gap-3 md:grid-cols-[1fr_1fr]">
		<div class="space-y-1">
			<Label for="environment-runtime">Runtime</Label>
			<Select.Root type="single" value={runtime} onValueChange={handleRuntimeChange}>
				<Select.Trigger id="environment-runtime" class="w-full">{runtime}</Select.Trigger>
				<Select.Content>
					{#each RUNTIME_OPTIONS as option (option)}
						<Select.Item value={option} label={option} />
					{/each}
				</Select.Content>
			</Select.Root>
		</div>

		<div class="space-y-1">
			<Label for="environment-package-manager">Package manager</Label>
			<Select.Root
				type="single"
				value={packageManager}
				onValueChange={(value) => (selectedPackageManager = normalizePackageManager(value, runtime))}
			>
				<Select.Trigger id="environment-package-manager" class="w-full">
					{packageManager}
				</Select.Trigger>
				<Select.Content>
					{#each packageManagerOptions as option (option)}
						<Select.Item value={option} label={option} />
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
	</div>

	<div class="grid gap-3 md:grid-cols-[1fr_1fr]">
		<div class="space-y-1">
			<Label for="environment-install-command">Install command</Label>
			<Input
				id="environment-install-command"
				value={installCommand}
				placeholder="bun install"
				oninput={(event) =>
					(installCommandOverride = (event.currentTarget as HTMLInputElement).value)}
			/>
		</div>
		<div class="space-y-1">
			<Label for="environment-test-command">Test command</Label>
			<Input
				id="environment-test-command"
				value={testCommand}
				placeholder="bun run test"
				oninput={(event) => (testCommandOverride = (event.currentTarget as HTMLInputElement).value)}
			/>
		</div>
		<div class="space-y-1">
			<Label for="environment-build-command">Build command</Label>
			<Input
				id="environment-build-command"
				value={buildCommand}
				placeholder="bun run build"
				oninput={(event) => (buildCommandOverride = (event.currentTarget as HTMLInputElement).value)}
			/>
		</div>
		<div class="space-y-1">
			<Label for="environment-dev-command">Dev command</Label>
			<Input
				id="environment-dev-command"
				value={devCommand}
				placeholder="bun run dev"
				oninput={(event) => (devCommandOverride = (event.currentTarget as HTMLInputElement).value)}
			/>
		</div>
	</div>

	<Button type="submit" size="sm" disabled={!canSave || saving}>
		{#if saving}
			<LoaderCircle class="animate-spin" />
			Saving
		{:else}
			<Save />
			Save
		{/if}
	</Button>
</form>
