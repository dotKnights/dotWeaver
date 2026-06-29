import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	class ProjectAgentConfigError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'ProjectAgentConfigError';
		}
	}
	class SkillsShError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'SkillsShError';
		}
	}

	return {
		getRequestEvent: vi.fn(),
		requireHeaders: vi.fn(),
		requireActiveOrg: vi.fn(),
		refresh: vi.fn(),
		createProjectSecretForOrg: vi.fn(),
		downloadSkillsShSkill: vi.fn(),
		importSkillsShSkillForOrg: vi.fn(),
		listProjectAgentConfigForOrg: vi.fn(),
		searchSkillsShCatalog: vi.fn(),
		upsertProjectMcpServerForOrg: vi.fn(),
		upsertProjectSecretForOrg: vi.fn(),
		upsertProjectSkillForOrg: vi.fn(),
		upsertProjectEnvVarForOrg: vi.fn(),
		setProjectEnvVarSensitiveForOrg: vi.fn(),
		revealProjectEnvVarForOrg: vi.fn(),
		importProjectEnvFileForOrg: vi.fn(),
		mcpDeleteMany: vi.fn(),
		mcpUpdateMany: vi.fn(),
		skillDeleteMany: vi.fn(),
		skillUpdateMany: vi.fn(),
		secretDeleteMany: vi.fn(),
		secretFindMany: vi.fn(),
		envVarDeleteMany: vi.fn(),
		envVarUpdateMany: vi.fn(),
		ProjectAgentConfigError,
		SkillsShError
	};
});

function remoteCommand<T extends (...args: never[]) => unknown>(
	handler: T
): T & { __: { type: 'command' } } {
	const wrapped = vi.fn(handler) as unknown as T & { __: { type: 'command' } };
	wrapped.__ = { type: 'command' };
	return wrapped;
}

function remoteQuery<T extends (arg: never) => unknown>(
	handler: T
): ((arg: Parameters<T>[0]) => { refresh: () => Promise<void> }) & {
	__: { type: 'query' };
	serverHandler: T;
} {
	const wrapped = vi.fn(() => ({ refresh: mocks.refresh })) as unknown as ((
		arg: Parameters<T>[0]
	) => { refresh: () => Promise<void> }) & { __: { type: 'query' }; serverHandler: T };
	wrapped.__ = { type: 'query' };
	wrapped.serverHandler = handler;
	return wrapped;
}

vi.mock('$app/server', () => ({
	command: vi.fn((schemaOrHandler, maybeHandler) => remoteCommand(maybeHandler ?? schemaOrHandler)),
	query: vi.fn((schemaOrHandler, maybeHandler) => remoteQuery(maybeHandler ?? schemaOrHandler)),
	getRequestEvent: mocks.getRequestEvent
}));

vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));

vi.mock('$lib/server/utils', () => ({ requireHeaders: mocks.requireHeaders }));
vi.mock('$lib/server/auth/org', () => ({ requireActiveOrg: mocks.requireActiveOrg }));
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		projectMcpServer: { deleteMany: mocks.mcpDeleteMany, updateMany: mocks.mcpUpdateMany },
		projectSkill: { deleteMany: mocks.skillDeleteMany, updateMany: mocks.skillUpdateMany },
		projectSecret: { deleteMany: mocks.secretDeleteMany, findMany: mocks.secretFindMany },
		projectEnvVar: { deleteMany: mocks.envVarDeleteMany, updateMany: mocks.envVarUpdateMany }
	}
}));
vi.mock('$lib/server/project-agent-config-service', () => ({
	createProjectSecretForOrg: mocks.createProjectSecretForOrg,
	importSkillsShSkillForOrg: mocks.importSkillsShSkillForOrg,
	listProjectAgentConfigForOrg: mocks.listProjectAgentConfigForOrg,
	upsertProjectMcpServerForOrg: mocks.upsertProjectMcpServerForOrg,
	upsertProjectSecretForOrg: mocks.upsertProjectSecretForOrg,
	upsertProjectSkillForOrg: mocks.upsertProjectSkillForOrg,
	upsertProjectEnvVarForOrg: mocks.upsertProjectEnvVarForOrg,
	setProjectEnvVarSensitiveForOrg: mocks.setProjectEnvVarSensitiveForOrg,
	revealProjectEnvVarForOrg: mocks.revealProjectEnvVarForOrg,
	importProjectEnvFileForOrg: mocks.importProjectEnvFileForOrg,
	ProjectAgentConfigError: mocks.ProjectAgentConfigError
}));
vi.mock('$lib/server/skills-sh-service', () => ({
	downloadSkillsShSkill: mocks.downloadSkillsShSkill,
	searchSkillsShCatalog: mocks.searchSkillsShCatalog,
	SkillsShError: mocks.SkillsShError
}));

