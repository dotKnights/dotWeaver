import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	transaction: vi.fn(),
	projectFindFirst: vi.fn(),
	mcpFindMany: vi.fn(),
	mcpUpsert: vi.fn(),
	skillFindMany: vi.fn(),
	skillUpsert: vi.fn(),
	skillFindFirst: vi.fn(),
	skillCreate: vi.fn(),
	skillUpdate: vi.fn(),
	skillFileCreateMany: vi.fn(),
	skillFileDeleteMany: vi.fn(),
	secretFindMany: vi.fn(),
	secretCreate: vi.fn(),
	secretUpsert: vi.fn(),
	envVarFindMany: vi.fn(),
	envVarFindFirst: vi.fn(),
	envVarUpsert: vi.fn(),
	envVarUpdateMany: vi.fn()
}));

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		$transaction: mocks.transaction,
		project: { findFirst: mocks.projectFindFirst },
		projectMcpServer: { findMany: mocks.mcpFindMany, upsert: mocks.mcpUpsert },
		projectSkill: {
			findMany: mocks.skillFindMany,
			upsert: mocks.skillUpsert,
			findFirst: mocks.skillFindFirst,
			create: mocks.skillCreate,
			update: mocks.skillUpdate
		},
		projectSkillFile: {
			createMany: mocks.skillFileCreateMany,
			deleteMany: mocks.skillFileDeleteMany
		},
		projectSecret: {
			findMany: mocks.secretFindMany,
			create: mocks.secretCreate,
			upsert: mocks.secretUpsert
		},
		projectEnvVar: {
			findMany: mocks.envVarFindMany,
			findFirst: mocks.envVarFindFirst,
			upsert: mocks.envVarUpsert,
			updateMany: mocks.envVarUpdateMany
		}
	}
}));

