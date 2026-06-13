import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env as privateEnv } from '$env/dynamic/private';

type EnvLike = Record<string, string | undefined>;

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

export class ProjectSecretEncryptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectSecretEncryptionError';
	}
}

function getKey(env: EnvLike = privateEnv): Buffer {
	const value = env.PROJECT_SECRET_ENCRYPTION_KEY;
	if (!value) {
		throw new ProjectSecretEncryptionError('PROJECT_SECRET_ENCRYPTION_KEY is required');
	}
	const key = Buffer.from(value, 'base64');
	if (key.length !== 32) {
		throw new ProjectSecretEncryptionError(
			'PROJECT_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key'
		);
	}
	return key;
}

export function encryptProjectSecretValue(value: string, env: EnvLike = privateEnv): string {
	const key = getKey(env);
	const iv = randomBytes(12);
	const cipher = createCipheriv(ALGORITHM, key, iv);
	const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [VERSION, iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(
		':'
	);
}

export function decryptProjectSecretValue(encrypted: string, env: EnvLike = privateEnv): string {
	const [version, ivRaw, tagRaw, ciphertextRaw] = encrypted.split(':');
	if (version !== VERSION || !ivRaw || !tagRaw || !ciphertextRaw) {
		throw new ProjectSecretEncryptionError('Invalid project secret ciphertext');
	}
	const decipher = createDecipheriv(ALGORITHM, getKey(env), Buffer.from(ivRaw, 'base64'));
	decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
	return Buffer.concat([
		decipher.update(Buffer.from(ciphertextRaw, 'base64')),
		decipher.final()
	]).toString('utf8');
}
