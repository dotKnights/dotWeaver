import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	class ProjectAgentConfigError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'ProjectAgentConfigError';
		}
	}

	return {
		getRequestEvent: vi.fn(),
		requireHeaders: vi.fn(),
		requireActiveOrg: vi.fn(),
		refresh: vi.fn(),
		createProjectSecretForOrg: vi.fn(),
		listProjectAgentConfigForOrg: vi.fn(),
		upsertProjectMcpServerForOrg: vi.fn(),
		upsertProjectSecretForOrg: vi.fn(),
		upsertProjectSkillForOrg: vi.fn(),
		mcpDeleteMany: vi.fn(),
		mcpUpdateMany: vi.fn(),
		skillDeleteMany: vi.fn(),
		skillUpdateMany: vi.fn(),
		secretDeleteMany: vi.fn(),
		secretFindMany: vi.fn(),
		ProjectAgentConfigError
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
vi.mock('$lib/server/org', () => ({ requireActiveOrg: mocks.requireActiveOrg }));
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		projectMcpServer: { deleteMany: mocks.mcpDeleteMany, updateMany: mocks.mcpUpdateMany },
		projectSkill: { deleteMany: mocks.skillDeleteMany, updateMany: mocks.skillUpdateMany },
		projectSecret: { deleteMany: mocks.secretDeleteMany, findMany: mocks.secretFindMany }
	}
}));
vi.mock('$lib/server/project-agent-config-service', () => ({
	createProjectSecretForOrg: mocks.createProjectSecretForOrg,
	listProjectAgentConfigForOrg: mocks.listProjectAgentConfigForOrg,
	upsertProjectMcpServerForOrg: mocks.upsertProjectMcpServerForOrg,
	upsertProjectSecretForOrg: mocks.upsertProjectSecretForOrg,
	upsertProjectSkillForOrg: mocks.upsertProjectSkillForOrg,
	ProjectAgentConfigError: mocks.ProjectAgentConfigError
}));

import {
	deleteProjectMcpServer,
	getProjectAgentConfig,
	importProjectMcpJson,
	setProjectSkillEnabled,
	upsertProjectSecret
} from '$lib/rfc/project-agent-config.remote';

const getProjectAgentConfigMock = getProjectAgentConfig as typeof getProjectAgentConfig & {
	serverHandler: (projectId: string) => Promise<unknown>;
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
		mocks.secretFindMany.mockResolvedValue([]);
		mocks.mcpDeleteMany.mockResolvedValue({ count: 1 });
		mocks.skillUpdateMany.mockResolvedValue({ count: 1 });
	});

	it('maps invalid MCP JSON imports to a 400 error', async () => {
		await expect(importProjectMcpJson({ projectId: 'p1', json: '{' })).rejects.toMatchObject({
			status: 400,
			message: 'Invalid .mcp.json'
		});

		expect(mocks.upsertProjectMcpServerForOrg).not.toHaveBeenCalled();
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
