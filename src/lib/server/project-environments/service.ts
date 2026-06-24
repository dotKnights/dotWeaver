import type { Prisma } from '@prisma/client';
import { readFile, stat } from 'node:fs/promises';
import type { z } from 'zod';
import { authedCloneUrl, makeGitAuth } from '$lib/server/github-git';
import { prisma } from '$lib/server/prisma';
import {
	detectProjectEnvironment,
	getRuntimeAdapter
} from '$lib/server/project-environments/adapters';
import { projectEnvironmentCacheMounts } from '$lib/server/project-environments/cache-paths';
import {
	buildProjectEnvironmentFingerprint,
	needsProjectEnvironmentPrepare
} from '$lib/server/project-environments/fingerprint';
import {
	executeProjectEnvironmentPrepare,
	ProjectEnvironmentPrepareError
} from '$lib/server/project-environments/prepare';
import { ensureMirror, readMirrorFiles } from '$lib/server/workspace';
import {
	projectEnvironmentMetadataPath,
	projectEnvironmentTemplatePath,
	workspaceRoot
} from '$lib/server/workspace-paths';
import { appendRunEvent, getNextEventSeq } from '$lib/server/run-events';
import { projectEnvironmentProfileInputSchema } from '$lib/schemas/project-environments';

type ProjectEnvironmentProfileRawInput = z.input<typeof projectEnvironmentProfileInputSchema>;

export class ProjectEnvironmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectEnvironmentError';
	}
}

const DETECTION_PATHS = [
	'package.json',
	'bun.lock',
	'package-lock.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'pyproject.toml',
	'requirements.txt',
	'uv.lock',
	'poetry.lock'
];

const DEPENDENCY_FILE_PATHS = new Set(DETECTION_PATHS);
const PREPARE_BEFORE_RUN_MESSAGE = 'Prepare the project environment before starting a run';

async function requireProjectAccess(organizationId: string, projectId: string) {
	const project = await prisma.project.findFirst({
		where: { id: projectId, organizationId },
		select: { id: true }
	});
	if (!project) throw new ProjectEnvironmentError('Project not found');
	return project;
}

async function requireProjectInOrg(organizationId: string, projectId: string) {
	const project = await prisma.project.findFirst({
		where: { id: projectId, organizationId },
		select: {
			id: true,
			organizationId: true,
			cloneUrl: true,
			defaultBranch: true
		}
	});
	if (!project) throw new ProjectEnvironmentError('Project not found');
	return project;
}

function asJson(value: unknown): Prisma.InputJsonValue {
	return value as Prisma.InputJsonValue;
}

async function envKeysForProject(organizationId: string, projectId: string): Promise<string[]> {
	const rows = await prisma.projectEnvVar.findMany({
		where: { organizationId, projectId, enabled: true },
		select: { key: true },
		orderBy: { key: 'asc' }
	});
	return rows.map((row) => row.key);
}

function dependencyFilesFrom(files: Record<string, string | null>) {
	return Object.entries(files)
		.filter(([path, content]) => content !== null && DEPENDENCY_FILE_PATHS.has(path))
		.map(([path, content]) => ({ path, content: content ?? '' }));
}

type PreparedTemplateProfile = {
	id: string;
	name: string;
	runtime: string;
	packageManager: string;
	installCommand: string;
	currentFingerprint: string | null;
};

type CurrentDetectedTemplateProfile = PreparedTemplateProfile & {
	status: string;
	lastPreparedFingerprint: string | null;
	lastPrepareStatus: string;
};

function isPreparedMetadataCurrent(
	metadata: Record<string, unknown>,
	projectId: string,
	profile: PreparedTemplateProfile
): boolean {
	return (
		metadata.projectId === projectId &&
		metadata.profileId === profile.id &&
		metadata.profileName === profile.name &&
		metadata.runtime === profile.runtime &&
		metadata.packageManager === profile.packageManager &&
		metadata.installCommand === profile.installCommand &&
		metadata.fingerprint === profile.currentFingerprint
	);
}

async function requireCurrentPreparedTemplate(input: {
	root: string;
	projectId: string;
	profile: PreparedTemplateProfile;
}): Promise<string> {
	const templatePath = projectEnvironmentTemplatePath(
		input.root,
		input.projectId,
		input.profile.name
	);
	const metadataPath = projectEnvironmentMetadataPath(
		input.root,
		input.projectId,
		input.profile.name
	);
	try {
		const templateStats = await stat(templatePath);
		if (!templateStats.isDirectory()) {
			throw new ProjectEnvironmentError(PREPARE_BEFORE_RUN_MESSAGE);
		}
		const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
		if (!isPreparedMetadataCurrent(metadata, input.projectId, input.profile)) {
			throw new ProjectEnvironmentError(PREPARE_BEFORE_RUN_MESSAGE);
		}
		return templatePath;
	} catch (error) {
		if (error instanceof ProjectEnvironmentError) throw error;
		throw new ProjectEnvironmentError(PREPARE_BEFORE_RUN_MESSAGE);
	}
}

