import { describe, expect, it } from 'vitest';
import {
	mappingsFor,
	messagesFor,
	outputValue,
	serviceMappingsFor,
	sourceFieldValue
} from '$lib/components/projects/project-environment-services-panel';
import type { EnvironmentServiceSummary } from '$lib/components/projects/environment-setup-state';

describe('project environment services panel helpers', () => {
	it('normalizes editable service mappings', () => {
		const service = {
			id: 'svc1',
			envMappings: [
				{
					key: 'DATABASE_URL',
					template: '{{ outputs.DATABASE_URL }}',
					enabled: true,
					sensitive: true
				},
				{ key: 'REDIS_URL', template: '{{ outputs.REDIS_URL }}' },
				{ key: 'BROKEN', enabled: true },
				null
			]
		} as unknown as EnvironmentServiceSummary;

		expect(serviceMappingsFor(service)).toEqual([
			{
				key: 'DATABASE_URL',
				template: '{{ outputs.DATABASE_URL }}',
				enabled: true,
				sensitive: true
			},
			{
				key: 'REDIS_URL',
				template: '{{ outputs.REDIS_URL }}',
				enabled: true,
				sensitive: 'auto'
			}
		]);
	});

	it('uses a draft while it differs from service mappings', () => {
		const service = {
			id: 'svc1',
			envMappings: [{ key: 'DATABASE_URL', template: '{{ outputs.DATABASE_URL }}' }]
		};
		const draft = [
			{
				key: 'DATABASE_URL',
				template: '{{ outputs.POSTGRES_URL }}',
				enabled: true,
				sensitive: 'auto' as const
			}
		];

		expect(mappingsFor(service, { svc1: draft })).toBe(draft);
		expect(mappingsFor(service, { svc1: serviceMappingsFor(service) })).toEqual(
			serviceMappingsFor(service)
		);
		expect(mappingsFor({ ...service, id: null }, { svc1: draft })).toEqual(
			serviceMappingsFor(service)
		);
	});

	it('normalizes display strings for messages, outputs and source fields', () => {
		expect(messagesFor(['ready', '', null, 'created'])).toEqual(['ready', 'created']);
		expect(outputValue({ key: 'DATABASE_URL', value: 'postgres://db', sensitive: true })).toBe(
			'masked'
		);
		expect(outputValue({ key: 'DATABASE_URL', value: 'postgres://db' })).toBe('postgres://db');
		expect(sourceFieldValue({ key: 'password', sensitive: true, hasValue: true })).toBe('masked');
		expect(sourceFieldValue({ key: 'host', value: 'db', hasValue: true })).toBe('db');
		expect(sourceFieldValue({ key: 'missing', hasValue: false })).toBe('missing');
	});
});
