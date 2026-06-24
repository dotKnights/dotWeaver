import { describe, expect, it } from 'vitest';
import {
	PROJECT_ENVIRONMENT_SERVICE_KINDS,
	PROJECT_ENVIRONMENT_SERVICE_STATUSES
} from '$lib/domain/project-environment-service';
import {
	projectEnvironmentServiceCreateSchema,
	projectEnvironmentServiceMutationSchema
} from '$lib/schemas/project-environment-services';

describe('project environment service schemas', () => {
	it('defines the first supported service kinds and statuses', () => {
		expect(PROJECT_ENVIRONMENT_SERVICE_KINDS).toEqual(['postgres', 'redis']);
		expect(PROJECT_ENVIRONMENT_SERVICE_STATUSES).toEqual([
			'configured',
			'provisioning',
			'ready',
			'failed',
			'disabled'
		]);
	});

	it('accepts create input for postgres and redis', () => {
		expect(
			projectEnvironmentServiceCreateSchema.parse({
				projectId: 'p1',
				profileId: 'env1',
				kind: 'postgres'
			})
		).toEqual({
			projectId: 'p1',
			profileId: 'env1',
			kind: 'postgres',
			name: 'postgres'
		});
		expect(
			projectEnvironmentServiceCreateSchema.parse({
				projectId: 'p1',
				profileId: 'env1',
				kind: 'redis',
				name: 'cache'
			}).name
		).toBe('cache');
	});

	it('rejects unsafe service names', () => {
		expect(() =>
			projectEnvironmentServiceCreateSchema.parse({
				projectId: 'p1',
				profileId: 'env1',
				kind: 'postgres',
				name: '../db'
			})
		).toThrow();
	});

	it('validates mutation ids', () => {
		expect(
			projectEnvironmentServiceMutationSchema.parse({
				projectId: 'p1',
				profileId: 'env1',
				serviceId: 'svc1'
			})
		).toEqual({ projectId: 'p1', profileId: 'env1', serviceId: 'svc1' });
	});
});
