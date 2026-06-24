import { describe, expect, it, vi } from 'vitest';

import {
	PROJECT_ENVIRONMENT_SERVICE_CHANNEL,
	notifyProjectEnvironmentService,
	parseProjectEnvironmentServiceNotification
} from '$lib/server/project-environment-services/notifications';

describe('project environment service notifications', () => {
	it('parses valid notifications and rejects unrelated payloads', () => {
		const eventPayload = {
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'env1',
			serviceId: 'svc1',
			kind: 'event' as const,
			seq: 3
		};
		const servicePayload = {
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'env1',
			serviceId: 'svc1',
			kind: 'service' as const
		};

		expect(parseProjectEnvironmentServiceNotification(JSON.stringify(eventPayload))).toEqual(
			eventPayload
		);
		expect(parseProjectEnvironmentServiceNotification(JSON.stringify(servicePayload))).toEqual(
			servicePayload
		);
		expect(parseProjectEnvironmentServiceNotification(null)).toBeNull();
		expect(parseProjectEnvironmentServiceNotification('not json')).toBeNull();
		expect(parseProjectEnvironmentServiceNotification(JSON.stringify([]))).toBeNull();
		expect(
			parseProjectEnvironmentServiceNotification(
				JSON.stringify({ ...eventPayload, organizationId: '' })
			)
		).toBeNull();
		expect(
			parseProjectEnvironmentServiceNotification(JSON.stringify({ ...eventPayload, serviceId: '' }))
		).toBeNull();
		expect(
			parseProjectEnvironmentServiceNotification(JSON.stringify({ ...eventPayload, kind: 'other' }))
		).toBeNull();
		expect(
			parseProjectEnvironmentServiceNotification(JSON.stringify({ ...eventPayload, seq: -1 }))
		).toBeNull();
		expect(
			parseProjectEnvironmentServiceNotification(JSON.stringify({ ...eventPayload, seq: 1.5 }))
		).toBeNull();
		expect(
			parseProjectEnvironmentServiceNotification(JSON.stringify({ ...eventPayload, seq: '1' }))
		).toBeNull();
	});

	it('sends pg_notify with the shared channel and serialized payload', async () => {
		const db = {
			$executeRaw: vi.fn(async () => 1)
		};
		const payload = {
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'env1',
			serviceId: 'svc1',
			kind: 'service' as const
		};

		await notifyProjectEnvironmentService(payload, db);

		expect(db.$executeRaw).toHaveBeenCalledTimes(1);
		const [strings, channel, serializedPayload] = db.$executeRaw.mock.calls[0];
		expect(Array.from(strings as TemplateStringsArray).join('?')).toBe('SELECT pg_notify(?, ?)');
		expect(channel).toBe(PROJECT_ENVIRONMENT_SERVICE_CHANNEL);
		expect(JSON.parse(String(serializedPayload))).toEqual(payload);
	});
});