import {
	deleteProjectEnvVar,
	deleteProjectMcpServer,
	getProjectAgentConfig,
	getSkillsShSkill,
	importProjectEnvFile,
	importProjectMcpJson,
	importSkillsShSkill,
	revealProjectEnvVar,
	searchSkillsSh,
	setProjectEnvVarEnabled,
	setProjectEnvVarSensitive,
	setProjectSkillEnabled,
	upsertProjectEnvVar,
	upsertProjectSecret
} from '$lib/rfc/project-agent-config.remote';

const getProjectAgentConfigMock = getProjectAgentConfig as typeof getProjectAgentConfig & {
	serverHandler: (projectId: string) => Promise<unknown>;
};
const searchSkillsShMock = searchSkillsSh as typeof searchSkillsSh & {
	serverHandler: (input: { query: string; limit: number }) => Promise<unknown>;
};
const getSkillsShSkillMock = getSkillsShSkill as typeof getSkillsShSkill & {
	serverHandler: (input: { id: string }) => Promise<unknown>;
};

describe('project-agent-config.remote', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.requireHeaders.mockReturnValue(new Headers());
		mocks.requireActiveOrg.mockResolvedValue('org1');
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'user1' } } });
		mocks.refresh.mockResolvedValue(undefined);
		mocks.listProjectAgentConfigForOrg.mockResolvedValue({
			mcpServers: [],
			skills: [],
			secrets: []
		});
		mocks.upsertProjectSecretForOrg.mockResolvedValue({ id: 'secret1' });
		mocks.createProjectSecretForOrg.mockResolvedValue({ id: 'imported-secret1' });
		mocks.upsertProjectMcpServerForOrg.mockResolvedValue({ id: 'mcp1' });
		mocks.searchSkillsShCatalog.mockResolvedValue({ query: 'svelte', count: 0, results: [] });
		mocks.downloadSkillsShSkill.mockResolvedValue({
			id: 'vercel-labs/skills/find-skills',
			name: 'find-skills',
			description: 'Find skills',
			body: 'Use it.',
			files: [],
			source: 'vercel-labs/skills',
			slug: 'find-skills',
			hash: 'abc123'
		});
		mocks.importSkillsShSkillForOrg.mockResolvedValue({ id: 'skill1' });
		mocks.secretFindMany.mockResolvedValue([]);
		mocks.mcpDeleteMany.mockResolvedValue({ count: 1 });
		mocks.skillUpdateMany.mockResolvedValue({ count: 1 });
		mocks.upsertProjectEnvVarForOrg.mockResolvedValue({ id: 'env1' });
		mocks.setProjectEnvVarSensitiveForOrg.mockResolvedValue(undefined);
		mocks.revealProjectEnvVarForOrg.mockResolvedValue('plain-value');
		mocks.importProjectEnvFileForOrg.mockResolvedValue({ imported: 2, skipped: ['EMPTY'] });
		mocks.envVarDeleteMany.mockResolvedValue({ count: 1 });
		mocks.envVarUpdateMany.mockResolvedValue({ count: 1 });
	});

	it('maps invalid MCP JSON imports to a 400 error', async () => {
		await expect(importProjectMcpJson({ projectId: 'p1', json: '{' })).rejects.toMatchObject({
			status: 400,
			message: 'Invalid .mcp.json'
		});

		expect(mocks.upsertProjectMcpServerForOrg).not.toHaveBeenCalled();
		expect(mocks.refresh).not.toHaveBeenCalled();
	});

	it('searches skills.sh in the active organization context', async () => {
		await expect(searchSkillsShMock.serverHandler({ query: 'svelte', limit: 20 })).resolves.toEqual(
			{
				query: 'svelte',
				count: 0,
				results: []
			}
		);

		expect(mocks.requireActiveOrg).toHaveBeenCalledWith(new Headers());
		expect(mocks.searchSkillsShCatalog).toHaveBeenCalledWith({ query: 'svelte', limit: 20 });
	});

	it('previews a skills.sh skill in the active organization context', async () => {
		await expect(
			getSkillsShSkillMock.serverHandler({ id: 'vercel-labs/skills/find-skills' })
		).resolves.toMatchObject({
			id: 'vercel-labs/skills/find-skills',
			name: 'find-skills'
		});

		expect(mocks.requireActiveOrg).toHaveBeenCalledWith(new Headers());
		expect(mocks.downloadSkillsShSkill).toHaveBeenCalledWith({
			id: 'vercel-labs/skills/find-skills'
		});
	});

	it('imports a skills.sh skill and refreshes project agent config', async () => {
		await expect(
			importSkillsShSkill({
				projectId: 'p1',
				id: 'vercel-labs/skills/find-skills',
				replace: true
			})
		).resolves.toEqual({ id: 'skill1' });

		expect(mocks.downloadSkillsShSkill).toHaveBeenCalledWith({
			id: 'vercel-labs/skills/find-skills'
		});
		expect(mocks.importSkillsShSkillForOrg).toHaveBeenCalledWith(
			'org1',
			'p1',
			expect.objectContaining({ id: 'vercel-labs/skills/find-skills' }),
			{ replace: true }
		);
		expect(mocks.refresh).toHaveBeenCalledOnce();
	});

	it('maps skills.sh import service errors to 400 responses', async () => {
		mocks.importSkillsShSkillForOrg.mockRejectedValueOnce(
			new mocks.ProjectAgentConfigError('Project skill `find-skills` already exists')
		);

		await expect(
			importSkillsShSkill({
				projectId: 'p1',
				id: 'vercel-labs/skills/find-skills',
				replace: false
			})
		).rejects.toMatchObject({
			status: 400,
			message: 'Project skill `find-skills` already exists'
		});

		expect(mocks.refresh).not.toHaveBeenCalled();
	});

	it('requires MCP JSON imports to include an mcpServers object', async () => {
		for (const json of [JSON.stringify({}), JSON.stringify({ foo: true })]) {
			await expect(importProjectMcpJson({ projectId: 'p1', json })).rejects.toMatchObject({
				status: 400,
				message: '.mcp.json mcpServers must be an object'
			});
		}

		expect(mocks.upsertProjectMcpServerForOrg).not.toHaveBeenCalled();
		expect(mocks.refresh).not.toHaveBeenCalled();
	});

	it('imports placeholder and static env values as secret refs', async () => {
		mocks.secretFindMany.mockResolvedValue([{ name: 'linear_INLINE_TOKEN' }]);

		await importProjectMcpJson({
			projectId: 'p1',
			json: JSON.stringify({
				mcpServers: {
					linear: {
						type: 'stdio',
						command: 'bunx',
						args: ['linear-mcp', 123],
						env: {
							LINEAR_API_KEY: '${LINEAR_API_KEY}',
							FALLBACK_TOKEN: '${FALLBACK_TOKEN:-dev}',
							EXISTING: { secretName: 'existing_secret' },
							INLINE_TOKEN: 'plain-secret'
						}
					}
				}
			})
		});

		expect(mocks.createProjectSecretForOrg).toHaveBeenCalledWith('org1', 'user1', {
			projectId: 'p1',
			name: 'linear_INLINE_TOKEN_2',
			value: 'plain-secret'
		});
		expect(mocks.upsertProjectSecretForOrg).not.toHaveBeenCalled();
		expect(mocks.upsertProjectMcpServerForOrg).toHaveBeenCalledWith('org1', {
			projectId: 'p1',
			name: 'linear',
			transport: 'stdio',
			enabled: true,
			command: 'bunx',
			args: ['linear-mcp', '123'],
			env: {
				LINEAR_API_KEY: { secretName: 'LINEAR_API_KEY' },
				FALLBACK_TOKEN: { secretName: 'FALLBACK_TOKEN' },
				EXISTING: { secretName: 'existing_secret' },
				INLINE_TOKEN: { secretName: 'linear_INLINE_TOKEN_2' }
			}
		});
		expect(mocks.refresh).toHaveBeenCalledOnce();
	});

	it('imports sensitive HTTP headers as project secret refs', async () => {
		await importProjectMcpJson({
			projectId: 'p1',
			json: JSON.stringify({
				mcpServers: {
					github: {
						type: 'http',
						url: 'https://example.com/mcp',
						headers: {
							Authorization: 'Bearer ${GITHUB_TOKEN}',
							'x-api-key': '${GITHUB_API_KEY}',
							client_secret: 'literal-secret',
							'x-public': 'yes',
							'x-secret-ref': { secretName: 'existing_header', prefix: 'Token ' }
						},
						env: {}
					}
				}
			})
		});

		expect(mocks.createProjectSecretForOrg).toHaveBeenCalledWith('org1', 'user1', {
			projectId: 'p1',
			name: 'github_client_secret',
			value: 'literal-secret'
		});
		expect(mocks.upsertProjectMcpServerForOrg).toHaveBeenCalledWith('org1', {
			projectId: 'p1',
			name: 'github',
			transport: 'http',
			enabled: true,
			url: 'https://example.com/mcp',
			headers: {
				Authorization: { secretName: 'GITHUB_TOKEN', prefix: 'Bearer ' },
				'x-api-key': { secretName: 'GITHUB_API_KEY' },
				client_secret: { secretName: 'github_client_secret' },
				'x-public': 'yes',
				'x-secret-ref': { secretName: 'existing_header', prefix: 'Token ' }
			},
			env: {}
		});
		expect(mocks.refresh).toHaveBeenCalledOnce();
	});

	it('rejects partial env placeholders during MCP JSON import', async () => {
		await expect(
			importProjectMcpJson({
				projectId: 'p1',
				json: JSON.stringify({
					mcpServers: {
						unsafe: {
							type: 'stdio',
							command: 'bunx',
							env: { API_KEY: 'Bearer ${API_KEY}' }
						}
					}
				})
			})
		).rejects.toMatchObject({
			status: 400,
			message: 'MCP `unsafe` env `API_KEY` cannot contain partial placeholders'
		});

		expect(mocks.createProjectSecretForOrg).not.toHaveBeenCalled();
		expect(mocks.upsertProjectMcpServerForOrg).not.toHaveBeenCalled();
		expect(mocks.refresh).not.toHaveBeenCalled();
	});

	it('infers stdio transport for Claude-style servers without a type', async () => {
		await importProjectMcpJson({
			projectId: 'p1',
			json: JSON.stringify({
				mcpServers: {
					filesystem: {
						command: 'npx',
						args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
						env: {}
					}
				}
			})
		});

		expect(mocks.upsertProjectMcpServerForOrg).toHaveBeenCalledWith('org1', {
			projectId: 'p1',
			name: 'filesystem',
			transport: 'stdio',
			enabled: true,
			command: 'npx',
			args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
			env: {}
		});
		expect(mocks.refresh).toHaveBeenCalledOnce();
	});

	it('validates every MCP server before writing imported config', async () => {
		await expect(
			importProjectMcpJson({
				projectId: 'p1',
				json: JSON.stringify({
					mcpServers: {
						valid: {
							type: 'stdio',
							command: 'npx',
							args: ['valid-server'],
							env: {}
						},
						invalid: {
							type: 'stdio',
							args: ['missing-command'],
							env: {}
						}
					}
				})
			})
		).rejects.toMatchObject({
			status: 400,
			message: 'MCP `invalid` command must be a string'
		});

		expect(mocks.upsertProjectMcpServerForOrg).not.toHaveBeenCalled();
		expect(mocks.createProjectSecretForOrg).not.toHaveBeenCalled();
		expect(mocks.upsertProjectSecretForOrg).not.toHaveBeenCalled();
		expect(mocks.refresh).not.toHaveBeenCalled();
	});

	it('rejects explicitly unsupported MCP transports', async () => {
		await expect(
			importProjectMcpJson({
				projectId: 'p1',
				json: JSON.stringify({
					mcpServers: {
						weird: {
							type: 'websocket',
							url: 'https://example.com/mcp',
							env: {}
						}
					}
				})
			})
		).rejects.toMatchObject({
			status: 400,
			message: 'MCP `weird` has unsupported transport'
		});

		expect(mocks.upsertProjectMcpServerForOrg).not.toHaveBeenCalled();
		expect(mocks.refresh).not.toHaveBeenCalled();
	});

	it('scopes deletes by organization and project and returns 404 when absent', async () => {
		await deleteProjectMcpServer({ projectId: 'p1', id: 'mcp1' });

		expect(mocks.mcpDeleteMany).toHaveBeenCalledWith({
			where: { id: 'mcp1', projectId: 'p1', organizationId: 'org1' }
		});
		expect(mocks.refresh).toHaveBeenCalledOnce();

		mocks.mcpDeleteMany.mockResolvedValueOnce({ count: 0 });
		await expect(deleteProjectMcpServer({ projectId: 'p1', id: 'missing' })).rejects.toMatchObject({
			status: 404,
			message: 'Not found'
		});
	});

	it('scopes enabled updates by organization and project', async () => {
		await setProjectSkillEnabled({ projectId: 'p1', id: 'skill1', enabled: false });

		expect(mocks.skillUpdateMany).toHaveBeenCalledWith({
			where: { id: 'skill1', projectId: 'p1', organizationId: 'org1' },
			data: { enabled: false }
		});
		expect(mocks.refresh).toHaveBeenCalledOnce();
	});

	it('uses the current user when upserting secrets and refreshes project config', async () => {
		await upsertProjectSecret({ projectId: 'p1', name: 'linear_api_key', value: 'secret-value' });

		expect(mocks.upsertProjectSecretForOrg).toHaveBeenCalledWith('org1', 'user1', {
			projectId: 'p1',
			name: 'linear_api_key',
			value: 'secret-value'
		});
		expect(mocks.refresh).toHaveBeenCalledOnce();
	});

	it('uses the current user when upserting env vars and refreshes project config', async () => {
		await expect(
			upsertProjectEnvVar({ projectId: 'p1', key: 'API_KEY', value: 'secret-value' })
		).resolves.toEqual({ id: 'env1' });

		expect(mocks.upsertProjectEnvVarForOrg).toHaveBeenCalledWith('org1', 'user1', {
			projectId: 'p1',
			key: 'API_KEY',
			value: 'secret-value'
		});
		expect(mocks.refresh).toHaveBeenCalledOnce();
	});

	it('scopes env var deletes by organization and project and returns 404 when absent', async () => {
		await deleteProjectEnvVar({ projectId: 'p1', id: 'env1' });

		expect(mocks.envVarDeleteMany).toHaveBeenCalledWith({
			where: { id: 'env1', projectId: 'p1', organizationId: 'org1' }
		});
		expect(mocks.refresh).toHaveBeenCalledOnce();

		mocks.envVarDeleteMany.mockResolvedValueOnce({ count: 0 });
		await expect(deleteProjectEnvVar({ projectId: 'p1', id: 'missing' })).rejects.toMatchObject({
			status: 404,
			message: 'Not found'
		});
	});

	it('scopes env var enabled updates and returns 404 when absent', async () => {
		await setProjectEnvVarEnabled({ projectId: 'p1', id: 'env1', enabled: false });

		expect(mocks.envVarUpdateMany).toHaveBeenCalledWith({
			where: { id: 'env1', projectId: 'p1', organizationId: 'org1' },
			data: { enabled: false }
		});
		expect(mocks.refresh).toHaveBeenCalledOnce();

		mocks.envVarUpdateMany.mockResolvedValueOnce({ count: 0 });
		await expect(
			setProjectEnvVarEnabled({ projectId: 'p1', id: 'missing', enabled: true })
		).rejects.toMatchObject({ status: 404, message: 'Not found' });
	});

	it('sets env var sensitivity via the service and refreshes project config', async () => {
		await setProjectEnvVarSensitive({ projectId: 'p1', id: 'env1', sensitive: true });

		expect(mocks.setProjectEnvVarSensitiveForOrg).toHaveBeenCalledWith('org1', {
			projectId: 'p1',
			id: 'env1',
			sensitive: true
		});
		expect(mocks.refresh).toHaveBeenCalledOnce();
	});

	it('reveals an env var value from the service', async () => {
		await expect(revealProjectEnvVar({ projectId: 'p1', id: 'env1' })).resolves.toEqual({
			value: 'plain-value'
		});

		expect(mocks.revealProjectEnvVarForOrg).toHaveBeenCalledWith('org1', {
			projectId: 'p1',
			id: 'env1'
		});
	});

	it('imports an env file via the service and returns the result', async () => {
		await expect(
			importProjectEnvFile({ projectId: 'p1', content: 'API_KEY=value\nEMPTY=' })
		).resolves.toEqual({ imported: 2, skipped: ['EMPTY'] });

		expect(mocks.importProjectEnvFileForOrg).toHaveBeenCalledWith('org1', 'user1', {
			projectId: 'p1',
			content: 'API_KEY=value\nEMPTY='
		});
		expect(mocks.refresh).toHaveBeenCalledOnce();
	});

	it('maps project config service errors for queries', async () => {
		mocks.listProjectAgentConfigForOrg.mockRejectedValueOnce(
			new mocks.ProjectAgentConfigError('Project not found')
		);

		await expect(getProjectAgentConfigMock.serverHandler('p1')).rejects.toMatchObject({
			status: 404,
			message: 'Project not found'
		});
	});
});
