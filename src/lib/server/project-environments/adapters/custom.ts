import type { RuntimeAdapter } from '$lib/server/project-environments/types';

export const customAdapter: RuntimeAdapter = {
	id: 'custom',
	label: 'Custom',
	version: '1',
	detect() {
		return {
			runtime: 'custom',
			adapterId: 'custom',
			adapterVersion: '1',
			packageManager: 'custom',
			confidence: 1,
			detectedFiles: [],
			warnings: ['No supported runtime files detected'],
			detection: {},
			installCommand: '',
			testCommand: '',
			buildCommand: '',
			devCommand: ''
		};
	},
	cacheMounts() {
		return [];
	},
	preparedArtifacts() {
		return [];
	},
	validate(input) {
		return input.packageManager === 'custom'
			? { warnings: [], errors: [] }
			: { warnings: [], errors: [`${input.packageManager} is not valid for custom`] };
	}
};
