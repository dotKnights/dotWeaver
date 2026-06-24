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
