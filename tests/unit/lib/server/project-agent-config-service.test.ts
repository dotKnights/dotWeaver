import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	projectFindFirst: vi.fn(),
	mcpFindMany: vi.fn(),
	mcpUpsert: vi.fn(),
	skillFindMany: vi.fn(),
	skillUpsert: vi.fn(),
	secretFindMany: vi.fn(),
	secretUpsert: vi.fn()
}));

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		project: { findFirst: mocks.projectFindFirst },
		projectMcpServer: { findMany: mocks.mcpFindMany, upsert: mocks.mcpUpsert },
		projectSkill: { findMany: mocks.skillFindMany, upsert: mocks.skillUpsert },
		projectSecret: { findMany: mocks.secretFindMany, upsert: mocks.secretUpsert }
	}
}));

vi.mock('$env/dynamic/private', () => ({
	env: { PROJECT_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') }
}));

import { encryptProjectSecretValue } from '$lib/server/project-agent-config-encryption';
import {
	buildRunAgentConfig,
	listProjectAgentConfigForOrg,
	materializeRunAgentConfig,
	ProjectAgentConfigError,
	upsertProjectMcpServerForOrg,
	upsertProjectSecretForOrg,
	upsertProjectSkillForOrg
} from '$lib/server/project-agent-config-service';

let tempDir: string | undefined;

describe('project-agent-config-service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.projectFindFirst.mockResolvedValue({ id: 'p1' });
		mocks.mcpFindMany.mockResolvedValue([]);
		mocks.skillFindMany.mockResolvedValue([]);
		mocks.secretFindMany.mockResolvedValue([]);
	});

	afterEach(async () => {
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it('lists config scoped to an organization and masks secrets', async () => {
		mocks.mcpFindMany.mockResolvedValue([
			{
				id: 'm1',
				projectId: 'p1',
				organizationId: 'org1',
				name: 'linear',
				transport: 'http',
				enabled: true,
				config: { url: 'https://mcp.linear.app/mcp', headers: {} },
				env: { LINEAR_API_KEY: { secretName: 'linear_api_key' } }
			}
		]);
		mocks.skillFindMany.mockResolvedValue([
			{
				id: 'sk1',
				projectId: 'p1',
				organizationId: 'org1',
				name: 'review',
				enabled: true,
				description: 'Review changes',
				body: 'Review changes.'
			}
		]);
		mocks.secretFindMany.mockResolvedValue([{ id: 's1', name: 'linear_api_key' }]);

		const result = await listProjectAgentConfigForOrg('org1', 'p1');

		expect(mocks.projectFindFirst).toHaveBeenCalledWith({
			where: { id: 'p1', organizationId: 'org1' },
			select: { id: true }
		});
		expect(mocks.mcpFindMany).toHaveBeenCalledWith({
			where: { organizationId: 'org1', projectId: 'p1' },
			orderBy: { name: 'asc' }
		});
		expect(mocks.secretFindMany).toHaveBeenCalledWith({
			where: { organizationId: 'org1', projectId: 'p1' },
			orderBy: { name: 'asc' },
			select: { id: true, name: true }
		});
		expect(result.mcpServers).toHaveLength(1);
		expect(result.skills).toHaveLength(1);
		expect(result.secrets).toEqual([{ id: 's1', name: 'linear_api_key', hasValue: true }]);
		expect(JSON.stringify(result.secrets)).not.toContain('valueEncrypted');
	});

	it('upserts an MCP server after verifying the project is in the organization', async () => {
		mocks.mcpUpsert.mockResolvedValue({ id: 'm1' });

		await expect(
			upsertProjectMcpServerForOrg('org1', {
				projectId: 'p1',
				name: 'linear',
				transport: 'http',
				enabled: true,
				url: 'https://mcp.linear.app/mcp',
				headers: { 'x-public': 'yes' },
				env: { LINEAR_API_KEY: { secretName: 'linear_api_key' } }
			})
		).resolves.toEqual({ id: 'm1' });

		expect(mocks.projectFindFirst).toHaveBeenCalledWith({
			where: { id: 'p1', organizationId: 'org1' },
			select: { id: true }
		});
		expect(mocks.mcpUpsert).toHaveBeenCalledWith({
			where: { projectId_name: { projectId: 'p1', name: 'linear' } },
			create: {
				projectId: 'p1',
				organizationId: 'org1',
				name: 'linear',
				transport: 'http',
				enabled: true,
				config: { url: 'https://mcp.linear.app/mcp', headers: { 'x-public': 'yes' } },
				env: { LINEAR_API_KEY: { secretName: 'linear_api_key' } }
			},
			update: {
				transport: 'http',
				enabled: true,
				config: { url: 'https://mcp.linear.app/mcp', headers: { 'x-public': 'yes' } },
				env: { LINEAR_API_KEY: { secretName: 'linear_api_key' } }
			}
		});
	});

	it('upserts a skill with normalized frontmatter after verifying the project', async () => {
		mocks.skillUpsert.mockResolvedValue({ id: 'sk1' });

		await upsertProjectSkillForOrg('org1', {
			projectId: 'p1',
			name: 'review',
			enabled: true,
			description: 'Review changes',
			body: 'Review changes.'
		});

		expect(mocks.skillUpsert).toHaveBeenCalledWith({
			where: { projectId_name: { projectId: 'p1', name: 'review' } },
			create: {
				projectId: 'p1',
				organizationId: 'org1',
				name: 'review',
				enabled: true,
				description: 'Review changes',
				body: '---\nname: review\ndescription: "Review changes"\n---\n\nReview changes.\n',
				source: 'manual'
			},
			update: {
				enabled: true,
				description: 'Review changes',
				body: '---\nname: review\ndescription: "Review changes"\n---\n\nReview changes.\n'
			}
		});
	});

	it('upserts a secret with an encrypted value after verifying the project', async () => {
		mocks.secretUpsert.mockResolvedValue({ id: 's1' });

		await upsertProjectSecretForOrg('org1', 'user1', {
			projectId: 'p1',
			name: 'linear_api_key',
			value: 'lin_123'
		});

		expect(mocks.secretUpsert).toHaveBeenCalledOnce();
		const call = mocks.secretUpsert.mock.calls[0][0];
		expect(call.where).toEqual({ projectId_name: { projectId: 'p1', name: 'linear_api_key' } });
		expect(call.create).toMatchObject({
			projectId: 'p1',
			organizationId: 'org1',
			name: 'linear_api_key',
			createdById: 'user1'
		});
		expect(call.create.valueEncrypted).toMatch(/^v1:/);
		expect(call.update.valueEncrypted).toMatch(/^v1:/);
		expect(call.create.valueEncrypted).not.toContain('lin_123');
		expect(call.update.valueEncrypted).not.toContain('lin_123');
	});

	it('returns an empty runtime projection when config is disabled for the run', async () => {
		const result = await buildRunAgentConfig('org1', 'p1', {
			useProjectAgentConfig: false
		});

		expect(result.mcpJson).toEqual({ mcpServers: {} });
		expect(result.settings).toEqual({ enabledMcpjsonServers: [] });
		expect(result.skills).toEqual([]);
		expect(result.secretEnv).toEqual({});
		expect(result.snapshot).toEqual({ enabled: false, mcpServers: [], skills: [] });
		expect(mocks.projectFindFirst).not.toHaveBeenCalled();
	});

	it('builds a runtime projection with decrypted secret env and non-secret files config', async () => {
		mocks.mcpFindMany.mockResolvedValue([
			{
				id: 'm1',
				name: 'linear',
				transport: 'http',
				enabled: true,
				config: { url: 'https://mcp.linear.app/mcp', headers: { 'x-public': 'yes' } },
				env: { LINEAR_API_KEY: { secretName: 'linear_api_key' } }
			},
			{
				id: 'm2',
				name: 'local',
				transport: 'stdio',
				enabled: true,
				config: { command: 'bunx', args: ['local-mcp'] },
				env: {}
			}
		]);
		mocks.skillFindMany.mockResolvedValue([
			{
				id: 'sk1',
				name: 'review',
				description: 'Review changes',
				body: '---\nname: review\ndescription: Review changes\n---\n\nReview changes.',
				enabled: true
			}
		]);
		mocks.secretFindMany.mockResolvedValue([
			{
				id: 's1',
				name: 'linear_api_key',
				valueEncrypted: encryptProjectSecretValue('lin_123')
			}
		]);

		const result = await buildRunAgentConfig('org1', 'p1', {
			useProjectAgentConfig: true
		});

		expect(mocks.projectFindFirst).toHaveBeenCalledWith({
			where: { id: 'p1', organizationId: 'org1' },
			select: { id: true }
		});
		expect(mocks.mcpFindMany).toHaveBeenCalledWith({
			where: { organizationId: 'org1', projectId: 'p1', enabled: true },
			orderBy: { name: 'asc' }
		});
		expect(result.secretEnv).toEqual({ DOTWEAVER_MCP_LINEAR_LINEAR_API_KEY: 'lin_123' });
		expect(result.mcpJson.mcpServers.linear).toEqual({
			type: 'http',
			url: 'https://mcp.linear.app/mcp',
			headers: { 'x-public': 'yes' },
			env: { LINEAR_API_KEY: '${DOTWEAVER_MCP_LINEAR_LINEAR_API_KEY}' }
		});
		expect(result.mcpJson.mcpServers.local).toEqual({
			type: 'stdio',
			command: 'bunx',
			args: ['local-mcp'],
			env: {}
		});
		expect(result.settings.enabledMcpjsonServers).toEqual(['linear', 'local']);
		expect(result.skills).toEqual([
			{
				name: 'review',
				body: '---\nname: review\ndescription: Review changes\n---\n\nReview changes.'
			}
		]);
		expect(result.snapshot).toEqual({
			enabled: true,
			mcpServers: [
				{ id: 'm1', name: 'linear', transport: 'http' },
				{ id: 'm2', name: 'local', transport: 'stdio' }
			],
			skills: [{ id: 'sk1', name: 'review' }]
		});
		expect(JSON.stringify(result.snapshot)).not.toContain('lin_123');
		expect(JSON.stringify(result.mcpJson)).not.toContain('lin_123');
	});

	it('isolates same-named MCP env refs behind distinct internal env keys', async () => {
		mocks.mcpFindMany.mockResolvedValue([
			{
				id: 'm1',
				name: 'linear',
				transport: 'http',
				enabled: true,
				config: { url: 'https://mcp.linear.app/mcp', headers: {} },
				env: { API_KEY: { secretName: 'linear_api_key' } }
			},
			{
				id: 'm2',
				name: 'github',
				transport: 'sse',
				enabled: true,
				config: { url: 'https://mcp.github.com/sse', headers: {} },
				env: { API_KEY: { secretName: 'github_api_key' } }
			}
		]);
		mocks.secretFindMany.mockResolvedValue([
			{
				id: 's1',
				name: 'linear_api_key',
				valueEncrypted: encryptProjectSecretValue('lin_123')
			},
			{
				id: 's2',
				name: 'github_api_key',
				valueEncrypted: encryptProjectSecretValue('gh_456')
			}
		]);

		const result = await buildRunAgentConfig('org1', 'p1', {
			useProjectAgentConfig: true
		});

		expect(result.secretEnv).toEqual({
			DOTWEAVER_MCP_LINEAR_API_KEY: 'lin_123',
			DOTWEAVER_MCP_GITHUB_API_KEY: 'gh_456'
		});
		expect(result.mcpJson.mcpServers.linear).toMatchObject({
			env: { API_KEY: '${DOTWEAVER_MCP_LINEAR_API_KEY}' }
		});
		expect(result.mcpJson.mcpServers.github).toMatchObject({
			env: { API_KEY: '${DOTWEAVER_MCP_GITHUB_API_KEY}' }
		});
		expect(JSON.stringify(result.mcpJson)).not.toContain('lin_123');
		expect(JSON.stringify(result.mcpJson)).not.toContain('gh_456');
	});

	it('fails closed when generated internal env names collide', async () => {
		mocks.mcpFindMany.mockResolvedValue([
			{
				id: 'm1',
				name: 'linear-api',
				transport: 'http',
				enabled: true,
				config: { url: 'https://mcp.linear.app/mcp', headers: {} },
				env: { API_KEY: { secretName: 'linear_api_key' } }
			},
			{
				id: 'm2',
				name: 'linear_api',
				transport: 'http',
				enabled: true,
				config: { url: 'https://mcp.linear.local/mcp', headers: {} },
				env: { API_KEY: { secretName: 'other_linear_api_key' } }
			}
		]);
		mocks.secretFindMany.mockResolvedValue([
			{
				id: 's1',
				name: 'linear_api_key',
				valueEncrypted: encryptProjectSecretValue('lin_123')
			},
			{
				id: 's2',
				name: 'other_linear_api_key',
				valueEncrypted: encryptProjectSecretValue('lin_456')
			}
		]);

		await expect(
			buildRunAgentConfig('org1', 'p1', { useProjectAgentConfig: true })
		).rejects.toThrow(ProjectAgentConfigError);
	});

	it('fails closed when a referenced secret is missing', async () => {
		mocks.mcpFindMany.mockResolvedValue([
			{
				id: 'm1',
				name: 'linear',
				transport: 'http',
				enabled: true,
				config: { url: 'https://mcp.linear.app/mcp', headers: {} },
				env: { LINEAR_API_KEY: { secretName: 'linear_api_key' } }
			}
		]);

		await expect(
			buildRunAgentConfig('org1', 'p1', { useProjectAgentConfig: true })
		).rejects.toThrow(ProjectAgentConfigError);
	});

	it.each([
		{
			name: 'missing http url',
			server: {
				id: 'm1',
				name: 'linear',
				transport: 'http',
				enabled: true,
				config: { headers: {} },
				env: {}
			}
		},
		{
			name: 'non-string http header value',
			server: {
				id: 'm1',
				name: 'linear',
				transport: 'http',
				enabled: true,
				config: { url: 'https://mcp.linear.app/mcp', headers: { 'x-public': 123 } },
				env: {}
			}
		},
		{
			name: 'sensitive http header key',
			server: {
				id: 'm1',
				name: 'linear',
				transport: 'http',
				enabled: true,
				config: { url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer x' } },
				env: {}
			}
		},
		{
			name: 'missing stdio command',
			server: {
				id: 'm1',
				name: 'local',
				transport: 'stdio',
				enabled: true,
				config: { args: [] },
				env: {}
			}
		},
		{
			name: 'non-string stdio arg',
			server: {
				id: 'm1',
				name: 'local',
				transport: 'stdio',
				enabled: true,
				config: { command: 'bunx', args: ['ok', 123] },
				env: {}
			}
		},
		{
			name: 'env is not an object',
			server: {
				id: 'm1',
				name: 'linear',
				transport: 'http',
				enabled: true,
				config: { url: 'https://mcp.linear.app/mcp', headers: {} },
				env: null
			}
		},
		{
			name: 'env ref missing secret name',
			server: {
				id: 'm1',
				name: 'linear',
				transport: 'http',
				enabled: true,
				config: { url: 'https://mcp.linear.app/mcp', headers: {} },
				env: { API_KEY: {} }
			}
		}
	])('fails closed before projection when DB JSON is malformed: $name', async ({ server }) => {
		mocks.mcpFindMany.mockResolvedValue([server]);

		await expect(
			buildRunAgentConfig('org1', 'p1', { useProjectAgentConfig: true })
		).rejects.toThrow(ProjectAgentConfigError);
	});

	it('materializes MCP settings and skills without writing secret values into files', async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'dw-agent-config-'));

		await materializeRunAgentConfig(tempDir, {
			mcpJson: {
				mcpServers: {
					linear: {
						type: 'http',
						url: 'https://mcp.linear.app/mcp',
						env: { LINEAR_API_KEY: 'lin_123' }
					}
				}
			},
			settings: { enabledMcpjsonServers: ['linear'] },
			skills: [
				{
					name: 'review',
					body: '---\nname: review\ndescription: Review changes\n---\n\nReview changes.'
				}
			],
			secretEnv: { DOTWEAVER_MCP_LINEAR_LINEAR_API_KEY: 'lin_123' },
			snapshot: { enabled: true, mcpServers: [], skills: [] }
		});

		const mcpJson = await readFile(join(tempDir, '.mcp.json'), 'utf8');
		const settings = await readFile(join(tempDir, '.claude/settings.json'), 'utf8');
		const skill = await readFile(join(tempDir, '.claude/skills/review/SKILL.md'), 'utf8');

		expect(mcpJson).not.toContain('lin_123');
		expect(mcpJson).toContain('"LINEAR_API_KEY": "${DOTWEAVER_MCP_LINEAR_LINEAR_API_KEY}"');
		expect(settings).toContain('enabledMcpjsonServers');
		expect(skill).toContain('Review changes.');
	});

	it('rejects unsafe skill names during materialization', async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'dw-agent-config-'));

		await expect(
			materializeRunAgentConfig(tempDir, {
				mcpJson: { mcpServers: {} },
				settings: { enabledMcpjsonServers: [] },
				skills: [{ name: '../escape', body: 'nope' }],
				secretEnv: {},
				snapshot: { enabled: true, mcpServers: [], skills: [] }
			})
		).rejects.toThrow(ProjectAgentConfigError);
	});
});
