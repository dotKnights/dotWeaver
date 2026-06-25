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
			'protocol',
			'host',
			'port',
			'database',
			'user',
			'password'
		]);
		expect(legacy.find((source) => source.key === 'protocol')).toMatchObject({
			value: 'postgresql',
			sensitive: false
		});
	});

	it('maps redis legacy stored outputs to canonical source fields with protocol', () => {
		const legacy = serviceSourceFieldsFromOutputs('redis', [
			{ key: 'REDIS_URL', value: 'redis://:secret@cache:6379', sensitive: true },
			{ key: 'REDIS_HOST', value: 'cache', sensitive: false },
			{ key: 'REDIS_PORT', value: '6379', sensitive: false },
			{ key: 'REDIS_PASSWORD', value: 'secret', sensitive: true }
		]);

		expect(legacy.map((source) => source.key)).toEqual([
			'url',
			'protocol',
			'host',
			'port',
			'password'
		]);
		expect(legacy.find((source) => source.key === 'protocol')).toMatchObject({
			value: 'redis',
			sensitive: false
		});
	});

	it('resolves protocol templates from postgres and redis legacy aliases', () => {
		const postgresLegacy = serviceSourceFieldsFromOutputs('postgres', [
			{ key: 'DATABASE_URL', value: 'postgresql://user:secret@db:5432/app', sensitive: true }
		]);
		const redisLegacy = serviceSourceFieldsFromOutputs('redis', [
			{ key: 'REDIS_URL', value: 'redis://:secret@cache:6379', sensitive: true }
		]);

		expect(
			resolveServiceEnvMappings({
				kind: 'postgres',
				sources: postgresLegacy,
				mappings: [
					{ key: 'DB_PROTOCOL', template: '${protocol}', enabled: true, sensitive: 'auto' }
				]
			}).env
		).toEqual([
			{
				key: 'DB_PROTOCOL',
				value: 'postgresql',
				sensitive: false,
				template: '${protocol}',
				sourceKeys: ['protocol']
			}
		]);
		expect(
			resolveServiceEnvMappings({
				kind: 'redis',
				sources: redisLegacy,
				mappings: [
					{ key: 'REDIS_PROTOCOL', template: '${protocol}', enabled: true, sensitive: 'auto' }
				]
			}).env
		).toEqual([
			{
				key: 'REDIS_PROTOCOL',
				value: 'redis',
				sensitive: false,
				template: '${protocol}',
				sourceKeys: ['protocol']
			}
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

	it('reports validation errors for malformed placeholders', () => {
		const result = validateServiceEnvMappings('postgres', [
			{ key: 'DB_HOST', template: '${db-host}', enabled: true, sensitive: 'auto' },
			{ key: 'DB_PASSWORD', template: '${password', enabled: true, sensitive: 'auto' }
		]);

		expect(result.errors).toEqual([
			'Mapping DB_HOST has malformed template placeholder ${db-host}',
			'Mapping DB_PASSWORD has malformed template placeholder ${password'
		]);
	});

	it('infers sensitivity from canonical sensitive keys even when sources are marked non-sensitive', () => {
		const result = resolveServiceEnvMappings({
			kind: 'postgres',
			sources: [
				{ key: 'url', value: 'postgresql://user:secret@db:5432/app', sensitive: false },
				{ key: 'password', value: 'secret', sensitive: false }
			],
			mappings: [
				{ key: 'DATABASE_URL', template: '${url}', enabled: true, sensitive: 'auto' },
				{ key: 'DATABASE_PASSWORD', template: '${password}', enabled: true, sensitive: 'auto' }
			]
		});

		expect(result.env.map((env) => ({ key: env.key, sensitive: env.sensitive }))).toEqual([
			{ key: 'DATABASE_URL', sensitive: true },
			{ key: 'DATABASE_PASSWORD', sensitive: true }
		]);
	});

	it('preserves override warnings when known source fields are missing', () => {
		const result = resolveServiceEnvMappings({
			kind: 'postgres',
			sources: [{ key: 'url', value: 'postgresql://user:secret@db:5432/app', sensitive: true }],
			mappings: [
				{ key: 'DATABASE_URL', template: '${url}', enabled: true, sensitive: 'auto' },
				{ key: 'DATABASE_HOST', template: '${host}', enabled: true, sensitive: 'auto' },
				{ key: 'DATABASE_PROTOCOL', template: '${protocol}', enabled: true, sensitive: 'auto' }
			],
			manualEnvKeys: ['DATABASE_URL']
		});

		expect(result).toEqual({
			env: [],
			errors: [
				'Mapping DATABASE_HOST references missing source field host',
				'Mapping DATABASE_PROTOCOL references missing source field protocol'
			],
			warnings: ['Generated env DATABASE_URL is overridden by a manual project env var']
		});
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
