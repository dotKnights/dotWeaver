import { describe, it, expect } from 'vitest';
import { slugify, resolveSlug } from './slug';

describe('slugify', () => {
	it('lowercases and hyphenates', () => {
		expect(slugify('Mon Équipe')).toBe('mon-equipe');
	});

	it('strips punctuation and collapses spaces', () => {
		expect(slugify('  Hello, World!!  ')).toBe('hello-world');
	});

	it('falls back to "team" when empty', () => {
		expect(slugify('!!!')).toBe('team');
	});
});

describe('resolveSlug', () => {
	it('returns the base slug when free', async () => {
		const exists = async () => false;
		expect(await resolveSlug('Acme', exists)).toBe('acme');
	});

	it('appends -2 when the base is taken', async () => {
		const taken = new Set(['acme']);
		const exists = async (s: string) => taken.has(s);
		expect(await resolveSlug('Acme', exists)).toBe('acme-2');
	});

	it('increments until a free slug is found', async () => {
		const taken = new Set(['acme', 'acme-2', 'acme-3']);
		const exists = async (s: string) => taken.has(s);
		expect(await resolveSlug('Acme', exists)).toBe('acme-4');
	});
});
