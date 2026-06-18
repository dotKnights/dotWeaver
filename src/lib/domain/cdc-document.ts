export const CDC_MARKER_START = '<!-- dotweaver:cdc:start -->';
export const CDC_MARKER_END = '<!-- dotweaver:cdc:end -->';
export const MAX_CDC_MARKDOWN_LENGTH = 120_000;
const DEFAULT_CDC_TITLE = 'Cahier des charges';

export class CdcDocumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CdcDocumentError';
	}
}

export type CdcDraftEvent = {
	seq: number;
	payload: unknown;
};

export type ExtractedCdcDraft = {
	sourceEventSeq: number;
	title: string;
	markdown: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function extractTextFromPayload(payload: unknown): string {
	const record = asRecord(payload);
	if (!record) return '';

	const directText = record.text;
	if (typeof directText === 'string') return directText;

	const message = asRecord(record.message);
	const content = Array.isArray(message?.content) ? message.content : [];
	return content
		.map((item) => {
			const itemRecord = asRecord(item);
			return typeof itemRecord?.text === 'string' ? itemRecord.text : '';
		})
		.filter(Boolean)
		.join('\n');
}

function lastMarkedBlock(text: string): string | null {
	const start = text.lastIndexOf(CDC_MARKER_START);
	if (start < 0) return null;
	const bodyStart = start + CDC_MARKER_START.length;
	const end = text.indexOf(CDC_MARKER_END, bodyStart);
	if (end < 0) return null;
	return text.slice(bodyStart, end);
}

export function validateCdcMarkdown(markdown: string): string {
	const normalized = markdown.trim();
	if (normalized.length === 0) {
		throw new CdcDocumentError('CDC markdown is empty');
	}
	if (normalized.length > MAX_CDC_MARKDOWN_LENGTH) {
		throw new CdcDocumentError(
			`CDC markdown is too large; max is ${MAX_CDC_MARKDOWN_LENGTH} characters`
		);
	}
	return normalized;
}

export function titleFromCdcMarkdown(markdown: string): string {
	const h1 = markdown
		.split('\n')
		.map((line) => line.trim())
		.find((line) => line.startsWith('# ') && line.slice(2).trim().length > 0);
	return h1 ? h1.slice(2).trim().slice(0, 160) : DEFAULT_CDC_TITLE;
}

export function extractLatestCdcDraft(events: CdcDraftEvent[]): ExtractedCdcDraft | null {
	for (const event of [...events].sort((a, b) => b.seq - a.seq)) {
		const text = extractTextFromPayload(event.payload);
		const block = lastMarkedBlock(text);
		if (!block) continue;
		const markdown = validateCdcMarkdown(block);
		return {
			sourceEventSeq: event.seq,
			title: titleFromCdcMarkdown(markdown),
			markdown
		};
	}
	return null;
}