vi.mock('$env/dynamic/private', () => ({
	env: { PROJECT_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') }
}));

import { encryptProjectSecretValue } from '$lib/server/project-agent-config-encryption';
import {
	buildRunAgentConfig,
	createProjectSecretForOrg,
	importProjectEnvFileForOrg,
	importSkillsShSkillForOrg,
	listProjectAgentConfigForOrg,
	materializeRunAgentConfig,
	ProjectAgentConfigError,
	revealProjectEnvVarForOrg,
	upsertProjectEnvVarForOrg,
	upsertProjectMcpServerForOrg,
	upsertProjectSecretForOrg,
	upsertProjectSkillForOrg
} from '$lib/server/project-agent-config-service';

const execFileAsync = promisify(execFile);
let tempDir: string | undefined;

async function gitIn(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync('git', args, { cwd, env: process.env });
}

describe('project-agent-config-service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.projectFindFirst.mockResolvedValue({ id: 'p1' });
		mocks.mcpFindMany.mockResolvedValue([]);
		mocks.skillFindMany.mockResolvedValue([]);
		mocks.skillFindFirst.mockResolvedValue(null);
		mocks.skillCreate.mockResolvedValue({ id: 'sk1' });
		mocks.skillUpdate.mockResolvedValue({ id: 'sk1' });
		mocks.skillFileCreateMany.mockResolvedValue({ count: 1 });
		mocks.skillFileDeleteMany.mockResolvedValue({ count: 1 });
		mocks.secretFindMany.mockResolvedValue([]);
		mocks.envVarFindMany.mockResolvedValue([]);
		mocks.envVarFindFirst.mockResolvedValue(null);
		mocks.envVarUpsert.mockResolvedValue({ id: 'ev1' });
		mocks.envVarUpdateMany.mockResolvedValue({ count: 1 });
		mocks.transaction.mockImplementation((callback) =>
			callback({
				projectSkill: {
					findFirst: mocks.skillFindFirst,
					create: mocks.skillCreate,
					update: mocks.skillUpdate
				},
				projectSkillFile: {
					createMany: mocks.skillFileCreateMany,
					deleteMany: mocks.skillFileDeleteMany
				}
			})
		);
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

	it('imports a skills.sh skill snapshot with support files', async () => {
		mocks.skillCreate.mockResolvedValue({ id: 'sk1', name: 'find-skills' });

		const result = await importSkillsShSkillForOrg(
			'org1',
			'p1',
			{
				id: 'vercel-labs/skills/find-skills',
				name: 'find-skills',
				description: 'Find skills',
				body: '---\nname: find-skills\ndescription: Find skills\n---\n\nUse it.',
				files: [{ path: 'examples/demo.md', content: 'demo' }],
				source: 'vercel-labs/skills',
				slug: 'find-skills',
				hash: 'abc123',
				installs: 24531,
				sourceType: 'github',
				installUrl: 'https://github.com/vercel-labs/skills',
				url: 'https://skills.sh/vercel-labs/skills/find-skills'
			},
			{ replace: false }
		);

		expect(result).toEqual({ id: 'sk1', name: 'find-skills' });
		expect(mocks.skillFindFirst).toHaveBeenCalledWith({
			where: { organizationId: 'org1', projectId: 'p1', name: 'find-skills' },
			select: { id: true, name: true }
		});
		expect(mocks.skillCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				projectId: 'p1',
				organizationId: 'org1',
				name: 'find-skills',
				enabled: true,
				description: 'Find skills',
				body: '---\nname: find-skills\ndescription: Find skills\n---\n\nUse it.',
				source: 'imported',
				sourceProvider: 'skills.sh',
				sourcePackage: 'vercel-labs/skills',
				sourceSkillId: 'vercel-labs/skills/find-skills',
				sourceUrl: 'https://skills.sh/vercel-labs/skills/find-skills',
				sourceHash: 'abc123',
				sourceMetadata: {
					installs: 24531,
					sourceType: 'github',
					installUrl: 'https://github.com/vercel-labs/skills'
				},
				importedAt: expect.any(Date)
			})
		});
		expect(mocks.skillFileCreateMany).toHaveBeenCalledWith({
			data: [
				{
					projectSkillId: 'sk1',
					path: 'examples/demo.md',
					content: 'demo',
					contentHash: expect.stringMatching(/^[a-f0-9]{64}$/)
				}
			]
		});
	});

	it('rejects imported skills that would overwrite an existing skill without replace', async () => {
		mocks.skillFindFirst.mockResolvedValue({ id: 'existing', name: 'find-skills' });

		await expect(
			importSkillsShSkillForOrg(
				'org1',
				'p1',
				{
					id: 'vercel-labs/skills/find-skills',
					name: 'find-skills',
					description: 'Find skills',
					body: 'Use it.',
					files: [],
					source: 'vercel-labs/skills',
					slug: 'find-skills',
					hash: 'abc123'
				},
				{ replace: false }
			)
		).rejects.toThrow('Project skill `find-skills` already exists');

		expect(mocks.skillCreate).not.toHaveBeenCalled();
		expect(mocks.skillUpdate).not.toHaveBeenCalled();
	});

	it('replaces an existing imported skill snapshot when requested', async () => {
		mocks.skillFindFirst.mockResolvedValue({ id: 'existing', name: 'find-skills' });
		mocks.skillUpdate.mockResolvedValue({ id: 'existing', name: 'find-skills' });

		await importSkillsShSkillForOrg(
			'org1',
			'p1',
			{
				id: 'vercel-labs/skills/find-skills',
				name: 'find-skills',
				description: 'Find skills',
				body: 'Use it.',
				files: [{ path: 'examples/demo.md', content: 'demo' }],
				source: 'vercel-labs/skills',
				slug: 'find-skills',
				hash: 'new-hash'
			},
			{ replace: true }
		);

		expect(mocks.skillUpdate).toHaveBeenCalledWith({
			where: { id: 'existing' },
			data: expect.objectContaining({
				description: 'Find skills',
				body: 'Use it.',
				source: 'imported',
				sourceProvider: 'skills.sh',
				sourcePackage: 'vercel-labs/skills',
				sourceSkillId: 'vercel-labs/skills/find-skills',
				sourceHash: 'new-hash',
				importedAt: expect.any(Date)
			})
		});
		expect(mocks.skillFileDeleteMany).toHaveBeenCalledWith({
			where: { projectSkillId: 'existing' }
		});
		expect(mocks.skillFileCreateMany).toHaveBeenCalledWith({
			data: [
				{
					projectSkillId: 'existing',
					path: 'examples/demo.md',
					content: 'demo',
					contentHash: expect.stringMatching(/^[a-f0-9]{64}$/)
				}
			]
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

	it('creates imported secrets without overwriting existing values', async () => {
		mocks.secretCreate.mockResolvedValue({ id: 's1' });

		await createProjectSecretForOrg('org1', 'user1', {
			projectId: 'p1',
			name: 'imported_token',
			value: 'secret-value'
		});

		expect(mocks.secretCreate).toHaveBeenCalledOnce();
		const call = mocks.secretCreate.mock.calls[0][0];
		expect(call.data).toMatchObject({
			projectId: 'p1',
			organizationId: 'org1',
			name: 'imported_token',
			createdById: 'user1'
		});
		expect(call.data.valueEncrypted).toMatch(/^v1:/);
		expect(call.data.valueEncrypted).not.toContain('secret-value');

		mocks.secretCreate.mockRejectedValueOnce({ code: 'P2002' });
		await expect(
			createProjectSecretForOrg('org1', 'user1', {
				projectId: 'p1',
				name: 'imported_token',
				value: 'secret-value'
			})
		).rejects.toThrow(ProjectAgentConfigError);
	});

	it('lists env vars masking sensitive values and revealing non-sensitive ones', async () => {
		mocks.envVarFindMany.mockResolvedValue([
			{
				id: 'ev1',
				key: 'API_KEY',
				enabled: true,
				sensitive: true,
				valueEncrypted: encryptProjectSecretValue('sk_secret')
			},
			{
				id: 'ev2',
				key: 'NODE_ENV',
				enabled: true,
				sensitive: false,
				valueEncrypted: encryptProjectSecretValue('production')
			}
		]);

		const result = await listProjectAgentConfigForOrg('org1', 'p1');

		expect(mocks.envVarFindMany).toHaveBeenCalledWith({
			where: { organizationId: 'org1', projectId: 'p1' },
			orderBy: { key: 'asc' },
			select: { id: true, key: true, enabled: true, sensitive: true, valueEncrypted: true }
		});
		expect(result.envVars).toEqual([
			{ id: 'ev1', key: 'API_KEY', enabled: true, sensitive: true, value: null },
			{ id: 'ev2', key: 'NODE_ENV', enabled: true, sensitive: false, value: 'production' }
		]);
		expect(JSON.stringify(result.envVars)).not.toContain('sk_secret');
	});

	it('reveals the decrypted env var value and throws when not found', async () => {
		mocks.envVarFindFirst.mockResolvedValueOnce({
			valueEncrypted: encryptProjectSecretValue('sk_secret')
		});

		await expect(revealProjectEnvVarForOrg('org1', { projectId: 'p1', id: 'ev1' })).resolves.toBe(
			'sk_secret'
		);
		expect(mocks.envVarFindFirst).toHaveBeenCalledWith({
			where: { id: 'ev1', projectId: 'p1', organizationId: 'org1' },
			select: { valueEncrypted: true }
		});

		mocks.envVarFindFirst.mockResolvedValueOnce(null);
		await expect(
			revealProjectEnvVarForOrg('org1', { projectId: 'p1', id: 'missing' })
		).rejects.toThrow(ProjectAgentConfigError);
	});

	it('upserts an env var defaulting sensitivity from the key name and encrypting the value', async () => {
		await upsertProjectEnvVarForOrg('org1', 'user1', {
			projectId: 'p1',
			key: 'API_KEY',
			value: 'sk_secret'
		});

		let call = mocks.envVarUpsert.mock.calls[0][0];
		expect(call.where).toEqual({ projectId_key: { projectId: 'p1', key: 'API_KEY' } });
		expect(call.create).toMatchObject({
			projectId: 'p1',
			organizationId: 'org1',
			key: 'API_KEY',
			sensitive: true,
			createdById: 'user1'
		});
		expect(call.create.valueEncrypted).toMatch(/^v1:/);
		expect(call.create.valueEncrypted).not.toContain('sk_secret');
		expect(call.update.valueEncrypted).not.toContain('sk_secret');

		mocks.envVarUpsert.mockClear();
		await upsertProjectEnvVarForOrg('org1', 'user1', {
			projectId: 'p1',
			key: 'NODE_ENV',
			value: 'production'
		});
		call = mocks.envVarUpsert.mock.calls[0][0];
		expect(call.create.sensitive).toBe(false);
		expect(call.update.sensitive).toBe(false);
	});

	it('imports a .env file, reporting imported and skipped keys', async () => {
		const result = await importProjectEnvFileForOrg('org1', 'user1', {
			projectId: 'p1',
			content: '# comment\nAPI_KEY=sk_secret\nNODE_ENV=production\n1BAD=nope\nEMPTY=\n'
		});

		expect(result.imported).toBe(2);
		expect(result.skipped).toContain('1BAD');
		expect(result.skipped).toContain('EMPTY');
		expect(mocks.envVarUpsert).toHaveBeenCalledTimes(2);
		const upsertedKeys = mocks.envVarUpsert.mock.calls.map(
			(c) => c[0].where.projectId_key.key
		);
		expect(upsertedKeys).toEqual(['API_KEY', 'NODE_ENV']);
	});

	it('returns an empty runtime projection when config is disabled for the run', async () => {
		const result = await buildRunAgentConfig('org1', 'p1', {
			useProjectAgentConfig: false
		});

		expect(result.mcpJson).toEqual({ mcpServers: {} });
		expect(result.settings).toEqual({ enabledMcpjsonServers: [] });
		expect(result.skills).toEqual([]);
		expect(result.secretEnv).toEqual({});
		expect(result.snapshot).toEqual({
			enabled: false,
			mcpServers: [],
			skills: [],
			envVars: []
		});
		expect(result.envFile).toEqual([]);
		expect(mocks.projectFindFirst).not.toHaveBeenCalled();
	});

	it('includes enabled env vars in the runtime config envFile', async () => {
		mocks.envVarFindMany.mockResolvedValue([
			{ key: 'API_KEY', valueEncrypted: encryptProjectSecretValue('secret') }
		]);

		const config = await buildRunAgentConfig('org1', 'p1', { useProjectAgentConfig: true });

		expect(mocks.envVarFindMany).toHaveBeenCalledWith({
			where: { organizationId: 'org1', projectId: 'p1', enabled: true },
			orderBy: { key: 'asc' },
			select: { key: true, valueEncrypted: true }
		});
		expect(config.envFile).toEqual([{ key: 'API_KEY', value: 'secret' }]);
		expect(config.snapshot.envVars).toEqual([{ key: 'API_KEY' }]);
		expect(JSON.stringify(config.snapshot)).not.toContain('secret');
	});

	it('returns an empty envFile when project agent config is disabled', async () => {
		const config = await buildRunAgentConfig('org1', 'p1', { useProjectAgentConfig: false });

		expect(config.envFile).toEqual([]);
		expect(config.snapshot.envVars).toEqual([]);
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
		expect(mocks.skillFindMany).toHaveBeenCalledWith({
			where: { organizationId: 'org1', projectId: 'p1', enabled: true },
			orderBy: { name: 'asc' },
			include: { files: { orderBy: { path: 'asc' } } }
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
				body: '---\nname: review\ndescription: Review changes\n---\n\nReview changes.',
				files: []
			}
		]);
		expect(result.snapshot).toEqual({
			enabled: true,
			mcpServers: [
				{ id: 'm1', name: 'linear', transport: 'http' },
				{ id: 'm2', name: 'local', transport: 'stdio' }
			],
			skills: [
				{ id: 'sk1', name: 'review', sourceProvider: null, sourceSkillId: null, sourceHash: null }
			],
			envVars: []
		});
		expect(JSON.stringify(result.snapshot)).not.toContain('lin_123');
		expect(JSON.stringify(result.mcpJson)).not.toContain('lin_123');
	});

	it('builds secret-backed HTTP headers as runtime env placeholders', async () => {
		mocks.mcpFindMany.mockResolvedValue([
			{
				id: 'm1',
				name: 'github',
				transport: 'http',
				enabled: true,
				config: {
					url: 'https://example.com/mcp',
					headers: {
						'x-public': 'yes',
						Authorization: { secretName: 'github_token', prefix: 'Bearer ' }
					}
				},
				env: {}
			}
		]);
		mocks.secretFindMany.mockResolvedValue([
			{
				id: 's1',
				name: 'github_token',
				valueEncrypted: encryptProjectSecretValue('Bearer gh_123')
			}
		]);

		const result = await buildRunAgentConfig('org1', 'p1', {
			useProjectAgentConfig: true
		});

		expect(result.secretEnv).toEqual({
			DOTWEAVER_MCP_GITHUB_HEADER_AUTHORIZATION: 'Bearer gh_123'
		});
		expect(result.mcpJson.mcpServers.github).toEqual({
			type: 'http',
			url: 'https://example.com/mcp',
			headers: {
				'x-public': 'yes',
				Authorization: 'Bearer ${DOTWEAVER_MCP_GITHUB_HEADER_AUTHORIZATION}'
			},
			env: {}
		});
		expect(JSON.stringify(result.mcpJson)).not.toContain('Bearer gh_123');
		expect(JSON.stringify(result.snapshot)).not.toContain('Bearer gh_123');
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
					body: '---\nname: review\ndescription: Review changes\n---\n\nReview changes.',
					files: [{ path: 'examples/demo.md', content: 'demo' }]
				}
			],
			secretEnv: { DOTWEAVER_MCP_LINEAR_LINEAR_API_KEY: 'lin_123' },
			envFile: [],
			snapshot: { enabled: true, mcpServers: [], skills: [], envVars: [] }
		});

		const mcpJson = await readFile(join(tempDir, '.mcp.json'), 'utf8');
		const settings = await readFile(join(tempDir, '.claude/settings.json'), 'utf8');
		const skill = await readFile(join(tempDir, '.claude/skills/review/SKILL.md'), 'utf8');
		const supportFile = await readFile(
			join(tempDir, '.claude/skills/review/examples/demo.md'),
			'utf8'
		);

		expect(mcpJson).not.toContain('lin_123');
		expect(mcpJson).toContain('"LINEAR_API_KEY": "${DOTWEAVER_MCP_LINEAR_LINEAR_API_KEY}"');
		expect(settings).toContain('enabledMcpjsonServers');
		expect(skill).toContain('Review changes.');
		expect(supportFile).toBe('demo');
	});

	it('merges env vars into .env and marks it as a generated path', async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'dw-agent-config-git-'));
		await gitIn(tempDir, ['init']);
		await gitIn(tempDir, ['config', 'user.email', 'test@example.com']);
		await gitIn(tempDir, ['config', 'user.name', 'Test User']);
		await writeFile(join(tempDir, '.env'), 'KEEP=1\n');
		await gitIn(tempDir, ['add', '.env']);
		await gitIn(tempDir, ['commit', '-m', 'baseline']);

		await materializeRunAgentConfig(tempDir, {
			mcpJson: { mcpServers: {} },
			settings: { enabledMcpjsonServers: [] },
			skills: [],
			secretEnv: {},
			envFile: [{ key: 'API_KEY', value: 'secret' }],
			snapshot: { enabled: true, mcpServers: [], skills: [], envVars: [{ key: 'API_KEY' }] }
		});

		const written = await readFile(join(tempDir, '.env'), 'utf8');
		const exclude = await readFile(join(tempDir, '.git/info/exclude'), 'utf8');

		expect(written).toContain('KEEP=1');
		expect(written).toContain('API_KEY=secret');
		expect(exclude).toContain('.env');
	});

	it('does not write .env when there are no env vars', async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'dw-agent-config-'));

		await materializeRunAgentConfig(tempDir, {
			mcpJson: { mcpServers: {} },
			settings: { enabledMcpjsonServers: [] },
			skills: [],
			secretEnv: {},
			envFile: [],
			snapshot: { enabled: true, mcpServers: [], skills: [], envVars: [] }
		});

		await expect(readFile(join(tempDir, '.env'), 'utf8')).rejects.toThrow();
	});

	it('keeps generated config paths out of the runner commit surface', async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'dw-agent-config-git-'));
		await gitIn(tempDir, ['init']);
		await gitIn(tempDir, ['config', 'user.email', 'test@example.com']);
		await gitIn(tempDir, ['config', 'user.name', 'Test User']);
		await writeFile(join(tempDir, '.mcp.json'), '{"mcpServers":{}}\n');
		await gitIn(tempDir, ['add', '.mcp.json']);
		await gitIn(tempDir, ['commit', '-m', 'baseline']);

		await materializeRunAgentConfig(tempDir, {
			mcpJson: {
				mcpServers: {
					linear: {
						type: 'http',
						url: 'https://mcp.linear.app/mcp',
						env: { LINEAR_API_KEY: '${DOTWEAVER_MCP_LINEAR_LINEAR_API_KEY}' }
					}
				}
			},
			settings: { enabledMcpjsonServers: ['linear'] },
			skills: [
				{
					name: 'review',
					body: '---\nname: review\ndescription: Review changes\n---\n\nReview changes.',
					files: [{ path: 'examples/demo.md', content: 'demo' }]
				}
			],
			secretEnv: { DOTWEAVER_MCP_LINEAR_LINEAR_API_KEY: 'lin_123' },
			envFile: [],
			snapshot: { enabled: true, mcpServers: [], skills: [], envVars: [] }
		});

		const status = await gitIn(tempDir, ['status', '--porcelain']);
		const exclude = await readFile(join(tempDir, '.git/info/exclude'), 'utf8');

		expect(status.stdout).toBe('');
		expect(exclude).toContain('.mcp.json');
		expect(exclude).toContain('.claude/settings.json');
		expect(exclude).toContain('.claude/skills/review/SKILL.md');
		expect(exclude).toContain('.claude/skills/review/examples/demo.md');
	});

	it('rejects unsafe skill names during materialization', async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'dw-agent-config-'));

		await expect(
			materializeRunAgentConfig(tempDir, {
				mcpJson: { mcpServers: {} },
				settings: { enabledMcpjsonServers: [] },
				skills: [{ name: '../escape', body: 'nope', files: [] }],
				secretEnv: {},
				envFile: [],
				snapshot: { enabled: true, mcpServers: [], skills: [], envVars: [] }
			})
		).rejects.toThrow(ProjectAgentConfigError);
	});

	it('rejects unsafe skill support file paths during materialization', async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'dw-agent-config-'));

		await expect(
			materializeRunAgentConfig(tempDir, {
				mcpJson: { mcpServers: {} },
				settings: { enabledMcpjsonServers: [] },
				skills: [
					{ name: 'safe', body: 'safe', files: [{ path: '../escape.md', content: 'nope' }] }
				],
				secretEnv: {},
				envFile: [],
				snapshot: { enabled: true, mcpServers: [], skills: [], envVars: [] }
			})
		).rejects.toThrow(ProjectAgentConfigError);
	});
});
