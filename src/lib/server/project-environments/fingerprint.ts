import { createHash } from 'node:crypto';
import type {
	ProjectEnvironmentPackageManager,
	ProjectEnvironmentPrepareStatus,
	ProjectEnvironmentRuntime
} from '$lib/domain/project-environment';

export type ProjectEnvironmentServiceFingerprintInput = {
	kind: string;
	name: string;
	enabled: boolean;
	status: string;
	providerVersion: string;
	config: Record<string, unknown>;
	outputKeys: string[];
	outputValueHashes: string[];
};

function normalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeJson);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, nested]) => [key, normalizeJson(nested)])
		);
	}
	return value;
}

export function buildProjectEnvironmentFingerprint(input: {
	adapterId: string;
	adapterVersion: string;
	runtime: ProjectEnvironmentRuntime;
	packageManager: ProjectEnvironmentPackageManager;
	installCommand: string;
	lockfiles: Array<{ path: string; content: string }>;
	envKeys: string[];
	services?: ProjectEnvironmentServiceFingerprintInput[];
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
		envKeys: [...new Set(input.envKeys)].sort(),
		services: (input.services ?? [])
			.map((service) => ({
				kind: service.kind,
				name: service.name,
				enabled: service.enabled,
				status: service.status,
				providerVersion: service.providerVersion,
				config: normalizeJson(service.config),
				outputKeys: [...service.outputKeys],
				outputValueHashes: [...service.outputValueHashes]
			}))
			.sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`))
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
