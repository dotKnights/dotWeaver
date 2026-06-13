import { describe, it, expect } from 'vitest';
import {
	agentConfigNameSchema,
	isSensitiveConfigKey,
	normalizeSkillBody,
	projectMcpServerInputSchema,
	projectSkillInputSchema,
	projectSecretInputSchema
} from '$lib/schemas/project-agent-config';

describe('agent config names', () => {
	it('accepts letters, numbers, underscore and dash', () => {
		for (const name of ['linear', 'github_api', 'svelte-mcp', 'mcp2']) {
			expect(agentConfigNameSchema.safeParse(name).success).toBe(true);
		}
	});

	it('rejects spaces, path traversal, and reserved dotweaver name', () => {
		for (const name of ['linear api', '../secret', 'a/b', 'dotweaver']) {
			expect(agentConfigNameSchema.safeParse(name).success).toBe(false);
		}
	});
});

describe('projectMcpServerInputSchema', () => {
	it('accepts http and sse servers with urls', () => {
		expect(
			projectMcpServerInputSchema.safeParse({
				projectId: 'p1',
				name: 'linear',
				transport: 'http',
				enabled: true,
				url: 'https://mcp.linear.app/mcp',
				headers: { 'x-public-header': 'public' },
				env: { LINEAR_API_KEY: { secretName: 'linear_api_key' } }
			}).success
		).toBe(true);

		expect(
			projectMcpServerInputSchema.safeParse({
				projectId: 'p1',
				name: 'events',
				transport: 'sse',
				url: 'https://example.com/sse',
				env: {}
			}).success
		).toBe(true);
	});

	it('accepts stdio servers with command and args', () => {
		expect(
			projectMcpServerInputSchema.safeParse({
				projectId: 'p1',
				name: 'filesystem',
				transport: 'stdio',
				command: 'node',
				args: ['server.mjs'],
				env: {}
			}).success
		).toBe(true);
	});

	it('rejects missing url or command', () => {
		expect(
			projectMcpServerInputSchema.safeParse({
				projectId: 'p1',
				name: 'bad-http',
				transport: 'http',
				env: {}
			}).success
		).toBe(false);

		expect(
			projectMcpServerInputSchema.safeParse({
				projectId: 'p1',
				name: 'bad-stdio',
				transport: 'stdio',
				env: {}
			}).success
		).toBe(false);
	});

	it('rejects non-http urls for http and sse servers', () => {
		for (const input of [
			{
				projectId: 'p1',
				name: 'ftp-server',
				transport: 'http',
				url: 'ftp://example.com/mcp',
				env: {}
			},
			{
				projectId: 'p1',
				name: 'file-server',
				transport: 'sse',
				url: 'file:///tmp/mcp',
				env: {}
			}
		]) {
			expect(projectMcpServerInputSchema.safeParse(input).success).toBe(false);
		}
	});

	it('rejects sensitive static headers', () => {
		const parsed = projectMcpServerInputSchema.safeParse({
			projectId: 'p1',
			name: 'github',
			transport: 'http',
			url: 'https://example.com/mcp',
			headers: { Authorization: 'Bearer abc' },
			env: {}
		});
		expect(parsed.success).toBe(false);
	});
});

describe('project skills and secrets', () => {
	it('normalizes skill markdown with frontmatter', () => {
		const body = normalizeSkillBody({
			name: 'review',
			description: 'Review code changes',
			body: '## Instructions\n\nReview the diff.'
		});
		expect(body).toContain('---\nname: review\n');
		expect(body).toContain('description: "Review code changes"');
		expect(body).toContain('Review the diff.');
	});

	it('wraps malformed leading frontmatter as skill content', () => {
		const body = normalizeSkillBody({
			name: 'review',
			description: 'Review "quoted" changes',
			body: '---\nmissing closing delimiter\nReview the diff.'
		});
		expect(body).toContain('---\nname: review\n');
		expect(body).toContain('description: "Review \\"quoted\\" changes"');
		expect(body).toContain('---\nmissing closing delimiter\nReview the diff.');
	});

	it('accepts skill and secret inputs', () => {
		expect(
			projectSkillInputSchema.safeParse({
				projectId: 'p1',
				name: 'review',
				description: 'Review changes',
				body: '## Instructions\nReview changes.',
				enabled: true
			}).success
		).toBe(true);

		expect(
			projectSecretInputSchema.safeParse({
				projectId: 'p1',
				name: 'linear_api_key',
				value: 'lin_123'
			}).success
		).toBe(true);
	});

	it('rejects skill descriptions with newlines', () => {
		expect(
			projectSkillInputSchema.safeParse({
				projectId: 'p1',
				name: 'review',
				description: 'Review changes\nwith newline',
				body: '## Instructions\nReview changes.'
			}).success
		).toBe(false);
	});
});

describe('sensitive key detection', () => {
	it('detects auth and token names', () => {
		for (const key of ['Authorization', 'x-api-key', 'access_token', 'client_secret']) {
			expect(isSensitiveConfigKey(key)).toBe(true);
		}
		expect(isSensitiveConfigKey('x-feature-flag')).toBe(false);
	});
});
