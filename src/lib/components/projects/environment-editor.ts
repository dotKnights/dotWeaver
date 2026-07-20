import {
	NODE_PACKAGE_MANAGERS,
	PROJECT_ENVIRONMENT_RUNTIMES,
	PYTHON_PACKAGE_MANAGERS,
	type ProjectEnvironmentPackageManager,
	type ProjectEnvironmentRuntime
} from '$lib/domain/project-environment';
import type { EnvironmentProfile } from './environment-setup-state';

export type EnvironmentEditorState = {
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

export const RUNTIME_OPTIONS: ProjectEnvironmentRuntime[] = [...PROJECT_ENVIRONMENT_RUNTIMES];
export const PACKAGE_MANAGER_OPTIONS: Record<
	ProjectEnvironmentRuntime,
	ProjectEnvironmentPackageManager[]
> = {
	node: [...NODE_PACKAGE_MANAGERS],
	python: [...PYTHON_PACKAGE_MANAGERS],
	custom: ['custom']
};

export function emptyEditorState(key: string): EnvironmentEditorState {
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

export function environmentEditorKey(
	projectId: string,
	environment: EnvironmentProfile | null | undefined
): string {
	return [
		projectId,
		environment?.id ?? 'new',
		environment?.runtime ?? '',
		environment?.packageManager ?? '',
		environment?.installCommand ?? '',
		environment?.testCommand ?? '',
		environment?.buildCommand ?? '',
		environment?.devCommand ?? ''
	].join(':');
}

export function normalizeRuntime(value: unknown): ProjectEnvironmentRuntime {
	return RUNTIME_OPTIONS.includes(value as ProjectEnvironmentRuntime)
		? (value as ProjectEnvironmentRuntime)
		: 'node';
}

export function normalizePackageManager(
	value: unknown,
	selectedRuntime: ProjectEnvironmentRuntime
): ProjectEnvironmentPackageManager {
	const options = PACKAGE_MANAGER_OPTIONS[selectedRuntime];
	return options.includes(value as ProjectEnvironmentPackageManager)
		? (value as ProjectEnvironmentPackageManager)
		: options[0];
}

export function defaultCommands(
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

export function commandValue(
	override: string | null,
	profileValue: string | null | undefined,
	fallback: string,
	hasEnvironment: boolean
): string {
	if (override !== null) return override;
	return hasEnvironment ? (profileValue ?? '') : fallback;
}
