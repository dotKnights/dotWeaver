import { describe, expect, it } from 'vitest';
import { mergeEnvironmentServiceLivePatch } from '$lib/components/projects/project-environment-services-live.svelte';
import type { EnvironmentServiceSummary } from '$lib/components/projects/environment-setup-state';

describe('project environment services live state', () => {
	it('merges partial live service patches without dropping query fields', () => {
		const service: EnvironmentServiceSummary = {
			id: 'svc1',
			kind: 'postgres',
			name: 'database',
			status: 'configured',
			updatedAt: '2026-06-24T12:00:00.000Z',
			envMappings: [
				{ key: 'DATABASE_URL', template: '${url}', enabled: true, sensitive: 'auto' },
				{ key: 'DIRECT_URL', template: '${url}', enabled: true, sensitive: 'auto' }
			],
			outputs: [{ key: 'DATABASE_URL', sensitive: true, hasValue: true }]
		};

		expect(
			mergeEnvironmentServiceLivePatch(service, {
				id: 'svc1',
				status: 'ready',
				updatedAt: '2026-06-24T12:01:00.000Z'
			})
		).toMatchObject({
			status: 'ready',
			envMappings: service.envMappings,
			outputs: service.outputs
		});
	});

	it('ignores older live service patches', () => {
		const service: EnvironmentServiceSummary = {
			id: 'svc1',
			status: 'ready',
			updatedAt: '2026-06-24T12:01:00.000Z'
		};

		expect(
			mergeEnvironmentServiceLivePatch(service, {
				id: 'svc1',
				status: 'provisioning',
				updatedAt: '2026-06-24T12:00:00.000Z'
			})
		).toBe(service);
	});
});
