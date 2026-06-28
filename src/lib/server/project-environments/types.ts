import type { ProjectEnvironmentProfile } from '@prisma/client';
import type {
	ProjectEnvironmentPackageManager,
	ProjectEnvironmentRuntime
} from '$lib/domain/project-environment';

export type DetectionFiles = Record<string, string | null>;

export interface DetectionInput {
	files: DetectionFiles;
}

export type EnvironmentCommands = Pick<
	ProjectEnvironmentProfile,
	'installCommand' | 'testCommand' | 'buildCommand' | 'devCommand'
>;

export interface DetectionResult extends EnvironmentCommands {
	runtime: ProjectEnvironmentRuntime;
	adapterId: string;
	adapterVersion: string;
	packageManager: ProjectEnvironmentPackageManager;
	confidence: number;
	detectedFiles: string[];
	warnings: string[];
	detection: Record<string, unknown>;
}

export interface CacheMountSpec {
	source: string;
	target: string;
	readOnly?: boolean;
}

export interface PreparedArtifactSpec {
	path: string;
	required?: boolean;
}

export interface RuntimeAdapter {
	id: ProjectEnvironmentRuntime;
	label: string;
	version: string;
	detect(input: DetectionInput): DetectionResult | null;
	cacheMounts(input: {
		root: string;
		projectId: string;
		profileName: string;
		packageManager: ProjectEnvironmentPackageManager;
	}): CacheMountSpec[];
	preparedArtifacts(input: {
		packageManager: ProjectEnvironmentPackageManager;
	}): PreparedArtifactSpec[];
	validate(input: { packageManager: ProjectEnvironmentPackageManager; installCommand: string }): {
		warnings: string[];
		errors: string[];
	};
}
