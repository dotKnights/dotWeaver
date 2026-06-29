import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env as privateEnv } from '$env/dynamic/private';

type EnvLike = Record<string, string | undefined>;

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const INVALID_CIPHERTEXT_ERROR = 'Invalid project secret ciphertext';
const INVALID_KEY_ERROR = 'PROJECT_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key';

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
	if (!BASE64_PATTERN.test(value)) {
		throw new ProjectSecretEncryptionError(INVALID_KEY_ERROR);
	}
	const key = Buffer.from(value, 'base64');
	if (key.length !== 32) {
		throw new ProjectSecretEncryptionError(INVALID_KEY_ERROR);
	}
	return key;
}

function decodeCiphertextPart(value: string | undefined): Buffer {
	if (!value || !BASE64_PATTERN.test(value)) {
		throw new ProjectSecretEncryptionError(INVALID_CIPHERTEXT_ERROR);
	}
	return Buffer.from(value, 'base64');
}

export function encryptProjectSecretValue(value: string, env: EnvLike = privateEnv): string {
	if (value.length === 0) {
		throw new ProjectSecretEncryptionError('Project secret value is required');
	}
	const key = getKey(env);
	const iv = randomBytes(12);
	const cipher = createCipheriv(ALGORITHM, key, iv);
	const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [
		VERSION,
		iv.toString('base64'),
		tag.toString('base64'),
		encrypted.toString('base64')
	].join(':');
}

export function decryptProjectSecretValue(encrypted: string, env: EnvLike = privateEnv): string {
	const parts = encrypted.split(':');
	if (parts.length !== 4) {
		throw new ProjectSecretEncryptionError(INVALID_CIPHERTEXT_ERROR);
	}
	const [version, ivRaw, tagRaw, ciphertextRaw] = parts;
	if (version !== VERSION) {
		throw new ProjectSecretEncryptionError(INVALID_CIPHERTEXT_ERROR);
	}
	const iv = decodeCiphertextPart(ivRaw);
	const tag = decodeCiphertextPart(tagRaw);
	const ciphertext = decodeCiphertextPart(ciphertextRaw);
	if (iv.length !== 12 || tag.length !== 16) {
		throw new ProjectSecretEncryptionError(INVALID_CIPHERTEXT_ERROR);
	}
	const key = getKey(env);
	try {
		const decipher = createDecipheriv(ALGORITHM, key, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
	} catch {
		throw new ProjectSecretEncryptionError(INVALID_CIPHERTEXT_ERROR);
	}
}