async function markCurrentDetectedProfileReady(profile: CurrentDetectedTemplateProfile) {
	if (profile.status !== 'detected') return;
	await prisma.projectEnvironmentProfile.updateMany({
		where: {
			id: profile.id,
			status: 'detected',
			currentFingerprint: profile.currentFingerprint,
			lastPreparedFingerprint: profile.lastPreparedFingerprint,
			lastPrepareStatus: 'succeeded'
		},
		data: { status: 'ready' }
	});
}

export async function getDefaultProjectEnvironmentForOrg(
	organizationId: string,
	projectId: string
) {
	await requireProjectAccess(organizationId, projectId);
	return prisma.projectEnvironmentProfile.findFirst({
		where: { organizationId, projectId, name: 'default' }
	});
}

export async function listProjectEnvironmentPrepareEventsForOrg(
	organizationId: string,
	projectId: string,
	profileId: string
) {
	await requireProjectEnvironmentProfileForOrg(organizationId, projectId, profileId);
	return prisma.projectEnvironmentPrepareEvent.findMany({
		where: { organizationId, projectId, profileId },
		orderBy: { seq: 'asc' }
	});
}

export async function requireProjectEnvironmentProfileForOrg(
	organizationId: string,
	projectId: string,
	profileId: string
): Promise<{ id: string }> {
	await requireProjectAccess(organizationId, projectId);
	const profile = await prisma.projectEnvironmentProfile.findFirst({
		where: { id: profileId, projectId, organizationId },
		select: { id: true }
	});
	if (!profile) throw new ProjectEnvironmentError('Project environment profile not found');
	return profile;
}

export async function buildRunEnvironmentConfig(organizationId: string, projectId: string) {
	const profile = await prisma.projectEnvironmentProfile.findFirst({
		where: { organizationId, projectId, name: 'default' }
	});
	if (!profile) {
		return {
			cacheMounts: [],
			snapshot: { enabled: false, warning: 'No project environment profile configured' }
		};
	}
	if (profile.status === 'invalid') {
		throw new ProjectEnvironmentError('Environment profile default is invalid');
	}
	const needsPrepare = needsProjectEnvironmentPrepare({
		currentFingerprint: profile.currentFingerprint,
		lastPreparedFingerprint: profile.lastPreparedFingerprint,
		lastPrepareStatus: profile.lastPrepareStatus,
		installCommand: profile.installCommand
	});
	const currentFingerprintIsUsable =
		typeof profile.currentFingerprint === 'string' && profile.currentFingerprint.length > 0;
	if (profile.status !== 'ready') {
		if (profile.status !== 'detected' || needsPrepare || !currentFingerprintIsUsable) {
			return {
				cacheMounts: [],
				snapshot: {
					enabled: false,
					warning: 'Project environment profile default is not ready',
					status: profile.status,
					profileId: profile.id
				}
			};
		}
	}
	if (needsPrepare) {
		throw new ProjectEnvironmentError(PREPARE_BEFORE_RUN_MESSAGE);
	}
	if (!currentFingerprintIsUsable) {
		throw new ProjectEnvironmentError(PREPARE_BEFORE_RUN_MESSAGE);
	}
	const root = workspaceRoot();
	const templatePath = await requireCurrentPreparedTemplate({ root, projectId, profile });
	await markCurrentDetectedProfileReady(profile);
	return {
		cacheMounts: projectEnvironmentCacheMounts({
			root,
			projectId,
			profileName: profile.name,
			runtime: profile.runtime,
			packageManager: profile.packageManager
		}),
		snapshot: {
			enabled: true,
			profileId: profile.id,
			profileName: profile.name,
			runtime: profile.runtime,
			packageManager: profile.packageManager,
			installCommand: profile.installCommand,
			currentFingerprint: profile.currentFingerprint,
			lastPreparedFingerprint: profile.lastPreparedFingerprint,
			lastPrepareStatus: profile.lastPrepareStatus,
			needsPrepare: false,
			prepared: true,
			templatePath
		}
	};
}

export async function prepareRunEnvironmentIfNeeded(input: {
	runId: string;
	checkoutPath: string;
	createdById: string;
	environmentSnapshot: Record<string, unknown>;
}): Promise<void> {
	if (input.environmentSnapshot.enabled !== true) return;
	if (input.environmentSnapshot.needsPrepare !== true) return;
	const profileId = String(input.environmentSnapshot.profileId);
	let seq = await getNextEventSeq(input.runId);
	await appendRunEvent(input.runId, seq, {
		type: 'system',
		subtype: 'environment_prepare_started',
		profileId
	});
	seq += 1;
	let result: Awaited<ReturnType<typeof executeProjectEnvironmentPrepare>>;
	try {
		result = await executeProjectEnvironmentPrepare({
			profileId,
			requestedById: input.createdById,
			force: false
		});
	} catch (error) {
		await appendRunEvent(input.runId, seq, {
			type: 'system',
			subtype: 'environment_prepare_failed',
			profileId,
			error: error instanceof Error ? error.message : String(error)
		});
		throw error;
	}
	if (result.status === 'already_running') {
		const error = new ProjectEnvironmentPrepareError(
			'Project environment preparation is already running'
		);
		await appendRunEvent(input.runId, seq, {
			type: 'system',
			subtype: 'environment_prepare_running',
			profileId,
			error: error.message
		});
		throw error;
	}
	await appendRunEvent(input.runId, seq, {
		type: 'system',
		subtype: 'environment_prepare_completed',
		profileId,
		...(result.status === 'skipped_current' ? { skipped: true } : {})
	});
}

