import { describe, expect, it } from 'vitest';
import {
	CDC_MARKER_END,
	CDC_MARKER_START,
	MAX_CDC_MARKDOWN_LENGTH,
	CdcDocumentError,
	extractLatestCdcDraft,
	validateCdcMarkdown
} from '../../../../src/lib/domain/cdc-document';

const assistantEvent = (seq: number, text: string) => ({
	seq,
	payload: {
		type: 'assistant',
		message: {
			content: [{ type: 'text', text }]
		}
	}
});

describe('cdc-document domain', () => {
	it('extracts the latest complete marked CDC draft', () => {
		const first = `${CDC_MARKER_START}\n# First\n\nOld body\n${CDC_MARKER_END}`;
		const second = `${CDC_MARKER_START}\n# Second\n\nNew body\n${CDC_MARKER_END}`;

		const draft = extractLatestCdcDraft([
			assistantEvent(1, first),
			assistantEvent(2, `${CDC_MARKER_START}\n# Broken`),
			assistantEvent(3, second)
		]);

		expect(draft).toEqual({
			sourceEventSeq: 3,
			title: 'Second',
			markdown: '# Second\n\nNew body'
		});
	});

	it('returns null when no complete marked block exists', () => {
		expect(extractLatestCdcDraft([assistantEvent(1, `${CDC_MARKER_START}\n# Missing end`)])).toBe(
			null
		);
	});

	it('uses a fallback title when the draft has no h1', () => {
		const draft = extractLatestCdcDraft([
			assistantEvent(4, `${CDC_MARKER_START}\nNo h1 here\n${CDC_MARKER_END}`)
		]);

		expect(draft?.title).toBe('Cahier des charges');
		expect(draft?.markdown).toBe('No h1 here');
	});

	it('rejects empty and oversized markdown', () => {
		expect(() => validateCdcMarkdown('')).toThrow(CdcDocumentError);
		expect(() => validateCdcMarkdown('x'.repeat(MAX_CDC_MARKDOWN_LENGTH + 1))).toThrow(
			CdcDocumentError
		);
	});
});
