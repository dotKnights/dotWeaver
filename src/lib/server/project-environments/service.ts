import type { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { authedCloneUrl, makeGitAuth } from '$lib/server/integrations/github/git-auth';
import { prisma } from '$lib/server/prisma';
import {
	detectProjectEnvironment,
	getRuntimeAdapter
} from '$lib/server/project-environments/adapters';
import { ProjectEnvironmentError } from '$lib/server/project-environments/errors';
import { buildProjectEnvironmentFingerprint } from '$lib/server/project-environments/fingerprint';
import { buildProjectEnvironmentServiceOutputsForOrg } from '$lib/server/project-environment-services/service';
import {
	executeProjectEnvironmentPrepare,
	ProjectEnvironmentPrepareError
} from '$lib/server/project-environments/prepare';
import { ensureMirror, readMirrorFiles } from '$lib/server/projects/workspace';
import { appendRunEvent, getNextEventSeq } from '$lib/server/runs/events';
import { projectEnvironmentProfileInputSchema } from '$lib/schemas/project-environments';

type ProjectEnvironmentProfileRawInput = z.input<typeof projectEnvironmentProfileInputSchema>;

export { ProjectEnvironmentError } from '$lib/server/project-environments/errors';
export { buildRunEnvironmentConfig } from '$lib/server/project-environments/run-config';

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

async function existingProfileIdForFingerprint(
	organizationId: string,
	projectId: string,
	name: string
): Promise<string | null> {
	const profile = await prisma.projectEnvironmentProfile.findFirst({
		where: { organizationId, projectId, name },
		select: { id: true }
	});
	return profile?.id ?? null;
}

async function buildFingerprintInputs(input: {
	organizationId: string;
	projectId: string;
	profileId: string | null;
}): Promise<{
	envKeys: string[];
	serviceWarnings: string[];
	services: NonNullable<Parameters<typeof buildProjectEnvironmentFingerprint>[0]['services']>;
}> {
	const projectEnvKeys = await envKeysForProject(input.organizationId, input.projectId);
	if (!input.profileId) return { envKeys: projectEnvKeys, serviceWarnings: [], services: [] };

	const serviceOutputs = await buildProjectEnvironmentServiceOutputsForOrg(
		input.organizationId,
		input.projectId,
		input.profileId
	);
	return {
		envKeys: [...projectEnvKeys, ...serviceOutputs.env.map((entry) => entry.key)],
		serviceWarnings: serviceOutputs.warnings,
		services: serviceOutputs.fingerprintInputs
	};
}

function dependencyFilesFrom(files: Record<string, string | null>) {
	return Object.entries(files)
		.filter(([path, content]) => content !== null && DEPENDENCY_FILE_PATHS.has(path))
		.map(([path, content]) => ({ path, content: content ?? '' }));
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
		const existingProfileId = await existingProfileIdForFingerprint(
			input.organizationId,
			input.projectId,
			'default'
		);
		const fingerprintInputs = await buildFingerprintInputs({
			organizationId: input.organizationId,
			projectId: input.projectId,
			profileId: existingProfileId
		});
		const currentFingerprint = buildProjectEnvironmentFingerprint({
			adapterId: detected.adapterId,
			adapterVersion: detected.adapterVersion,
			runtime: detected.runtime,
			packageManager: detected.packageManager,
			installCommand: detected.installCommand,
			lockfiles: dependencyFilesFrom(files),
			envKeys: fingerprintInputs.envKeys,
			services: fingerprintInputs.services
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
				warnings: asJson([...detected.warnings, ...fingerprintInputs.serviceWarnings]),
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
				warnings: asJson([...detected.warnings, ...fingerprintInputs.serviceWarnings]),
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
	const existingProfileId = await existingProfileIdForFingerprint(
		organizationId,
		input.projectId,
		input.name
	);
	const fingerprintInputs = await buildFingerprintInputs({
		organizationId,
		projectId: input.projectId,
		profileId: existingProfileId
	});
	const currentFingerprint = buildProjectEnvironmentFingerprint({
		adapterId: input.adapterId,
		adapterVersion: adapter.version,
		runtime: input.runtime,
		packageManager: input.packageManager,
		installCommand: input.installCommand,
		lockfiles: [],
		envKeys: fingerprintInputs.envKeys,
		services: fingerprintInputs.services
	});
	const warnings = [
		...validation.warnings,
		...validation.errors,
		...fingerprintInputs.serviceWarnings
	];
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
			warnings: asJson(warnings),
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
			warnings: asJson(warnings),
			currentFingerprint
		}
	});
}
