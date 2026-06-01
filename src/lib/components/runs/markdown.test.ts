import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
	it('renders basic markdown to HTML', () => {
		const html = renderMarkdown('# Title\n\nHello **world**');
		expect(html).toContain('<h1');
		expect(html).toContain('<strong>world</strong>');
	});
	it('strips <script> and on* handlers (XSS)', () => {
		const html = renderMarkdown('<script>alert(1)</script><img src=x onerror="alert(2)">');
		expect(html).not.toContain('<script');
		expect(html.toLowerCase()).not.toContain('onerror');
	});
	it('does not throw on non-string input', () => {
		expect(() => renderMarkdown(undefined as unknown as string)).not.toThrow();
	});
});
