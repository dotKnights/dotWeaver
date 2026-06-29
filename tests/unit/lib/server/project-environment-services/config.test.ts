import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	encryptProjectSecretValue: vi.fn(),
	decryptProjectSecretValue: vi.fn()
}));

vi.mock('$lib/server/project-agent-config/encryption', () => ({
	encryptProjectSecretValue: mocks.encryptProjectSecretValue,
	decryptProjectSecretValue: mocks.decryptProjectSecretValue
}));

import {
	decryptStoredConfig,
	encryptSensitiveConfig,
	sanitizeServiceForPublicWithMappings,
	storedOutputs
} from '$lib/server/project-environment-services/config';
import { ProjectEnvironmentServiceError } from '$lib/server/project-environment-services/errors';

describe('project environment service config helpers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.encryptProjectSecretValue.mockImplementation((value: string) => `encrypted:${value}`);
		mocks.decryptProjectSecretValue.mockImplementation((value: string) =>
			value.startsWith('encrypted:') ? value.slice('encrypted:'.length) : value
		);
	});

	it('encrypts and decrypts sensitive config values recursively', () => {
		const encrypted = encryptSensitiveConfig({
			image: 'postgres:test',
			password: 'secret',
			nested: {
				apiToken: 'token',
				host: 'db.internal'
			}
		});

		expect(encrypted).toEqual({
			image: 'postgres:test',
			password: { encrypted: true, valueEncrypted: 'encrypted:secret' },
			nested: {
				apiToken: { encrypted: true, valueEncrypted: 'encrypted:token' },
				host: 'db.internal'
			}
		});
		expect(decryptStoredConfig(encrypted)).toEqual({
			image: 'postgres:test',
			password: 'secret',
			nested: {
				apiToken: 'token',
				host: 'db.internal'
			}
		});
	});

	it('reads stored outputs in stable key order', () => {
		expect(
			storedOutputs([
				{ key: 'host', value: 'db.internal', sensitive: false },
				{ key: 'url', valueEncrypted: 'encrypted:postgres://secret@db/app', sensitive: true }
			])
		).toEqual([
			{ key: 'host', value: 'db.internal', sensitive: false },
			{ key: 'url', value: 'postgres://secret@db/app', sensitive: true }
		]);

		expect(() => storedOutputs([{ key: 'url', sensitive: true }])).toThrow(
			ProjectEnvironmentServiceError
		);
	});

	it('sanitizes public service config, mappings and resolved outputs', () => {
		const result = sanitizeServiceForPublicWithMappings({
			id: 'svc1',
			kind: 'postgres' as const,
			config: {
				password: { encrypted: true, valueEncrypted: 'encrypted:secret' },
				envMappings: [
					{
						key: 'DATABASE_URL',
						template: 'postgres://literal-secret@${host}/app',
						enabled: true,
						sensitive: 'auto' as const
					}
				]
			},
			outputs: [{ key: 'host', value: 'db.internal', sensitive: false }]
		});

		expect(result).toMatchObject({
			config: {
				password: { sensitive: true, hasValue: true }
			},
			envMappings: [
				{ key: 'DATABASE_URL', template: '${masked}', enabled: true, sensitive: 'auto' }
			],
			outputs: [{ key: 'DATABASE_URL', sensitive: true, hasValue: true }],
			mappingWarnings: [],
			mappingErrors: []
		});
		expect(JSON.stringify(result)).not.toContain('literal-secret');
		expect(JSON.stringify(result)).not.toContain('secret');
	});
});
