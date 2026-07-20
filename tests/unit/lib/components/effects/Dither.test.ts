import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { describe, expect, test } from 'vitest';

describe('Dither', () => {
	test('compiles as a Svelte 5 component', () => {
		const source = readFileSync(
			new URL('../../../../../src/lib/components/effects/Dither.svelte', import.meta.url),
			'utf8'
		);

		expect(() => compile(source, { filename: 'Dither.svelte', generate: 'client' })).not.toThrow();
	});
});
