import { createHash } from 'node:crypto';
import type {
	ProjectEnvironmentPackageManager,
	ProjectEnvironmentPrepareStatus,
	ProjectEnvironmentRuntime
} from '$lib/domain/project-environment';

export function buildProjectEnvironmentFingerprint(input: {
	adapterId: string;
	adapterVersion: string;
	runtime: ProjectEnvironmentRuntime;
	packageManager: ProjectEnvironmentPackageManager;
	installCommand: string;
	lockfiles: Array<{ path: string; content: string }>;
	envKeys: string[];
}): string {
	const payload = {
		adapterId: input.adapterId,
		adapterVersion: input.adapterVersion,
		runtime: input.runtime,
		packageManager: input.packageManager,
		installCommand: input.installCommand,
		lockfiles: input.lockfiles
			.map((file) => ({
				path: file.path,
				hash: createHash('sha256').update(file.content).digest('hex')
			}))
			.sort((a, b) => a.path.localeCompare(b.path)),
		envKeys: [...new Set(input.envKeys)].sort()
	};
	return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function needsProjectEnvironmentPrepare(input: {
	currentFingerprint: string | null;
	lastPreparedFingerprint: string | null;
	lastPrepareStatus: ProjectEnvironmentPrepareStatus;
	installCommand: string;
}): boolean {
	if (input.installCommand.trim().length === 0) return false;
	if (input.lastPrepareStatus !== 'succeeded') return true;
	return input.currentFingerprint !== input.lastPreparedFingerprint;
}
