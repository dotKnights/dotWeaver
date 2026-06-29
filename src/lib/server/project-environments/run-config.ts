import type { ProjectEnvironmentProfile } from '@prisma/client';
import { readFile, stat } from 'node:fs/promises';
import { prisma } from '$lib/server/prisma';
import { buildProjectEnvironmentServiceOutputsForOrg } from '$lib/server/project-environment-services/service';
import { projectEnvironmentCacheMounts } from '$lib/server/project-environments/cache-paths';
import { ProjectEnvironmentError } from '$lib/server/project-environments/errors';
import { needsProjectEnvironmentPrepare } from '$lib/server/project-environments/fingerprint';
import {
	projectEnvironmentMetadataPath,
	projectEnvironmentTemplatePath,
	workspaceRoot
} from '$lib/server/projects/workspace-paths';

const PREPARE_BEFORE_RUN_MESSAGE = 'Prepare the project environment before starting a run';

type PreparedTemplateProfile = Pick<
	ProjectEnvironmentProfile,
	'id' | 'name' | 'runtime' | 'packageManager' | 'installCommand' | 'currentFingerprint'
>;

type CurrentDetectedTemplateProfile = PreparedTemplateProfile &
	Pick<ProjectEnvironmentProfile, 'status' | 'lastPreparedFingerprint' | 'lastPrepareStatus'>;

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

async function listEnabledRunEnvironmentServices(input: {
	organizationId: string;
	projectId: string;
	profileId: string;
}) {
	return prisma.projectEnvironmentService.findMany({
		where: {
			organizationId: input.organizationId,
			projectId: input.projectId,
			profileId: input.profileId,
			enabled: true
		},
		select: { id: true, kind: true, name: true, status: true },
		orderBy: [{ kind: 'asc' }, { name: 'asc' }]
	});
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
	const services = await listEnabledRunEnvironmentServices({
		organizationId,
		projectId,
		profileId: profile.id
	});
	const notReadyService = services.find((service) => service.status !== 'ready');
	if (notReadyService) {
		throw new ProjectEnvironmentError('Project environment service is not ready');
	}
	const serviceOutputs = await buildProjectEnvironmentServiceOutputsForOrg(
		organizationId,
		projectId,
		profile.id
	);
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
			services: services.map((service) => ({
				id: service.id,
				kind: service.kind,
				name: service.name,
				status: service.status
			})),
			templatePath
		},
		...(serviceOutputs.env.length > 0 ? { containerEnv: serviceOutputs.env } : {})
	};
}
