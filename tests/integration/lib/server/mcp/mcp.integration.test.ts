/**
 * Integration test for /mcp endpoint transport + auth wiring.
 *
 * MECHANICS DISCOVERED:
 * - mcp-handler's createMcpHandler passes `sessionIdGenerator: undefined` (default),
 *   which puts WebStandardStreamableHTTPServerTransport in STATELESS mode.
 * - In stateless mode: no Mcp-Session-Id header is required or returned; no
 *   initialize handshake is needed before tools/list or tools/call; each POST
 *   gets a fresh McpServer + transport instance.
 * - The Mcp-Protocol-Version header is only validated when present; omitting it
 *   is silently accepted (falls back to DEFAULT_NEGOTIATED_PROTOCOL_VERSION).
 * - Responses arrive as text/event-stream SSE; each JSON-RPC response is a
 *   single `data: {...}\n\n` line.
 * - better-auth withMcpAuth signature: (auth, (req, session) => Response).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock better-auth/plugins BEFORE importing the route handler.
// withMcpAuth: if no Authorization header → 401 + WWW-Authenticate; otherwise inject session.
vi.mock('better-auth/plugins', () => ({
	withMcpAuth: (_auth: unknown, fn: (req: Request, session: unknown) => Promise<Response>) => {
		return (req: Request) => {
			const authz = req.headers.get('authorization');
			if (!authz) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							jsonrpc: '2.0',
							error: { code: -32000, message: 'Unauthorized: Authentication required' },
							id: null
						}),
						{
							status: 401,
							headers: {
								'WWW-Authenticate': 'Bearer',
								'Content-Type': 'application/json'
							}
						}
					)
				);
			}
			return fn(req, { userId: 'u1' });
		};
	}
}));

vi.mock('$lib/server/auth', () => ({ auth: {} }));

vi.mock('$lib/server/teams-service', () => ({
	listTeamsForUser: vi
		.fn()
		.mockResolvedValue([{ id: 'org1', slug: 'acme', name: 'Acme', role: 'owner' }])
}));

vi.mock('$lib/server/projects-service', () => ({
	listProjectsForOrg: vi.fn().mockResolvedValue([{ id: 'p1', name: 'demo' }]),
	getProjectForOrg: vi.fn(),
	importGithubProjectForOrg: vi.fn(),
	GithubProjectImportError: class GithubProjectImportError extends Error {}
}));

vi.mock('$lib/server/runs/service', () => ({
	listRunsForOrg: vi.fn(),
	getRunForOrg: vi.fn(),
	getRunDiffForOrg: vi.fn(),
	startRunForOrg: vi.fn(),
	cancelRunForOrg: vi.fn(),
	approveRunForOrg: vi.fn(),
	RunWorkspaceUnavailableError: class RunWorkspaceUnavailableError extends Error {},
	RunMutationError: class RunMutationError extends Error {}
}));

vi.mock('$lib/server/runs/reply-service', () => ({
	replyToRunForOrg: vi.fn(),
	RunReplyError: class RunReplyError extends Error {}
}));

vi.mock('$lib/server/github-git', () => ({
	getGithubTokenForUser: vi.fn().mockResolvedValue('gho_test')
}));

vi.mock('$lib/server/project-agent-config-service', () => ({
	ProjectAgentConfigError: class ProjectAgentConfigError extends Error {}
}));

// Import AFTER mocks are hoisted
import { POST } from '../../../../../src/routes/mcp/+server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a POST Request to /mcp with the given JSON-RPC body. */
function rpc(body: unknown, withAuth = true, sessionId?: string): Request {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
		...(withAuth ? { authorization: 'Bearer test-token' } : {}),
		...(sessionId ? { 'mcp-session-id': sessionId } : {})
	};
	return new Request('http://localhost/mcp', {
		method: 'POST',
		headers,
		body: JSON.stringify(body)
	});
}

/**
 * Parse a JSON-RPC response regardless of whether the server returned
 * plain JSON or SSE (text/event-stream with `data: {...}` lines).
 * Returns the first data payload that contains either `result` or `error`.
 */
async function readRpc(res: Response): Promise<unknown> {
	const text = await res.text();
	const ct = res.headers.get('content-type') ?? '';
	if (ct.includes('text/event-stream')) {
		// Find all `data:` lines and pick the first with a result/error field
		for (const line of text.split('\n')) {
			if (line.startsWith('data:')) {
				const payload = line.slice(5).trim();
				if (!payload) continue;
				try {
					const parsed = JSON.parse(payload);
					if ('result' in parsed || 'error' in parsed) return parsed;
				} catch {
					// ignore parse failures on partial lines
				}
			}
		}
		return null;
	}
	return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP endpoint (integration)', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns 401 with WWW-Authenticate when no Authorization header is provided', async () => {
		const res = await POST({ request: rpc({}, false) } as Parameters<typeof POST>[0]);
		expect(res.status).toBe(401);
		expect(res.headers.get('WWW-Authenticate')).toBeTruthy();
	});

	it('initialize → tools/list → tools/call list_projects full chain works', async () => {
		// ---- initialize ----
		// In stateless mode, initialize is not strictly required for subsequent
		// requests (each gets a fresh server), but we exercise it to cover the
		// full lifecycle. The response just needs to be 200.
		const initRes = await POST({
			request: rpc({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: { name: 'test-client', version: '1.0' }
				}
			})
		} as Parameters<typeof POST>[0]);
		expect(initRes.status).toBe(200);

		// In stateless mode, no Mcp-Session-Id is returned (sessionIdGenerator is
		// undefined), so no session header is needed on follow-up requests.
		const sessionId = initRes.headers.get('mcp-session-id') ?? undefined;

		// ---- tools/list ----
		// Each POST in stateless mode creates a fresh server with registerTools()
		// already called, so tools/list works without a prior initialize.
		const listRes = await POST({
			request: rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, true, sessionId)
		} as Parameters<typeof POST>[0]);
		expect(listRes.status).toBe(200);

		const listData = await readRpc(listRes);
		expect(listData).not.toBeNull();
		const tools = (listData as { result: { tools: { name: string }[] } }).result.tools;
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual([
			'answer_pending_question',
			'approve_run',
			'cancel_run',
			'get_project',
			'get_run',
			'get_run_diff',
			'import_github_project',
			'list_projects',
			'list_runs',
			'list_teams',
			'reply_to_run',
			'start_run',
			'stream_run_events'
		]);

		// ---- tools/call list_projects ----
		const callRes = await POST({
			request: rpc(
				{
					jsonrpc: '2.0',
					id: 3,
					method: 'tools/call',
					params: { name: 'list_projects', arguments: { team: 'acme' } }
				},
				true,
				sessionId
			)
		} as Parameters<typeof POST>[0]);
		expect(callRes.status).toBe(200);

		const callData = await readRpc(callRes);
		expect(callData).not.toBeNull();
		const content = (callData as { result: { content: { type: string; text: string }[] } }).result
			.content;
		expect(content[0].type).toBe('text');
		const payload = JSON.parse(content[0].text);
		expect(payload).toEqual([{ id: 'p1', name: 'demo' }]);
	});
});
