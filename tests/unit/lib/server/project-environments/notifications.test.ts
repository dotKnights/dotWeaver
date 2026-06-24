import { describe, expect, it, vi } from 'vitest';

import {
	PROJECT_ENVIRONMENT_PREPARE_CHANNEL,
	notifyProjectEnvironmentPrepare,
	parseProjectEnvironmentPrepareNotification
} from '$lib/server/project-environments/notifications';

describe('project environment prepare notifications', () => {
	it('parses valid notifications and rejects unrelated payloads', () => {
		const payload = {
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'env1',
			kind: 'event',
			seq: 3
		};

		expect(parseProjectEnvironmentPrepareNotification(JSON.stringify(payload))).toEqual(payload);
		expect(parseProjectEnvironmentPrepareNotification(null)).toBeNull();
		expect(parseProjectEnvironmentPrepareNotification('not json')).toBeNull();
		expect(
			parseProjectEnvironmentPrepareNotification(JSON.stringify({ ...payload, seq: -1 }))
		).toBeNull();
		expect(
			parseProjectEnvironmentPrepareNotification(JSON.stringify({ ...payload, kind: 'other' }))
		).toBeNull();
	});

	it('sends pg_notify with the shared channel and serialized payload', async () => {
		const db = {
			$executeRaw: vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => 1)
		};
		const payload = {
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'env1',
			kind: 'profile' as const
		};

		await notifyProjectEnvironmentPrepare(payload, db);

		expect(db.$executeRaw).toHaveBeenCalledTimes(1);
		const [strings, channel, serializedPayload] = db.$executeRaw.mock.calls[0];
		expect(Array.from(strings as TemplateStringsArray).join('?')).toBe('SELECT pg_notify(?, ?)');
		expect(channel).toBe(PROJECT_ENVIRONMENT_PREPARE_CHANNEL);
		expect(JSON.parse(String(serializedPayload))).toEqual(payload);
	});
});
