import type { Prisma } from '@prisma/client';
import { env as privateEnv } from '$env/dynamic/private';
import { prisma } from '$lib/server/prisma';
import {
	PROJECT_ENVIRONMENT_SERVICE_CHANNEL,
	parseProjectEnvironmentServiceNotification,
	type ProjectEnvironmentServiceNotification
} from '$lib/server/project-environment-services/notifications';
import { sanitizeServiceForPublicWithMappings } from '$lib/server/project-environment-services/service';
import {
	createPgNotificationChangeSource,
	createWake,
	formatNamedSseEvent,
	type ChangeSource
} from '$lib/server/runtime/event-stream';

export { formatNamedSseEvent };

const projectEnvironmentServiceEventSelect = {
	id: true,
	seq: true,
	type: true,
	payload: true,
	createdAt: true
} satisfies Prisma.ProjectEnvironmentServiceEventSelect;

export type ProjectEnvironmentServiceEventRow = Prisma.ProjectEnvironmentServiceEventGetPayload<{
	select: typeof projectEnvironmentServiceEventSelect;
}>;

type ProjectEnvironmentServiceEventPayload = Omit<
	ProjectEnvironmentServiceEventRow,
	'createdAt'
> & {
	createdAt: string;
};

const projectEnvironmentServiceSelect = {
	id: true,
	profileId: true,
	kind: true,
	name: true,
	enabled: true,
	status: true,
	lastError: true,
	lastReadyAt: true,
	updatedAt: true,
	config: true,
	outputs: true
} satisfies Prisma.ProjectEnvironmentServiceSelect;

export type ProjectEnvironmentServiceRow = Prisma.ProjectEnvironmentServiceGetPayload<{
	select: typeof projectEnvironmentServiceSelect;
}>;

type PublicServicePayload = ReturnType<
	typeof sanitizeServiceForPublicWithMappings<ProjectEnvironmentServiceRow>
>;

type ProjectEnvironmentServicePayload = Omit<PublicServicePayload, 'lastReadyAt' | 'updatedAt'> & {
	lastReadyAt: string | null;
	updatedAt: string;
};

export type ProjectEnvironmentServiceStreamItem =
	| { kind: 'event'; seq: number; event: ProjectEnvironmentServiceEventPayload }
	| { kind: 'service'; service: ProjectEnvironmentServicePayload }
	| { kind: 'ping' };

export type ProjectEnvironmentServiceChangeSource =
	ChangeSource<ProjectEnvironmentServiceNotification>;

export type StreamProjectEnvironmentServiceInput = {
	organizationId: string;
	projectId: string;
	profileId: string;
	serviceId: string;
	fromSeq?: number;
	changeSource?: ProjectEnvironmentServiceChangeSource;
	pingMs?: number;
	signal?: AbortSignal;
};

let defaultChangeSource: ProjectEnvironmentServiceChangeSource | null = null;

function eventPayload(
	event: ProjectEnvironmentServiceEventRow
): ProjectEnvironmentServiceEventPayload {
	return {
		id: event.id,
		seq: event.seq,
		type: event.type,
		payload: event.payload,
		createdAt: event.createdAt.toISOString()
	};
}

function servicePayload(service: ProjectEnvironmentServiceRow): ProjectEnvironmentServicePayload {
	return {
		...sanitizeServiceForPublicWithMappings(service),
		lastReadyAt: service.lastReadyAt?.toISOString() ?? null,
		updatedAt: service.updatedAt.toISOString()
	};
}

function matchesStream(
	notification: ProjectEnvironmentServiceNotification,
	input: StreamProjectEnvironmentServiceInput
): boolean {
	return (
		notification.organizationId === input.organizationId &&
		notification.projectId === input.projectId &&
		notification.profileId === input.profileId &&
		notification.serviceId === input.serviceId
	);
}

function createPgProjectEnvironmentServiceChangeSource(
	connectionString = privateEnv.DATABASE_URL
): ProjectEnvironmentServiceChangeSource {
	return createPgNotificationChangeSource({
		connectionString,
		channel: PROJECT_ENVIRONMENT_SERVICE_CHANNEL,
		missingConnectionMessage: 'DATABASE_URL is required for service events',
		parseNotification: parseProjectEnvironmentServiceNotification
	});
}

function getDefaultChangeSource(): ProjectEnvironmentServiceChangeSource {
	defaultChangeSource ??= createPgProjectEnvironmentServiceChangeSource();
	return defaultChangeSource;
}

export async function* streamProjectEnvironmentServiceEvents(
	input: StreamProjectEnvironmentServiceInput
): AsyncGenerator<ProjectEnvironmentServiceStreamItem> {
	const wake = createWake(input.signal, input.pingMs);
	const changeSource = input.changeSource ?? getDefaultChangeSource();
	const unsubscribe = await changeSource.subscribe((notification) => {
		if (matchesStream(notification, input)) wake.notify();
	});
	let cursor = input.fromSeq ?? -1;
	let lastServiceJson = '';

	async function drain(): Promise<ProjectEnvironmentServiceStreamItem[]> {
		const [service, events] = await Promise.all([
			prisma.projectEnvironmentService.findFirst({
				where: {
					id: input.serviceId,
					organizationId: input.organizationId,
					projectId: input.projectId,
					profileId: input.profileId
				},
				select: projectEnvironmentServiceSelect
			}),
			prisma.projectEnvironmentServiceEvent.findMany({
				where: {
					organizationId: input.organizationId,
					projectId: input.projectId,
					serviceId: input.serviceId,
					seq: { gt: cursor }
				},
				select: projectEnvironmentServiceEventSelect,
				orderBy: { seq: 'asc' }
			})
		]);
		const items: ProjectEnvironmentServiceStreamItem[] = [];
		if (service) {
			const payload = servicePayload(service);
			const serviceJson = JSON.stringify(payload);
			if (serviceJson !== lastServiceJson) {
				lastServiceJson = serviceJson;
				items.push({ kind: 'service', service: payload });
			}
		}
		for (const event of events) {
			cursor = event.seq;
			items.push({ kind: 'event', seq: event.seq, event: eventPayload(event) });
		}
		return items;
	}

	try {
		while (!input.signal?.aborted) {
			for (const item of await drain()) {
				yield item;
			}
			const next = await wake.wait();
			if (next === 'abort') return;
			if (next === 'ping') yield { kind: 'ping' };
		}
	} finally {
		await unsubscribe();
	}
}
