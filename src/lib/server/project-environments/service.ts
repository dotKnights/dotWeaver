import type { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { authedCloneUrl, makeGitAuth } from '$lib/server/github-git';
import { prisma } from '$lib/server/prisma';
import {
	detectProjectEnvironment,
	getRuntimeAdapter
} from '$lib/server/project-environments/adapters';
import { buildProjectEnvironmentFingerprint } from '$lib/server/project-environments/fingerprint';
import { ensureMirror, readMirrorFiles } from '$lib/server/workspace';
import { projectEnvironmentProfileInputSchema } from '$lib/schemas/project-environments';

type ProjectEnvironmentProfileRawInput = z.input<typeof projectEnvironmentProfileInputSchema>;

type ProjectEnvironmentProfileDelegate = {
	findFirst(args: unknown): Promise<unknown>;
	upsert(args: unknown): Promise<unknown>;
};

type ProjectEnvironmentPrepareEventDelegate = {
	findMany(args: unknown): Promise<unknown[]>;
};

const environmentPrisma = prisma as typeof prisma & {
	projectEnvironmentProfile: ProjectEnvironmentProfileDelegate;
	projectEnvironmentPrepareEvent: ProjectEnvironmentPrepareEventDelegate;
};

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

function lockfilesFrom(files: Record<string, string | null>) {
	return Object.entries(files)
		.filter(
			([path, content]) => content !== null && /(^bun\.lock$|lock|requirements\.txt)/.test(path)
		)
		.map(([path, content]) => ({ path, content: content ?? '' }));
}

export async function getDefaultProjectEnvironmentForOrg(
	organizationId: string,
	projectId: string
) {
	await requireProjectAccess(organizationId, projectId);
	return environmentPrisma.projectEnvironmentProfile.findFirst({
		where: { organizationId, projectId, name: 'default' }
	});
}

export async function listProjectEnvironmentPrepareEventsForOrg(
	organizationId: string,
	projectId: string,
	profileId: string
) {
	const profile = await environmentPrisma.projectEnvironmentProfile.findFirst({
		where: { id: profileId, projectId, organizationId },
		select: { id: true }
	});
	if (!profile) throw new ProjectEnvironmentError('Project environment profile not found');
	return environmentPrisma.projectEnvironmentPrepareEvent.findMany({
		where: { organizationId, projectId, profileId },
		orderBy: { seq: 'asc' }
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
			lockfiles: lockfilesFrom(files),
			envKeys
		});
		return environmentPrisma.projectEnvironmentProfile.upsert({
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
	return environmentPrisma.projectEnvironmentProfile.upsert({
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
			warnings: asJson([...validation.warnings, ...validation.errors])
		}
	});
}
