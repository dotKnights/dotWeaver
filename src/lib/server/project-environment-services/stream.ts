import { Client } from 'pg';
import { env as privateEnv } from '$env/dynamic/private';
import { prisma } from '$lib/server/prisma';
import {
	PROJECT_ENVIRONMENT_SERVICE_CHANNEL,
	parseProjectEnvironmentServiceNotification,
	type ProjectEnvironmentServiceNotification
} from '$lib/server/project-environment-services/notifications';
import { sanitizeServiceForPublicWithMappings } from '$lib/server/project-environment-services/service';

export type ProjectEnvironmentServiceEventPayload = {
	id: string;
	seq: number;
	type: string;
	payload: unknown;
	createdAt: string;
};

export type ProjectEnvironmentServicePayload = {
	id: string;
	profileId: string;
	kind: string;
	name: string;
	enabled: boolean;
	status: string;
	lastError: string | null;
	lastReadyAt: string | null;
	updatedAt: string;
	config?: unknown;
	envMappings?: unknown;
	sourceFields?: unknown;
	outputs?: unknown;
	mappingWarnings?: string[];
	mappingErrors?: string[];
};

export type ProjectEnvironmentServiceStreamItem =
	| { kind: 'event'; seq: number; event: ProjectEnvironmentServiceEventPayload }
	| { kind: 'service'; service: ProjectEnvironmentServicePayload }
	| { kind: 'ping' };

export type ProjectEnvironmentServiceChangeSource = {
	subscribe: (
		onChange: (notification: ProjectEnvironmentServiceNotification) => void
	) => Promise<() => Promise<void>>;
};

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

type EventRow = {
	id: string;
	seq: number;
	type: string;
	payload: unknown;
	createdAt: Date;
};

type ServiceRow = {
	id: string;
	profileId: string;
	kind: string;
	name: string;
	enabled: boolean;
	status: string;
	lastError: string | null;
	lastReadyAt: Date | null;
	updatedAt: Date;
	config: unknown;
	outputs: unknown;
};

let defaultChangeSource: ProjectEnvironmentServiceChangeSource | null = null;

function eventPayload(event: EventRow): ProjectEnvironmentServiceEventPayload {
	return {
		id: event.id,
		seq: event.seq,
		type: event.type,
		payload: event.payload,
		createdAt: event.createdAt.toISOString()
	};
}

function servicePayload(service: ServiceRow): ProjectEnvironmentServicePayload {
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

export function createPgProjectEnvironmentServiceChangeSource(
	connectionString = privateEnv.DATABASE_URL
): ProjectEnvironmentServiceChangeSource {
	let client: Client | null = null;
	let connectPromise: Promise<void> | null = null;
	const listeners = new Set<(notification: ProjectEnvironmentServiceNotification) => void>();

	const ensureConnected = async () => {
		if (!connectionString) throw new Error('DATABASE_URL is required for service events');
		if (connectPromise) return connectPromise;
		if (client) return;

		client = new Client({ connectionString });
		client.on('notification', (message) => {
			if (message.channel !== PROJECT_ENVIRONMENT_SERVICE_CHANNEL) return;
			const notification = parseProjectEnvironmentServiceNotification(message.payload);
			if (!notification) return;
			for (const listener of listeners) listener(notification);
		});
		client.on('error', () => {
			client = null;
			connectPromise = null;
		});
		connectPromise = client
			.connect()
			.then(() => client?.query(`LISTEN ${PROJECT_ENVIRONMENT_SERVICE_CHANNEL}`))
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
			await idleClient.query(`UNLISTEN ${PROJECT_ENVIRONMENT_SERVICE_CHANNEL}`);
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
				select: {
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
				}
			}),
			prisma.projectEnvironmentServiceEvent.findMany({
				where: {
					organizationId: input.organizationId,
					projectId: input.projectId,
					serviceId: input.serviceId,
					seq: { gt: cursor }
				},
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
