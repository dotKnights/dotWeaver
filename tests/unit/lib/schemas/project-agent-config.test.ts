import { describe, it, expect } from 'vitest';
import {
	agentConfigNameSchema,
	envVarKeySchema,
	importProjectEnvFileSchema,
	isSensitiveConfigKey,
	importSkillsShSkillSchema,
	normalizeSkillBody,
	projectEnvVarInputSchema,
	projectMcpServerInputSchema,
	projectSkillInputSchema,
	projectSecretInputSchema,
	skillsShSearchSchema,
	skillsShSkillIdSchema
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

	it('returns false for malformed http and sse urls without throwing', () => {
		for (const input of [
			{
				projectId: 'p1',
				name: 'bad-http-url',
				transport: 'http',
				url: 'not-url',
				env: {}
			},
			{
				projectId: 'p1',
				name: 'bad-sse-url',
				transport: 'sse',
				url: 'not-url',
				env: {}
			}
		]) {
			expect(() => projectMcpServerInputSchema.safeParse(input)).not.toThrow();
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

	it('accepts sensitive headers backed by project secrets', () => {
		const parsed = projectMcpServerInputSchema.safeParse({
			projectId: 'p1',
			name: 'github',
			transport: 'http',
			url: 'https://example.com/mcp',
			headers: { Authorization: { secretName: 'github_token', prefix: 'Bearer ' } },
			env: {}
		});
		expect(parsed.success).toBe(true);
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

describe('skills.sh schemas', () => {
	it('accepts valid search and import inputs', () => {
		expect(skillsShSearchSchema.safeParse({ query: 'sv', limit: 20 }).success).toBe(true);
		expect(skillsShSkillIdSchema.safeParse({ id: 'vercel-labs/skills/find-skills' }).success).toBe(
			true
		);
		expect(
			importSkillsShSkillSchema.safeParse({
				projectId: 'p1',
				id: 'vercel-labs/skills/find-skills',
				replace: false
			}).success
		).toBe(true);
	});

	it('rejects short queries and unsafe skill ids', () => {
		expect(skillsShSearchSchema.safeParse({ query: 's', limit: 20 }).success).toBe(false);
		expect(skillsShSkillIdSchema.safeParse({ id: '../escape' }).success).toBe(false);
		expect(skillsShSkillIdSchema.safeParse({ id: 'owner/repo/../../escape' }).success).toBe(false);
		expect(skillsShSkillIdSchema.safeParse({ id: 'owner/repo/skill name' }).success).toBe(false);
	});
});

describe('envVarKeySchema', () => {
	it('accepts POSIX-style names', () => {
		expect(envVarKeySchema.safeParse('DATABASE_URL').success).toBe(true);
		expect(envVarKeySchema.safeParse('_x9').success).toBe(true);
	});
	it('rejects names starting with a digit or with dashes', () => {
		expect(envVarKeySchema.safeParse('9X').success).toBe(false);
		expect(envVarKeySchema.safeParse('A-B').success).toBe(false);
	});
});

describe('projectEnvVarInputSchema', () => {
	it('accepts a valid input', () => {
		const parsed = projectEnvVarInputSchema.parse({
			projectId: 'p1',
			key: 'API_KEY',
			value: 'secret'
		});
		expect(parsed.key).toBe('API_KEY');
	});
	it('rejects an empty value', () => {
		expect(
			projectEnvVarInputSchema.safeParse({ projectId: 'p1', key: 'A', value: '' }).success
		).toBe(false);
	});
});

describe('importProjectEnvFileSchema', () => {
	it('requires non-empty content', () => {
		expect(importProjectEnvFileSchema.safeParse({ projectId: 'p1', content: '' }).success).toBe(
			false
		);
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
