import { describe, expect, it } from 'vitest';
import {
	defaultServiceEnvMappings,
	extractTemplateFieldNames,
	resolveServiceEnvMappings,
	serviceSourceFieldsFromOutputs,
	validateServiceEnvMappings
} from '$lib/server/project-environment-services/env-mapping';
import type { PlainServiceOutput } from '$lib/server/project-environment-services/types';

const postgresSources: PlainServiceOutput[] = [
	{ key: 'url', value: 'postgresql://user:secret@db:5432/app', sensitive: true },
	{ key: 'protocol', value: 'postgresql', sensitive: false },
	{ key: 'host', value: 'db', sensitive: false },
	{ key: 'port', value: '5432', sensitive: false },
	{ key: 'database', value: 'app', sensitive: false },
	{ key: 'user', value: 'user', sensitive: false },
	{ key: 'password', value: 'secret', sensitive: true }
];

describe('service env mappings', () => {
	it('extracts template field names in first-seen order', () => {
		expect(extractTemplateFieldNames('${user}:${password}@${host}:${port}/${database}')).toEqual([
			'user',
			'password',
			'host',
			'port',
			'database'
		]);
		expect(extractTemplateFieldNames('${url}-${url}-${host}')).toEqual(['url', 'host']);
	});

	it('resolves composed postgres templates and infers sensitivity', () => {
		const result = resolveServiceEnvMappings({
			kind: 'postgres',
			sources: postgresSources,
			mappings: [
				{
					key: 'DATABASE_URL',
					template: '${protocol}://${user}:${password}@${host}:${port}/${database}',
					enabled: true,
					sensitive: 'auto'
				},
				{ key: 'DB_HOST', template: '${host}', enabled: true, sensitive: 'auto' },
				{ key: 'DISABLED_URL', template: '${url}', enabled: false, sensitive: 'auto' }
			]
		});

		expect(result.env).toEqual([
			{
				key: 'DATABASE_URL',
				value: 'postgresql://user:secret@db:5432/app',
				sensitive: true,
				template: '${protocol}://${user}:${password}@${host}:${port}/${database}',
				sourceKeys: ['protocol', 'user', 'password', 'host', 'port', 'database']
			},
			{
				key: 'DB_HOST',
				value: 'db',
				sensitive: false,
				template: '${host}',
				sourceKeys: ['host']
			}
		]);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it('uses provider standard mappings when no explicit mappings are stored', () => {
		expect(defaultServiceEnvMappings('postgres').map((mapping) => mapping.key)).toEqual([
			'DATABASE_URL',
			'POSTGRES_HOST',
			'POSTGRES_PORT',
			'POSTGRES_DB',
			'POSTGRES_USER',
			'POSTGRES_PASSWORD'
		]);
		expect(defaultServiceEnvMappings('redis').map((mapping) => mapping.key)).toEqual([
			'REDIS_URL',
			'REDIS_HOST',
			'REDIS_PORT',
			'REDIS_PASSWORD'
		]);
	});

	it('maps legacy stored outputs to canonical source fields', () => {
		const legacy = serviceSourceFieldsFromOutputs('postgres', [
			{ key: 'DATABASE_URL', value: 'postgresql://user:secret@db:5432/app', sensitive: true },
			{ key: 'POSTGRES_HOST', value: 'db', sensitive: false },
			{ key: 'POSTGRES_PORT', value: '5432', sensitive: false },
			{ key: 'POSTGRES_DB', value: 'app', sensitive: false },
			{ key: 'POSTGRES_USER', value: 'user', sensitive: false },
			{ key: 'POSTGRES_PASSWORD', value: 'secret', sensitive: true }
		]);

		expect(legacy.map((source) => source.key)).toEqual([
			'url',
			'host',
			'port',
			'database',
			'user',
			'password'
		]);
	});

	it('reports validation errors for bad mappings', () => {
		const result = validateServiceEnvMappings('postgres', [
			{ key: '1_BAD', template: '${url}', enabled: true, sensitive: 'auto' },
			{ key: 'DATABASE_URL', template: '${missing}', enabled: true, sensitive: 'auto' },
			{ key: 'DATABASE_URL', template: '${host}', enabled: true, sensitive: 'auto' },
			{ key: 'PASSWORD_LEAK', template: '${password}', enabled: true, sensitive: false }
		]);

		expect(result.errors).toEqual([
			'Mapping 1_BAD has an invalid env var name',
			'Mapping DATABASE_URL references unknown source field missing',
			'Mapping DATABASE_URL is duplicated',
			'Mapping PASSWORD_LEAK uses sensitive source password and cannot be marked non-sensitive'
		]);
	});

	it('warns when a generated variable is overridden by manual env', () => {
		const result = resolveServiceEnvMappings({
			kind: 'postgres',
			sources: postgresSources,
			mappings: [{ key: 'DATABASE_URL', template: '${url}', enabled: true, sensitive: 'auto' }],
			manualEnvKeys: ['DATABASE_URL']
		});

		expect(result.warnings).toEqual([
			'Generated env DATABASE_URL is overridden by a manual project env var'
		]);
	});
});
