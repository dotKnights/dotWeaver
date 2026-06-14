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

	it('throws a clear error when the key is not valid base64', () => {
		expect(() =>
			encryptProjectSecretValue('secret-value', {
				PROJECT_SECRET_ENCRYPTION_KEY: `${env.PROJECT_SECRET_ENCRYPTION_KEY}!`
			})
		).toThrow(ProjectSecretEncryptionError);
	});

	it('throws a clear error when encrypting an empty value', () => {
		expect(() => encryptProjectSecretValue('', env)).toThrow(ProjectSecretEncryptionError);
	});

	it('preserves missing key errors while decrypting', () => {
		const encrypted = encryptProjectSecretValue('secret-value', env);
		expect(() => decryptProjectSecretValue(encrypted, {})).toThrow(
			'PROJECT_SECRET_ENCRYPTION_KEY is required'
		);
	});

	it('preserves invalid key errors while decrypting', () => {
		const encrypted = encryptProjectSecretValue('secret-value', env);
		expect(() =>
			decryptProjectSecretValue(encrypted, {
				PROJECT_SECRET_ENCRYPTION_KEY: `${env.PROJECT_SECRET_ENCRYPTION_KEY}!`
			})
		).toThrow('PROJECT_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
	});

	it('rejects ciphertexts with extra parts', () => {
		const encrypted = encryptProjectSecretValue('secret-value', env);
		expect(() => decryptProjectSecretValue(`${encrypted}:extra`, env)).toThrow(
			ProjectSecretEncryptionError
		);
	});

	it('throws a clear error for malformed ciphertext components', () => {
		const [version, ivRaw, tagRaw, ciphertextRaw] = encryptProjectSecretValue(
			'secret-value',
			env
		).split(':');

		const malformedValues = [
			[version, `${ivRaw}!`, tagRaw, ciphertextRaw],
			[version, ivRaw, `${tagRaw}!`, ciphertextRaw],
			[version, ivRaw, tagRaw, `${ciphertextRaw}!`]
		];

		for (const parts of malformedValues) {
			expect(() => decryptProjectSecretValue(parts.join(':'), env)).toThrow(
				ProjectSecretEncryptionError
			);
		}
	});

	it('throws a clear error for wrong iv or tag lengths', () => {
		const [version, , , ciphertextRaw] = encryptProjectSecretValue('secret-value', env).split(':');
		const shortIv = Buffer.alloc(11, 1).toString('base64');
		const shortTag = Buffer.alloc(15, 2).toString('base64');

		expect(() =>
			decryptProjectSecretValue(
				[version, shortIv, Buffer.alloc(16, 3).toString('base64'), ciphertextRaw].join(':'),
				env
			)
		).toThrow(ProjectSecretEncryptionError);
		expect(() =>
			decryptProjectSecretValue(
				[version, Buffer.alloc(12, 3).toString('base64'), shortTag, ciphertextRaw].join(':'),
				env
			)
		).toThrow(ProjectSecretEncryptionError);
	});
});