export async function detectProjectEnvironmentForOrg(input: {
	organizationId: string;
	userId: string;
	projectId: string;
	githubToken: string | null;
}) {
	const project = await requireProjectInOrg(input.organizationId, input.projectId);
	const auth = input.githubToken ? await makeGitAuth(input.githubToken) : null;
	try {
		await ensureMirror(
			project.id,
			input.githubToken ? authedCloneUrl(project.cloneUrl) : project.cloneUrl,
			auth?.env
		);
		const files = await readMirrorFiles(
			project.id,
			project.defaultBranch,
			DETECTION_PATHS,
			auth?.env
		);
		const detected = detectProjectEnvironment({ files });
		const envKeys = await envKeysForProject(input.organizationId, input.projectId);
		const currentFingerprint = buildProjectEnvironmentFingerprint({
			adapterId: detected.adapterId,
			adapterVersion: detected.adapterVersion,
			runtime: detected.runtime,
			packageManager: detected.packageManager,
			installCommand: detected.installCommand,
			lockfiles: dependencyFilesFrom(files),
			envKeys
		});
		return prisma.projectEnvironmentProfile.upsert({
			where: { projectId_name: { projectId: input.projectId, name: 'default' } },
			create: {
				projectId: input.projectId,
				organizationId: input.organizationId,
				name: 'default',
				runtime: detected.runtime,
				adapterId: detected.adapterId,
				adapterVersion: detected.adapterVersion,
				packageManager: detected.packageManager,
				installCommand: detected.installCommand,
				testCommand: detected.testCommand,
				buildCommand: detected.buildCommand,
				devCommand: detected.devCommand,
				status: 'detected',
				detection: asJson(detected.detection),
				warnings: asJson(detected.warnings),
				currentFingerprint,
				createdById: input.userId
			},
			update: {
				runtime: detected.runtime,
				adapterId: detected.adapterId,
				adapterVersion: detected.adapterVersion,
				packageManager: detected.packageManager,
				installCommand: detected.installCommand,
				testCommand: detected.testCommand,
				buildCommand: detected.buildCommand,
				devCommand: detected.devCommand,
				status: 'detected',
				detection: asJson(detected.detection),
				warnings: asJson(detected.warnings),
				currentFingerprint
			}
		});
	} finally {
		await auth?.cleanup();
	}
}

export async function upsertProjectEnvironmentProfileForOrg(
	organizationId: string,
	userId: string,
	rawInput: ProjectEnvironmentProfileRawInput
) {
	const input = projectEnvironmentProfileInputSchema.parse(rawInput);
	await requireProjectInOrg(organizationId, input.projectId);
	const adapter = getRuntimeAdapter(input.adapterId);
	if (!adapter) throw new ProjectEnvironmentError(`Runtime adapter ${input.adapterId} not found`);
	const validation = adapter.validate({
		packageManager: input.packageManager,
		installCommand: input.installCommand
	});
	const status = validation.errors.length > 0 ? 'invalid' : 'ready';
	const envKeys = await envKeysForProject(organizationId, input.projectId);
	const currentFingerprint = buildProjectEnvironmentFingerprint({
		adapterId: input.adapterId,
		adapterVersion: adapter.version,
		runtime: input.runtime,
		packageManager: input.packageManager,
		installCommand: input.installCommand,
		lockfiles: [],
		envKeys
	});
	return prisma.projectEnvironmentProfile.upsert({
		where: { projectId_name: { projectId: input.projectId, name: input.name } },
		create: {
			projectId: input.projectId,
			organizationId,
			name: input.name,
			runtime: input.runtime,
			adapterId: input.adapterId,
			adapterVersion: adapter.version,
			packageManager: input.packageManager,
			installCommand: input.installCommand,
			testCommand: input.testCommand,
			buildCommand: input.buildCommand,
			devCommand: input.devCommand,
			status,
			detection: asJson({ source: 'manual' }),
			warnings: asJson([...validation.warnings, ...validation.errors]),
			currentFingerprint,
			createdById: userId
		},
		update: {
			runtime: input.runtime,
			adapterId: input.adapterId,
			adapterVersion: adapter.version,
			packageManager: input.packageManager,
			installCommand: input.installCommand,
			testCommand: input.testCommand,
			buildCommand: input.buildCommand,
			devCommand: input.devCommand,
			status,
			detection: asJson({ source: 'manual' }),
			warnings: asJson([...validation.warnings, ...validation.errors]),
			currentFingerprint
		}
	});
}
