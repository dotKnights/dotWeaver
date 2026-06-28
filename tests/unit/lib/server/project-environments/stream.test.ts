import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		projectEnvironmentProfile: { findFirst: vi.fn() },
		projectEnvironmentPrepareEvent: { findMany: vi.fn() }
	}
}));

import { prisma } from '$lib/server/prisma';
import {
	formatNamedSseEvent,
	streamProjectEnvironmentPrepare,
	type ProjectEnvironmentPrepareChangeSource,
	type ProjectEnvironmentPrepareEventRow,
	type ProjectEnvironmentPrepareProfileRow,
	type ProjectEnvironmentPrepareStreamItem
} from '$lib/server/project-environments/stream';
import type { ProjectEnvironmentPrepareNotification } from '$lib/server/project-environments/notifications';

const profileFindFirst = vi.mocked(prisma.projectEnvironmentProfile.findFirst) as unknown as Mock<
	() => Promise<ProjectEnvironmentPrepareProfileRow | null>
>;
const eventFindMany = vi.mocked(prisma.projectEnvironmentPrepareEvent.findMany) as unknown as Mock<
	() => Promise<ProjectEnvironmentPrepareEventRow[]>
>;

function fakeChangeSource() {
	let onChange: ((notification: ProjectEnvironmentPrepareNotification) => void) | null = null;
	const source: ProjectEnvironmentPrepareChangeSource = {
		subscribe: vi.fn(async (callback) => {
			onChange = callback;
			return async () => {
				onChange = null;
			};
		})
	};
	return {
		source,
		emit(notification: ProjectEnvironmentPrepareNotification) {
			onChange?.(notification);
		}
	};
}

describe('project environment prepare stream', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		profileFindFirst.mockResolvedValue({
			id: 'env1',
			name: 'default',
			status: 'detected',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp1',
			lastPreparedFingerprint: null,
			lastPrepareStatus: 'running',
			lastPrepareError: null
		});
		eventFindMany.mockResolvedValue([]);
	});

	it('formats named SSE events with optional id', () => {
		expect(formatNamedSseEvent('profile', { status: 'ready' })).toBe(
			'event: profile\ndata: {"status":"ready"}\n\n'
		);
		expect(formatNamedSseEvent('prepare_event', { seq: 2 }, 2)).toBe(
			'id: 2\nevent: prepare_event\ndata: {"seq":2}\n\n'
		);
	});

	it('streams the current profile, then wakes from a matching Postgres notification', async () => {
		const changes = fakeChangeSource();
		const createdAt = new Date('2026-06-24T12:00:00.000Z');
		eventFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
			{
				id: 'event1',
				seq: 0,
				type: 'system',
				payload: { text: 'Preparing project environment' },
				createdAt
			}
		]);

		const stream = streamProjectEnvironmentPrepare({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'env1',
			changeSource: changes.source,
			pingMs: 60_000
		});

		await expect(stream.next()).resolves.toEqual({
			done: false,
			value: {
				kind: 'profile',
				profile: expect.objectContaining({ id: 'env1', lastPrepareStatus: 'running' })
			} satisfies ProjectEnvironmentPrepareStreamItem
		});

		const next = stream.next();
		changes.emit({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'env1',
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
					payload: { text: 'Preparing project environment' },
					createdAt: createdAt.toISOString()
				}
			} satisfies ProjectEnvironmentPrepareStreamItem
		});
		await stream.return(undefined);
	});

	it('resumes after the Last-Event-ID cursor', async () => {
		const changes = fakeChangeSource();

		const stream = streamProjectEnvironmentPrepare({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'env1',
			fromSeq: 4,
			changeSource: changes.source
		});
		await stream.next();

		expect(eventFindMany).toHaveBeenCalledWith({
			where: { organizationId: 'org1', projectId: 'p1', profileId: 'env1', seq: { gt: 4 } },
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
