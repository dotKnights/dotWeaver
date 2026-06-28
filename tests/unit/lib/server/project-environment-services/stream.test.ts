import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		projectEnvironmentService: { findFirst: vi.fn() },
		projectEnvironmentServiceEvent: { findMany: vi.fn() }
	}
}));

import { prisma } from '$lib/server/prisma';
import {
	formatNamedSseEvent,
	streamProjectEnvironmentServiceEvents,
	type ProjectEnvironmentServiceChangeSource,
	type ProjectEnvironmentServiceEventRow,
	type ProjectEnvironmentServiceRow,
	type ProjectEnvironmentServiceStreamItem
} from '$lib/server/project-environment-services/stream';
import type { ProjectEnvironmentServiceNotification } from '$lib/server/project-environment-services/notifications';

const serviceFindFirst = vi.mocked(prisma.projectEnvironmentService.findFirst) as unknown as Mock<
	() => Promise<ProjectEnvironmentServiceRow | null>
>;
const eventFindMany = vi.mocked(prisma.projectEnvironmentServiceEvent.findMany) as unknown as Mock<
	() => Promise<ProjectEnvironmentServiceEventRow[]>
>;

function fakeChangeSource() {
	let onChange: ((notification: ProjectEnvironmentServiceNotification) => void) | null = null;
	const source: ProjectEnvironmentServiceChangeSource = {
		subscribe: vi.fn(async (callback) => {
			onChange = callback;
			return async () => {
				onChange = null;
			};
		})
	};
	return {
		source,
		emit(notification: ProjectEnvironmentServiceNotification) {
			onChange?.(notification);
		}
	};
}

describe('project environment service stream', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		serviceFindFirst.mockResolvedValue({
			id: 'svc1',
			profileId: 'env1',
			kind: 'postgres',
			name: 'database',
			enabled: true,
			status: 'provisioning',
			lastError: null,
			lastReadyAt: null,
			updatedAt: new Date('2026-06-24T12:00:00.000Z'),
			config: {},
			outputs: []
		});
		eventFindMany.mockResolvedValue([]);
	});

	it('formats named SSE events with optional id', () => {
		expect(formatNamedSseEvent('service', { status: 'ready' })).toBe(
			'event: service\ndata: {"status":"ready"}\n\n'
		);
		expect(formatNamedSseEvent('service_event', { seq: 2 }, 2)).toBe(
			'id: 2\nevent: service_event\ndata: {"seq":2}\n\n'
		);
	});

	it('streams the current service, then wakes from a matching notification', async () => {
		const changes = fakeChangeSource();
		const createdAt = new Date('2026-06-24T12:01:00.000Z');
		eventFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
			{
				id: 'event1',
				seq: 0,
				type: 'system',
				payload: { text: 'Provisioning postgres service database' },
				createdAt
			}
		]);

		const stream = streamProjectEnvironmentServiceEvents({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'env1',
			serviceId: 'svc1',
			changeSource: changes.source,
			pingMs: 60_000
		});

		await expect(stream.next()).resolves.toEqual({
			done: false,
			value: {
				kind: 'service',
				service: expect.objectContaining({ id: 'svc1', status: 'provisioning' })
			} satisfies ProjectEnvironmentServiceStreamItem
		});

		const next = stream.next();
		changes.emit({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'env1',
			serviceId: 'svc1',
			kind: 'event',
			seq: 0
		});

		await expect(next).resolves.toEqual({
			done: false,
			value: {
				kind: 'event',
				seq: 0,
				event: {
					id: 'event1',
					seq: 0,
					type: 'system',
					payload: { text: 'Provisioning postgres service database' },
					createdAt: createdAt.toISOString()
				}
			} satisfies ProjectEnvironmentServiceStreamItem
		});
		await stream.return(undefined);
	});

	it('streams sanitized service outputs for live provisioning values', async () => {
		const changes = fakeChangeSource();
		serviceFindFirst.mockResolvedValue({
			id: 'svc1',
			profileId: 'env1',
			kind: 'postgres',
			name: 'database',
			enabled: true,
			status: 'ready',
			lastError: null,
			lastReadyAt: new Date('2026-06-24T12:02:00.000Z'),
			updatedAt: new Date('2026-06-24T12:02:00.000Z'),
			config: {},
			outputs: [
				{
					key: 'url',
					value: 'postgresql://dotweaver:secret@postgres.internal:5432/app',
					sensitive: true
				},
				{ key: 'host', value: 'postgres.internal', sensitive: false },
				{ key: 'port', value: '5432', sensitive: false },
				{ key: 'database', value: 'app', sensitive: false },
				{ key: 'user', value: 'dotweaver', sensitive: false },
				{ key: 'password', value: 'secret', sensitive: true }
			]
		});

		const stream = streamProjectEnvironmentServiceEvents({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'env1',
			serviceId: 'svc1',
			changeSource: changes.source,
			pingMs: 60_000
		});

		await expect(stream.next()).resolves.toEqual({
			done: false,
			value: {
				kind: 'service',
				service: expect.objectContaining({
					id: 'svc1',
					status: 'ready',
					outputs: expect.arrayContaining([
						{ key: 'DATABASE_URL', sensitive: true, hasValue: true },
						{ key: 'POSTGRES_HOST', sensitive: false, value: 'postgres.internal' },
						{ key: 'POSTGRES_PORT', sensitive: false, value: '5432' }
					]),
					sourceFields: expect.arrayContaining([
						{ key: 'url', sensitive: true, hasValue: true },
						{ key: 'host', sensitive: false, value: 'postgres.internal' }
					])
				})
			} satisfies ProjectEnvironmentServiceStreamItem
		});
		await stream.return(undefined);
	});

	it('ignores notifications for other services', async () => {
		const changes = fakeChangeSource();
		const controller = new AbortController();
		const stream = streamProjectEnvironmentServiceEvents({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'env1',
			serviceId: 'svc1',
			changeSource: changes.source,
			pingMs: 60_000,
			signal: controller.signal
		});
		await stream.next();

		const next = stream.next();
		changes.emit({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'env1',
			serviceId: 'svc2',
			kind: 'event',
			seq: 0
		});
		controller.abort();

		await expect(next).resolves.toEqual({ done: true, value: undefined });
		await stream.return(undefined);
	});

	it('resumes after the Last-Event-ID cursor', async () => {
		const changes = fakeChangeSource();

		const stream = streamProjectEnvironmentServiceEvents({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'env1',
			serviceId: 'svc1',
			fromSeq: 4,
			changeSource: changes.source
		});
		await stream.next();

		expect(eventFindMany).toHaveBeenCalledWith({
			where: {
				organizationId: 'org1',
				projectId: 'p1',
				serviceId: 'svc1',
				seq: { gt: 4 }
			},
			select: {
				id: true,
				seq: true,
				type: true,
				payload: true,
				createdAt: true
			},
			orderBy: { seq: 'asc' }
		});
		await stream.return(undefined);
	});
});
