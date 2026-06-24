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

	type EditorState = {
		key: string;
		selectedRuntime: ProjectEnvironmentRuntime | null;
		selectedPackageManager: ProjectEnvironmentPackageManager | null;
		installCommandOverride: string | null;
		testCommandOverride: string | null;
		buildCommandOverride: string | null;
		devCommandOverride: string | null;
		saving: boolean;
		error: string | null;
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

	const environmentKey = $derived(
		[
			projectId,
			environment?.id ?? 'new',
			environment?.runtime ?? '',
			environment?.packageManager ?? '',
			environment?.installCommand ?? '',
			environment?.testCommand ?? '',
			environment?.buildCommand ?? '',
			environment?.devCommand ?? ''
		].join(':')
	);
	let editorState: EditorState = $state(emptyEditorState(''));
	const activeEditorState: EditorState = $derived.by(
		(): EditorState =>
			editorState.key === environmentKey ? editorState : emptyEditorState(environmentKey)
	);

	const runtime = $derived(
		activeEditorState.selectedRuntime ?? normalizeRuntime(environment?.runtime)
	);
	const packageManagerOptions = $derived(PACKAGE_MANAGER_OPTIONS[runtime]);
	const packageManager = $derived.by(() => {
		const selected = activeEditorState.selectedPackageManager ?? environment?.packageManager;
		return normalizePackageManager(selected, runtime);
	});
	const commandDefaults = $derived(defaultCommands(runtime, packageManager));
	const installCommand = $derived(
		commandValue(
			activeEditorState.installCommandOverride,
			environment?.installCommand,
			commandDefaults.installCommand
		)
	);
	const testCommand = $derived(
		commandValue(
			activeEditorState.testCommandOverride,
			environment?.testCommand,
			commandDefaults.testCommand
		)
	);
	const buildCommand = $derived(
		commandValue(
			activeEditorState.buildCommandOverride,
			environment?.buildCommand,
			commandDefaults.buildCommand
		)
	);
	const devCommand = $derived(
		commandValue(
			activeEditorState.devCommandOverride,
			environment?.devCommand,
			commandDefaults.devCommand
		)
	);
	const canSave = $derived(packageManagerOptions.includes(packageManager));

	function emptyEditorState(key: string): EditorState {
		return {
			key,
			selectedRuntime: null,
			selectedPackageManager: null,
			installCommandOverride: null,
			testCommandOverride: null,
			buildCommandOverride: null,
			devCommandOverride: null,
			saving: false,
			error: null
		};
	}

	function updateState(patch: Partial<EditorState>) {
		editorState = { ...activeEditorState, ...patch, key: environmentKey };
	}

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

	function defaultCommands(
		selectedRuntime: ProjectEnvironmentRuntime,
		selectedPackageManager: ProjectEnvironmentPackageManager
	) {
		if (selectedRuntime === 'node') {
			return {
				installCommand: `${selectedPackageManager} install`,
				testCommand: `${selectedPackageManager} run test`,
				buildCommand: `${selectedPackageManager} run build`,
				devCommand: `${selectedPackageManager} run dev`
			};
		}
		if (selectedRuntime === 'python') {
			if (selectedPackageManager === 'uv') {
				return {
					installCommand: 'uv sync',
					testCommand: 'uv run pytest',
					buildCommand: '',
					devCommand: ''
				};
			}
			if (selectedPackageManager === 'poetry') {
				return {
					installCommand: 'poetry install',
					testCommand: 'poetry run pytest',
					buildCommand: '',
					devCommand: ''
				};
			}
			return {
				installCommand: 'pip install -r requirements.txt',
				testCommand: 'python -m pytest',
				buildCommand: '',
				devCommand: ''
			};
		}
		return { installCommand: '', testCommand: '', buildCommand: '', devCommand: '' };
	}

	function commandValue(
		override: string | null,
		profileValue: string | null | undefined,
		fallback: string
	): string {
		if (override !== null) return override;
		return environment ? (profileValue ?? '') : fallback;
	}

	function handleRuntimeChange(value: string | undefined) {
		const nextRuntime = normalizeRuntime(value);
		updateState({
			selectedRuntime: nextRuntime,
			selectedPackageManager: normalizePackageManager(packageManager, nextRuntime)
		});
	}

	async function save() {
		if (!canSave || activeEditorState.saving) return;
		updateState({ error: null, saving: true });
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
			updateState({ error: e instanceof Error ? e.message : 'Could not save environment' });
		} finally {
			updateState({ saving: false });
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
	{#if activeEditorState.error}
		<p class="text-sm break-words text-destructive" role="alert">{activeEditorState.error}</p>
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
				onValueChange={(value) =>
					updateState({ selectedPackageManager: normalizePackageManager(value, runtime) })}
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
				placeholder={commandDefaults.installCommand || 'install command'}
				oninput={(event) =>
					updateState({ installCommandOverride: (event.currentTarget as HTMLInputElement).value })}
			/>
		</div>
		<div class="space-y-1">
			<Label for="environment-test-command">Test command</Label>
			<Input
				id="environment-test-command"
				value={testCommand}
				placeholder={commandDefaults.testCommand || 'test command'}
				oninput={(event) =>
					updateState({ testCommandOverride: (event.currentTarget as HTMLInputElement).value })}
			/>
		</div>
		<div class="space-y-1">
			<Label for="environment-build-command">Build command</Label>
			<Input
				id="environment-build-command"
				value={buildCommand}
				placeholder={commandDefaults.buildCommand || 'build command'}
				oninput={(event) =>
					updateState({ buildCommandOverride: (event.currentTarget as HTMLInputElement).value })}
			/>
		</div>
		<div class="space-y-1">
			<Label for="environment-dev-command">Dev command</Label>
			<Input
				id="environment-dev-command"
				value={devCommand}
				placeholder={commandDefaults.devCommand || 'dev command'}
				oninput={(event) =>
					updateState({ devCommandOverride: (event.currentTarget as HTMLInputElement).value })}
			/>
		</div>
	</div>

	<Button type="submit" size="sm" disabled={!canSave || activeEditorState.saving}>
		{#if activeEditorState.saving}
			<LoaderCircle class="animate-spin" />
			Saving
		{:else}
			<Save />
			Save
		{/if}
	</Button>
</form>
