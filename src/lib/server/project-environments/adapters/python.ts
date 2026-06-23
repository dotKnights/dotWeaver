import { projectEnvironmentCacheMounts } from '$lib/server/project-environments/cache-paths';
import type {
	DetectionInput,
	DetectionResult,
	RuntimeAdapter
} from '$lib/server/project-environments/types';

const VERSION = '1';

function has(input: DetectionInput, path: string): boolean {
	return input.files[path] !== undefined && input.files[path] !== null;
}

function packageManager(input: DetectionInput): DetectionResult['packageManager'] {
	if (has(input, 'uv.lock')) return 'uv';
	if (has(input, 'poetry.lock')) return 'poetry';
	if (has(input, 'requirements.txt')) return 'pip';
	return 'uv';
}

function installCommand(pm: DetectionResult['packageManager'], input: DetectionInput): string {
	if (pm === 'uv') return 'uv sync';
	if (pm === 'poetry') return 'poetry install';
	if (pm === 'pip' && has(input, 'requirements.txt')) return 'pip install -r requirements.txt';
	return '';
}

export const pythonAdapter: RuntimeAdapter = {
	id: 'python',
	label: 'Python',
	version: VERSION,
	detect(input) {
		const detectedFiles = ['pyproject.toml', 'requirements.txt', 'uv.lock', 'poetry.lock'].filter(
			(path) => has(input, path)
		);
		if (detectedFiles.length === 0) return null;
		const pm = packageManager(input);
		const warnings =
			has(input, 'pyproject.toml') && !has(input, 'uv.lock') && !has(input, 'poetry.lock')
				? ['pyproject.toml has no supported lockfile; uv is suggested']
				: [];
		return {
			runtime: 'python',
			adapterId: 'python',
			adapterVersion: VERSION,
			packageManager: pm,
			confidence: detectedFiles.some((path) => path.endsWith('.lock')) ? 90 : 70,
			detectedFiles,
			warnings,
			detection: {},
			installCommand: installCommand(pm, input),
			testCommand: '',
			buildCommand: '',
			devCommand: ''
		};
	},
	cacheMounts(input) {
		return projectEnvironmentCacheMounts({ ...input, runtime: 'python' });
	},
	validate(input) {
		const errors: string[] = [];
		if (!['uv', 'pip', 'poetry'].includes(input.packageManager)) {
			errors.push(`${input.packageManager} is not valid for python`);
		}
		return { warnings: [], errors };
	}
};
