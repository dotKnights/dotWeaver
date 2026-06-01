import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

/** Rend du markdown en HTML sanitizé. Ne lève jamais (repli sur texte échappé). */
export function renderMarkdown(source: string): string {
	try {
		const raw = marked.parse(typeof source === 'string' ? source : String(source ?? ''), {
			async: false,
			breaks: true
		}) as string;
		return DOMPurify.sanitize(raw);
	} catch {
		return String(source ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}
}
