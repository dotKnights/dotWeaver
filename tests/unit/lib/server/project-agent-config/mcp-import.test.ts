import { describe, expect, it } from 'vitest';
import {
	parseProjectMcpJsonImport,
	parseProjectMcpJsonServers,
	ProjectMcpImportError
} from '$lib/server/project-agent-config/mcp-import';

function parseImport(json: unknown, existingSecretNames: string[] = []) {
	return parseProjectMcpJsonImport({
		projectId: 'p1',
		mcpServers: parseProjectMcpJsonServers(JSON.stringify(json)),
		existingSecretNames
	});
}

describe('project-agent-config mcp import parser', () => {
	it('rejects invalid MCP JSON input', () => {
		expect(() => parseProjectMcpJsonServers('{')).toThrow(ProjectMcpImportError);
		expect(() => parseProjectMcpJsonServers('{')).toThrow('Invalid .mcp.json');
		expect(() => parseProjectMcpJsonServers(JSON.stringify({}))).toThrow(
			'.mcp.json mcpServers must be an object'
		);
	});

	it('imports stdio env placeholders and literal secrets', () => {
		const imports = parseImport(
			{
				mcpServers: {
					linear: {
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
			},
			['linear_INLINE_TOKEN']
		);

		expect(imports).toEqual([
			{
				input: {
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
				},
				secrets: [{ name: 'linear_INLINE_TOKEN_2', value: 'plain-secret' }]
			}
		]);
	});

	it('converts sensitive HTTP headers to secret refs', () => {
		const imports = parseImport({
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
					}
				}
			}
		});

		expect(imports[0]).toEqual({
			input: {
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
			},
			secrets: [{ name: 'github_client_secret', value: 'literal-secret' }]
		});
	});

	it('validates all servers before returning imports', () => {
		expect(() =>
			parseImport({
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
		).toThrow('MCP `invalid` command must be a string');
	});
});
