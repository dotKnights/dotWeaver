import { randomBytes } from 'node:crypto';

export function generatedPassword() {
	return randomBytes(24).toString('base64url');
}

export function asConfigRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

export function validPort(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
}

function hasWhitespaceOrControl(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (
			code <= 0x20 ||
			code === 0x7f ||
			(code >= 0x80 && code <= 0x9f) ||
			code === 0xa0 ||
			code === 0x1680 ||
			(code >= 0x2000 && code <= 0x200a) ||
			code === 0x2028 ||
			code === 0x2029 ||
			code === 0x202f ||
			code === 0x205f ||
			code === 0x3000 ||
			code === 0xfeff
		) {
			return true;
		}
	}
	return false;
}

function validImageReference(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const trimmed = value.trim();
	return (
		value === trimmed &&
		value.length > 0 &&
		!value.startsWith('-') &&
		!hasWhitespaceOrControl(value)
	);
}

export function imageFromConfig(config: Record<string, unknown>, defaultImage: string): string {
	const value = config.image;
	return validImageReference(value) ? value : defaultImage;
}

export function imageValidationErrors(
	config: Record<string, unknown>,
	providerName: string
): string[] {
	if (config.image === undefined) return [];
	if (typeof config.image !== 'string' || config.image.trim().length === 0) {
		return [`${providerName} image is required`];
	}
	if (!validImageReference(config.image)) {
		return [`${providerName} image is invalid`];
	}
	return [];
}
