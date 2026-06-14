import { describe, expect, it } from 'vitest';
import { parseDotenv, mergeDotenv } from '$lib/server/dotenv';

describe('parseDotenv', () => {
	it('parses simple key=value pairs', () => {
		expect(parseDotenv('FOO=bar\nBAZ=qux')).toEqual([
			{ key: 'FOO', value: 'bar' },
			{ key: 'BAZ', value: 'qux' }
		]);
	});

	it('ignores blank lines and # comments', () => {
		expect(parseDotenv('\n# a comment\nFOO=bar\n')).toEqual([{ key: 'FOO', value: 'bar' }]);
	});

	it('strips the export prefix', () => {
		expect(parseDotenv('export FOO=bar')).toEqual([{ key: 'FOO', value: 'bar' }]);
	});

	it('strips surrounding single and double quotes', () => {
		expect(parseDotenv('A="one"\nB=\'two\'')).toEqual([
			{ key: 'A', value: 'one' },
			{ key: 'B', value: 'two' }
		]);
	});

	it('keeps the full value when it contains = signs', () => {
		expect(parseDotenv('URL=postgres://u:p@h/db?x=1')).toEqual([
			{ key: 'URL', value: 'postgres://u:p@h/db?x=1' }
		]);
	});

	it('skips lines with invalid keys', () => {
		expect(parseDotenv('1BAD=x\nGOOD=y')).toEqual([{ key: 'GOOD', value: 'y' }]);
	});
});

describe('mergeDotenv', () => {
	it('replaces an existing managed key in place', () => {
		expect(mergeDotenv('FOO=old\nBAR=keep', [{ key: 'FOO', value: 'new' }])).toBe(
			'FOO=new\nBAR=keep\n'
		);
	});

	it('appends new keys under a managed block', () => {
		expect(mergeDotenv('BAR=keep', [{ key: 'FOO', value: 'new' }])).toBe(
			'BAR=keep\n\n# dotWeaver managed\nFOO=new\n'
		);
	});

	it('quotes values that contain spaces or #', () => {
		expect(mergeDotenv('', [{ key: 'A', value: 'two words' }])).toBe(
			'\n# dotWeaver managed\nA="two words"\n'
		);
	});

	it('returns only the managed block when there is no existing content', () => {
		expect(mergeDotenv('', [{ key: 'A', value: 'b' }])).toBe('\n# dotWeaver managed\nA=b\n');
	});

	it('preserves comments and unmanaged lines', () => {
		expect(mergeDotenv('# header\nKEEP=1\n', [{ key: 'NEW', value: '2' }])).toBe(
			'# header\nKEEP=1\n\n# dotWeaver managed\nNEW=2\n'
		);
	});
});
