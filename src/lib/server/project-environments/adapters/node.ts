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

function readPackageJson(input: DetectionInput): { scripts?: Record<string, string> } {
	const raw = input.files['package.json'];
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === 'object' && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

function packageManager(input: DetectionInput): DetectionResult['packageManager'] {
	if (has(input, 'bun.lock')) return 'bun';
	if (has(input, 'pnpm-lock.yaml')) return 'pnpm';
	if (has(input, 'yarn.lock')) return 'yarn';
	if (has(input, 'package-lock.json')) return 'npm';
	return 'npm';
}

function runCommand(pm: DetectionResult['packageManager'], script: string): string {
	return pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`;
}

export const nodeAdapter: RuntimeAdapter = {
	id: 'node',
	label: 'Node.js',
	version: VERSION,
	detect(input) {
		if (!has(input, 'package.json')) return null;
		const pm = packageManager(input);
		const pkg = readPackageJson(input);
		const scripts = pkg.scripts ?? {};
		const detectedFiles = ['package.json'].filter((path) => has(input, path));
		for (const lock of ['bun.lock', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']) {
			if (has(input, lock)) detectedFiles.push(lock);
		}
		return {
			runtime: 'node',
			adapterId: 'node',
			adapterVersion: VERSION,
			packageManager: pm,
			confidence: detectedFiles.length > 1 ? 95 : 75,
			detectedFiles,
			warnings: detectedFiles.length === 1 ? ['No JavaScript lockfile detected'] : [],
			detection: { scripts: Object.keys(scripts) },
			installCommand: `${pm} install`,
			testCommand: scripts.test ? runCommand(pm, 'test') : '',
			buildCommand: scripts.build ? runCommand(pm, 'build') : '',
			devCommand: scripts.dev ? runCommand(pm, 'dev') : ''
		};
	},
	cacheMounts(input) {
		return projectEnvironmentCacheMounts({ ...input, runtime: 'node' });
	},
	validate(input) {
		const errors: string[] = [];
		if (!['bun', 'npm', 'pnpm', 'yarn'].includes(input.packageManager)) {
			errors.push(`${input.packageManager} is not valid for node`);
		}
		return { warnings: [], errors };
	}
};
