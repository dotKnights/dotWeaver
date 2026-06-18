import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('$lib/server/mcp/context', () => ({
	resolveOrgContext: vi.fn(),
	AmbiguousTeamError: class extends Error {
		constructor(public slugs: string[] = []) {
			super(`Multiple teams available - specify one of: ${slugs.join(', ')}`);
		}
	},
	TeamAccessError: class extends Error {},
	NoTeamError: class extends Error {}
}));
vi.mock('$lib/server/projects-service', () => ({
	listProjectsForOrg: vi.fn(),
	getProjectForOrg: vi.fn()
}));
vi.mock('$lib/server/runs-service', () => ({
	listRunsForOrg: vi.fn(),
	getRunForOrg: vi.fn(),
	getRunDiffForOrg: vi.fn(),
	RunWorkspaceUnavailableError: class extends Error {}
}));
vi.mock('$lib/server/teams-service', () => ({ listTeamsForUser: vi.fn() }));
vi.mock('$lib/server/run-start-service', () => ({
	startRunForOrg: vi.fn(),
	RunStartError: class extends Error {}
}));

import { resolveOrgContext, AmbiguousTeamError } from '$lib/server/mcp/context';
import { listProjectsForOrg } from '$lib/server/projects-service';
import { getRunForOrg } from '$lib/server/runs-service';
import { startRunForOrg } from '$lib/server/run-start-service';
import { registerTools } from '$lib/server/mcp/tools';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;
type ProjectRow = { id: string };

function fakeServer() {
	const tools: Record<string, ToolHandler> = {};
	return {
		tools,
		tool(name: string, _desc: string, _schema: unknown, handler: ToolHandler) {
			tools[name] = handler;
		}
	};
}

const mockedResolveOrgContext = vi.mocked(resolveOrgContext) as Mock<
	(userId: string, team?: string) => Promise<string>
>;
const mockedListProjectsForOrg = vi.mocked(listProjectsForOrg) as Mock<
	(orgId: string) => Promise<ProjectRow[]>
>;
const mockedGetRunForOrg = vi.mocked(getRunForOrg) as Mock<
	(orgId: string, runId: string) => Promise<unknown | null>
>;
const mockedStartRunForOrg = vi.mocked(startRunForOrg) as Mock<
	(input: Record<string, unknown>) => Promise<unknown | null>
>;

describe('registerTools', () => {
	beforeEach(() => vi.clearAllMocks());

	it('enregistre les outils MCP', () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		expect(Object.keys(s.tools).sort()).toEqual([
			'get_project',
			'get_run',
			'get_run_diff',
			'list_projects',
			'list_runs',
			'list_teams',
			'start_cdc_run',
			'stream_run_events'
		]);
	});

	it('list_projects resout l org puis appelle le service', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedResolveOrgContext.mockResolvedValue('org1');
		mockedListProjectsForOrg.mockResolvedValue([{ id: 'p1' }]);
		const res = await s.tools.list_projects({ team: 'acme' });
		expect(resolveOrgContext).toHaveBeenCalledWith('u1', 'acme');
		expect(JSON.parse(res.content[0].text)).toEqual([{ id: 'p1' }]);
		expect(res.isError).toBeFalsy();
	});

	it('get_run renvoie isError si ressource introuvable', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedResolveOrgContext.mockResolvedValue('org1');
		mockedGetRunForOrg.mockResolvedValue(null);
		const res = await s.tools.get_run({ runId: 'x' });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/not found/i);
	});

	it('start_cdc_run cree une run CDC dans l org resolue', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedResolveOrgContext.mockResolvedValue('org1');
		mockedStartRunForOrg.mockResolvedValue({
			runId: 'run1',
			projectId: 'p1',
			mode: 'cdc',
			baseBranch: 'main'
		});

		const res = await s.tools.start_cdc_run({
			team: 'acme',
			projectId: 'p1',
			prompt: 'Cadrer un CRM',
			baseBranch: 'main',
			model: 'sonnet'
		});

		expect(resolveOrgContext).toHaveBeenCalledWith('u1', 'acme');
		expect(startRunForOrg).toHaveBeenCalledWith({
			organizationId: 'org1',
			userId: 'u1',
			projectId: 'p1',
			prompt: 'Cadrer un CRM',
			baseBranch: 'main',
			model: 'sonnet',
			mode: 'cdc',
			useProjectAgentConfig: true
		});
		expect(JSON.parse(res.content[0].text)).toMatchObject({ runId: 'run1', mode: 'cdc' });
		expect(res.isError).toBeFalsy();
	});

	it('mappe AmbiguousTeamError en isError listant les slugs', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		const err = new AmbiguousTeamError(['acme', 'globex']);
		mockedResolveOrgContext.mockRejectedValue(err);
		const res = await s.tools.list_projects({});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/acme/);
	});
});
