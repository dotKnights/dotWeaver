import { describe, it, expect } from 'vitest';
import {
	decryptProjectSecretValue,
	encryptProjectSecretValue,
	ProjectSecretEncryptionError
} from '$lib/server/project-agent-config-encryption';

const env = {
	PROJECT_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64')
};

describe('project secret encryption', () => {
	it('encrypts and decrypts a value', () => {
		const encrypted = encryptProjectSecretValue('secret-value', env);
		expect(encrypted).toMatch(/^v1:/);
		expect(encrypted).not.toContain('secret-value');
		expect(decryptProjectSecretValue(encrypted, env)).toBe('secret-value');
	});

	it('uses a random iv for each encryption', () => {
		const first = encryptProjectSecretValue('secret-value', env);
		const second = encryptProjectSecretValue('secret-value', env);
		expect(first).not.toBe(second);
	});

	it('throws a clear error when the key is missing', () => {
		expect(() => encryptProjectSecretValue('secret-value', {})).toThrow(
			ProjectSecretEncryptionError
		);
	});
});
