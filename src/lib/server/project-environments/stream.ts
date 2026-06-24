import { Client } from 'pg';
import { env as privateEnv } from '$env/dynamic/private';
import { prisma } from '$lib/server/prisma';
import {
	PROJECT_ENVIRONMENT_PREPARE_CHANNEL,
	parseProjectEnvironmentPrepareNotification,
	type ProjectEnvironmentPrepareNotification
} from '$lib/server/project-environments/notifications';

export type ProjectEnvironmentPrepareEventPayload = {
	id: string;
	seq: number;
	type: string;
	payload: unknown;
	createdAt: string;
};

export type ProjectEnvironmentPrepareProfilePayload = {
	id: string;
	name: string;
	status: string;
	runtime: string;
	packageManager: string;
	installCommand: string;
	currentFingerprint: string | null;
	lastPreparedFingerprint: string | null;
	lastPrepareStatus: string;
	lastPrepareError: string | null;
};

export type ProjectEnvironmentPrepareStreamItem =
	| { kind: 'event'; seq: number; event: ProjectEnvironmentPrepareEventPayload }
	| { kind: 'profile'; profile: ProjectEnvironmentPrepareProfilePayload }
	| { kind: 'ping' };

export type ProjectEnvironmentPrepareChangeSource = {
	subscribe: (
		onChange: (notification: ProjectEnvironmentPrepareNotification) => void
	) => Promise<() => Promise<void>>;
};

export type StreamProjectEnvironmentPrepareInput = {
	organizationId: string;
	projectId: string;
	profileId: string;
	fromSeq?: number;
	changeSource?: ProjectEnvironmentPrepareChangeSource;
	pingMs?: number;
	signal?: AbortSignal;
};

type EventRow = {
	id: string;
	seq: number;
	type: string;
	payload: unknown;
	createdAt: Date;
};

type ProfileRow = {
	id: string;
	name: string;
	status: string;
	runtime: string;
	packageManager: string;
	installCommand: string;
	currentFingerprint: string | null;
	lastPreparedFingerprint: string | null;
	lastPrepareStatus: string;
	lastPrepareError: string | null;
};

let defaultChangeSource: ProjectEnvironmentPrepareChangeSource | null = null;

function eventPayload(event: EventRow): ProjectEnvironmentPrepareEventPayload {
	return {
		id: event.id,
		seq: event.seq,
		type: event.type,
		payload: event.payload,
		createdAt: event.createdAt.toISOString()
	};
}

function profilePayload(profile: ProfileRow): ProjectEnvironmentPrepareProfilePayload {
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

function createWake(signal?: AbortSignal, pingMs = 15_000) {
	let wake: (() => void) | null = null;
	let pendingChange = false;

	const notify = () => {
		pendingChange = true;
		wake?.();
	};

	const wait = async (): Promise<'change' | 'ping' | 'abort'> => {
		if (signal?.aborted) return 'abort';
		if (pendingChange) {
			pendingChange = false;
			return 'change';
		}
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				cleanup();
				resolve('ping');
			}, pingMs);
			const onAbort = () => {
				cleanup();
				resolve('abort');
			};
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				wake = null;
			};
			wake = () => {
				pendingChange = false;
				cleanup();
				resolve('change');
			};
			signal?.addEventListener('abort', onAbort, { once: true });
		});
	};

	return { notify, wait };
}

export function formatNamedSseEvent(event: string, payload: unknown, id?: number): string {
	return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(
		payload
	)}\n\n`;
}

export function createPgProjectEnvironmentPrepareChangeSource(
	connectionString = privateEnv.DATABASE_URL
): ProjectEnvironmentPrepareChangeSource {
	let client: Client | null = null;
	let connectPromise: Promise<void> | null = null;
	const listeners = new Set<(notification: ProjectEnvironmentPrepareNotification) => void>();

	const ensureConnected = async () => {
		if (!connectionString) throw new Error('DATABASE_URL is required for environment events');
		if (connectPromise) return connectPromise;
		if (client) return;

		client = new Client({ connectionString });
		client.on('notification', (message) => {
			if (message.channel !== PROJECT_ENVIRONMENT_PREPARE_CHANNEL) return;
			const notification = parseProjectEnvironmentPrepareNotification(message.payload);
			if (!notification) return;
			for (const listener of listeners) listener(notification);
		});
		client.on('error', () => {
			client = null;
			connectPromise = null;
		});
		connectPromise = client
			.connect()
			.then(() => client?.query(`LISTEN ${PROJECT_ENVIRONMENT_PREPARE_CHANNEL}`))
			.then(() => undefined)
			.catch(async (error: unknown) => {
				const failedClient = client;
				client = null;
				connectPromise = null;
				await failedClient?.end().catch(() => {});
				throw error;
			});
		await connectPromise;
	};

	const closeIfIdle = async () => {
		if (listeners.size > 0 || !client) return;
		const idleClient = client;
		client = null;
		connectPromise = null;
		try {
			await idleClient.query(`UNLISTEN ${PROJECT_ENVIRONMENT_PREPARE_CHANNEL}`);
		} catch {
			// The connection may already be closed after request abort.
		}
		await idleClient.end().catch(() => {});
	};

	return {
		async subscribe(onChange) {
			listeners.add(onChange);
			try {
				await ensureConnected();
			} catch (error) {
				listeners.delete(onChange);
				throw error;
			}
			return async () => {
				listeners.delete(onChange);
				await closeIfIdle();
			};
		}
	};
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
				select: {
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
				}
			}),
			prisma.projectEnvironmentPrepareEvent.findMany({
				where: {
					organizationId: input.organizationId,
					projectId: input.projectId,
					profileId: input.profileId,
					seq: { gt: cursor }
				},
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
