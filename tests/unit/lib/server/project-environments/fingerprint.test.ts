import { describe, expect, it } from 'vitest';
import {
	buildProjectEnvironmentFingerprint,
	needsProjectEnvironmentPrepare
} from '$lib/server/project-environments/fingerprint';

describe('project environment fingerprint', () => {
	it('is stable and excludes env values', () => {
		const first = buildProjectEnvironmentFingerprint({
			adapterId: 'node',
			adapterVersion: '1',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			lockfiles: [{ path: 'bun.lock', content: 'lock-data' }],
			envKeys: ['DATABASE_URL', 'PUBLIC_API_URL']
		});
		const second = buildProjectEnvironmentFingerprint({
			adapterId: 'node',
			adapterVersion: '1',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			lockfiles: [{ path: 'bun.lock', content: 'lock-data' }],
			envKeys: ['PUBLIC_API_URL', 'DATABASE_URL']
		});

		expect(first).toBe(second);
		expect(first).toMatch(/^[a-f0-9]{64}$/);
		expect(first).not.toContain('postgres');
	});

	it('includes service fingerprints without depending on service order', () => {
		const first = buildProjectEnvironmentFingerprint({
			adapterId: 'node',
			adapterVersion: '1',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			lockfiles: [{ path: 'bun.lock', content: 'lock-data' }],
			envKeys: ['DATABASE_URL'],
			services: [
				{
					kind: 'redis',
					name: 'cache',
					enabled: true,
					status: 'ready',
					providerVersion: '1',
					config: { image: 'redis:7-alpine', port: 6379 },
					outputKeys: ['REDIS_URL'],
					outputValueHashes: ['redis-url-hash']
				},
				{
					kind: 'postgres',
					name: 'database',
					enabled: true,
					status: 'ready',
					providerVersion: '1',
					config: { image: 'postgres:17-alpine', port: 5432 },
					outputKeys: ['DATABASE_URL'],
					outputValueHashes: ['database-url-hash']
				}
			]
		});
		const second = buildProjectEnvironmentFingerprint({
			adapterId: 'node',
			adapterVersion: '1',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			lockfiles: [{ path: 'bun.lock', content: 'lock-data' }],
			envKeys: ['DATABASE_URL'],
			services: [
				{
					kind: 'postgres',
					name: 'database',
					enabled: true,
					status: 'ready',
					providerVersion: '1',
					config: { image: 'postgres:17-alpine', port: 5432 },
					outputKeys: ['DATABASE_URL'],
					outputValueHashes: ['database-url-hash']
				},
				{
					kind: 'redis',
					name: 'cache',
					enabled: true,
					status: 'ready',
					providerVersion: '1',
					config: { image: 'redis:7-alpine', port: 6379 },
					outputKeys: ['REDIS_URL'],
					outputValueHashes: ['redis-url-hash']
				}
			]
		});
		const changedServiceValue = buildProjectEnvironmentFingerprint({
			adapterId: 'node',
			adapterVersion: '1',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			lockfiles: [{ path: 'bun.lock', content: 'lock-data' }],
			envKeys: ['DATABASE_URL'],
			services: [
				{
					kind: 'postgres',
					name: 'database',
					enabled: true,
					status: 'ready',
					providerVersion: '1',
					config: { image: 'postgres:17-alpine', port: 5432 },
					outputKeys: ['DATABASE_URL'],
					outputValueHashes: ['changed-database-url-hash']
				},
				{
					kind: 'redis',
					name: 'cache',
					enabled: true,
					status: 'ready',
					providerVersion: '1',
					config: { image: 'redis:7-alpine', port: 6379 },
					outputKeys: ['REDIS_URL'],
					outputValueHashes: ['redis-url-hash']
				}
			]
		});

		expect(first).toBe(second);
		expect(first).not.toBe(changedServiceValue);
		expect(first).toMatch(/^[a-f0-9]{64}$/);
	});

	it('changes service fingerprint when mapped env keys change', () => {
		const base = {
			kind: 'postgres' as const,
			name: 'database',
			enabled: true,
			status: 'ready' as const,
			providerVersion: '1',
			config: { image: 'postgres:17-alpine', port: 5432 },
			outputValueHashes: ['same-value-hash']
		};
		const first = buildProjectEnvironmentFingerprint({
			adapterId: 'node',
			adapterVersion: '1',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			lockfiles: [],
			envKeys: [],
			services: [{ ...base, outputKeys: ['DATABASE_URL'] }]
		});
		const second = buildProjectEnvironmentFingerprint({
			adapterId: 'node',
			adapterVersion: '1',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			lockfiles: [],
			envKeys: [],
			services: [{ ...base, outputKeys: ['DIRECT_URL'] }]
		});

		expect(first).not.toBe(second);
	});

	it('marks prepare as needed unless the previous success matches the current fingerprint', () => {
		expect(
			needsProjectEnvironmentPrepare({
				currentFingerprint: 'a',
				lastPreparedFingerprint: 'a',
				lastPrepareStatus: 'succeeded',
				installCommand: 'bun install'
			})
		).toBe(false);

		expect(
			needsProjectEnvironmentPrepare({
				currentFingerprint: 'b',
				lastPreparedFingerprint: 'a',
				lastPrepareStatus: 'succeeded',
				installCommand: 'bun install'
			})
		).toBe(true);

		expect(
			needsProjectEnvironmentPrepare({
				currentFingerprint: 'a',
				lastPreparedFingerprint: 'a',
				lastPrepareStatus: 'failed',
				installCommand: 'bun install'
			})
		).toBe(true);

		expect(
			needsProjectEnvironmentPrepare({
				currentFingerprint: 'a',
				lastPreparedFingerprint: null,
				lastPrepareStatus: 'never',
				installCommand: ''
			})
		).toBe(false);
	});
});
