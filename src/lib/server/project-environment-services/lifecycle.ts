import type { ProjectEnvironmentService, ProjectEnvironmentServiceEventType } from '@prisma/client';
import { isRecord } from '$lib/server/project-environment-services/config';
import { ProjectEnvironmentServiceError } from '$lib/server/project-environment-services/errors';
import { notifyProjectEnvironmentService } from '$lib/server/project-environment-services/notifications';
import { asJson } from '$lib/server/project-environment-services/prisma-json';
import { notifyProjectEnvironmentPrepare } from '$lib/server/project-environments/notifications';
import { prisma } from '$lib/server/prisma';

const MAX_EVENT_CREATE_ATTEMPTS = 5;

export type ServiceEventTarget = Pick<
	ProjectEnvironmentService,
	'id' | 'organizationId' | 'projectId' | 'profileId'
>;

export async function requireProjectEnvironmentProfileForOrg(
	organizationId: string,
	projectId: string,
	profileId: string
) {
	const profile = await prisma.projectEnvironmentProfile.findFirst({
		where: { id: profileId, projectId, organizationId },
		select: { id: true, projectId: true, organizationId: true }
	});
	if (!profile) throw new ProjectEnvironmentServiceError('Project environment profile not found');
	return profile;
}

export async function notifyServiceChange(
	service: ServiceEventTarget,
	change: { kind: 'event'; seq: number } | { kind: 'service' }
): Promise<void> {
	try {
		await notifyProjectEnvironmentService({
			organizationId: service.organizationId,
			projectId: service.projectId,
			profileId: service.profileId,
			serviceId: service.id,
			...change
		});
	} catch {
		// Live notifications are best-effort; persisted DB state remains authoritative.
	}
}

export async function markProfileNeedsPrepare(profile: {
	organizationId: string;
	projectId: string;
	profileId: string;
}): Promise<void> {
	const result = await prisma.projectEnvironmentProfile.updateMany({
		where: {
			id: profile.profileId,
			organizationId: profile.organizationId,
			projectId: profile.projectId
		},
		data: { lastPreparedFingerprint: null }
	});
	if (result.count === 0) return;
	try {
		await notifyProjectEnvironmentPrepare({
			organizationId: profile.organizationId,
			projectId: profile.projectId,
			profileId: profile.profileId,
			kind: 'profile'
		});
	} catch {
		// Live notifications are best-effort; persisted DB state remains authoritative.
	}
}

export async function appendServiceEvent(
	service: ServiceEventTarget,
	type: ProjectEnvironmentServiceEventType,
	payload: unknown
): Promise<number> {
	for (let attempt = 0; attempt < MAX_EVENT_CREATE_ATTEMPTS; attempt += 1) {
		const aggregate = await prisma.projectEnvironmentServiceEvent.aggregate({
			where: { serviceId: service.id },
			_max: { seq: true }
		});
		const seq = (aggregate._max.seq ?? -1) + 1;
		try {
			await prisma.projectEnvironmentServiceEvent.create({
				data: {
					serviceId: service.id,
					projectId: service.projectId,
					organizationId: service.organizationId,
					seq,
					type,
					payload: asJson(payload)
				}
			});
			await notifyServiceChange(service, { kind: 'event', seq });
			return seq;
		} catch (error) {
			if (isRecord(error) && error.code === 'P2002' && attempt < MAX_EVENT_CREATE_ATTEMPTS - 1) {
				continue;
			}
			throw error;
		}
	}
	throw new ProjectEnvironmentServiceError('Could not append project environment service event');
}
