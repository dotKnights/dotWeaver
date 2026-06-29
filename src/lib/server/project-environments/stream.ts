import type { Prisma } from '@prisma/client';
import { env as privateEnv } from '$env/dynamic/private';
import { prisma } from '$lib/server/prisma';
import {
	PROJECT_ENVIRONMENT_PREPARE_CHANNEL,
	parseProjectEnvironmentPrepareNotification,
	type ProjectEnvironmentPrepareNotification
} from '$lib/server/project-environments/notifications';
import {
	createPgNotificationChangeSource,
	createWake,
	formatNamedSseEvent,
	type ChangeSource
} from '$lib/server/runtime/event-stream';

export { formatNamedSseEvent };

const projectEnvironmentPrepareEventSelect = {
	id: true,
	seq: true,
	type: true,
	payload: true,
	createdAt: true
} satisfies Prisma.ProjectEnvironmentPrepareEventSelect;

export type ProjectEnvironmentPrepareEventRow = Prisma.ProjectEnvironmentPrepareEventGetPayload<{
	select: typeof projectEnvironmentPrepareEventSelect;
}>;

export type ProjectEnvironmentPrepareEventPayload = Omit<
	ProjectEnvironmentPrepareEventRow,
	'createdAt'
> & {
	createdAt: string;
};

const projectEnvironmentPrepareProfileSelect = {
	id: true,
	name: true,
	status: true,
	runtime: true,
	packageManager: true,
	installCommand: true,
	currentFingerprint: true,
	lastPreparedFingerprint: true,
	lastPrepareStatus: true,
	lastPrepareError: true
} satisfies Prisma.ProjectEnvironmentProfileSelect;

export type ProjectEnvironmentPrepareProfileRow = Prisma.ProjectEnvironmentProfileGetPayload<{
	select: typeof projectEnvironmentPrepareProfileSelect;
}>;

export type ProjectEnvironmentPrepareProfilePayload = ProjectEnvironmentPrepareProfileRow;

export type ProjectEnvironmentPrepareStreamItem =
	| { kind: 'event'; seq: number; event: ProjectEnvironmentPrepareEventPayload }
	| { kind: 'profile'; profile: ProjectEnvironmentPrepareProfilePayload }
	| { kind: 'ping' };

export type ProjectEnvironmentPrepareChangeSource =
	ChangeSource<ProjectEnvironmentPrepareNotification>;

export type StreamProjectEnvironmentPrepareInput = {
	organizationId: string;
	projectId: string;
	profileId: string;
	fromSeq?: number;
	changeSource?: ProjectEnvironmentPrepareChangeSource;
	pingMs?: number;
	signal?: AbortSignal;
};

let defaultChangeSource: ProjectEnvironmentPrepareChangeSource | null = null;

function eventPayload(
	event: ProjectEnvironmentPrepareEventRow
): ProjectEnvironmentPrepareEventPayload {
	return {
		id: event.id,
		seq: event.seq,
		type: event.type,
		payload: event.payload,
		createdAt: event.createdAt.toISOString()
	};
}

function profilePayload(
	profile: ProjectEnvironmentPrepareProfileRow
): ProjectEnvironmentPrepareProfilePayload {
	return {
		id: profile.id,
		name: profile.name,
		status: profile.status,
		runtime: profile.runtime,
		packageManager: profile.packageManager,
		installCommand: profile.installCommand,
		currentFingerprint: profile.currentFingerprint,
		lastPreparedFingerprint: profile.lastPreparedFingerprint,
		lastPrepareStatus: profile.lastPrepareStatus,
		lastPrepareError: profile.lastPrepareError
	};
}

function matchesStream(
	notification: ProjectEnvironmentPrepareNotification,
	input: StreamProjectEnvironmentPrepareInput
): boolean {
	return (
		notification.organizationId === input.organizationId &&
		notification.projectId === input.projectId &&
		notification.profileId === input.profileId
	);
}

export function createPgProjectEnvironmentPrepareChangeSource(
	connectionString = privateEnv.DATABASE_URL
): ProjectEnvironmentPrepareChangeSource {
	return createPgNotificationChangeSource({
		connectionString,
		channel: PROJECT_ENVIRONMENT_PREPARE_CHANNEL,
		missingConnectionMessage: 'DATABASE_URL is required for environment events',
		parseNotification: parseProjectEnvironmentPrepareNotification
	});
}

function getDefaultChangeSource(): ProjectEnvironmentPrepareChangeSource {
	defaultChangeSource ??= createPgProjectEnvironmentPrepareChangeSource();
	return defaultChangeSource;
}

export async function* streamProjectEnvironmentPrepare(
	input: StreamProjectEnvironmentPrepareInput
): AsyncGenerator<ProjectEnvironmentPrepareStreamItem> {
	const wake = createWake(input.signal, input.pingMs);
	const changeSource = input.changeSource ?? getDefaultChangeSource();
	const unsubscribe = await changeSource.subscribe((notification) => {
		if (matchesStream(notification, input)) wake.notify();
	});
	let cursor = input.fromSeq ?? -1;
	let lastProfileJson = '';

	async function drain(): Promise<ProjectEnvironmentPrepareStreamItem[]> {
		const [profile, events] = await Promise.all([
			prisma.projectEnvironmentProfile.findFirst({
				where: {
					id: input.profileId,
					organizationId: input.organizationId,
					projectId: input.projectId
				},
				select: projectEnvironmentPrepareProfileSelect
			}),
			prisma.projectEnvironmentPrepareEvent.findMany({
				where: {
					organizationId: input.organizationId,
					projectId: input.projectId,
					profileId: input.profileId,
					seq: { gt: cursor }
				},
				select: projectEnvironmentPrepareEventSelect,
				orderBy: { seq: 'asc' }
			})
		]);
		const items: ProjectEnvironmentPrepareStreamItem[] = [];
		if (profile) {
			const payload = profilePayload(profile);
			const profileJson = JSON.stringify(payload);
			if (profileJson !== lastProfileJson) {
				lastProfileJson = profileJson;
				items.push({ kind: 'profile', profile: payload });
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
