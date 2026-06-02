import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/mcp/context', () => ({
	resolveOrgContext: vi.fn(),
	AmbiguousTeamError: class extends Error { slugs: string[] = []; },
	TeamAccessError: class extends Error {},
	NoTeamError: class extends Error {}
}));
vi.mock('$lib/server/projects-service', () => ({
	listProjectsForOrg: vi.fn(), getProjectForOrg: vi.fn()
}));
vi.mock('$lib/server/runs-service', () => ({
	listRunsForOrg: vi.fn(), getRunForOrg: vi.fn(), getRunDiffForOrg: vi.fn(),
	RunWorkspaceUnavailableError: class extends Error {}
}));
vi.mock('$lib/server/teams-service', () => ({ listTeamsForUser: vi.fn() }));

import { resolveOrgContext } from '$lib/server/mcp/context';
import { listProjectsForOrg } from '$lib/server/projects-service';
import { getRunForOrg } from '$lib/server/runs-service';
import { registerTools } from './tools';

function fakeServer() {
	const tools: Record<string, (args: any, extra?: any) => Promise<any>> = {};
	return {
		tools,
		tool(name: string, _desc: string, _schema: any, handler: any) { tools[name] = handler; }
	};
}

describe('registerTools', () => {
	beforeEach(() => vi.clearAllMocks());

	it('enregistre les 7 outils read-only', () => {
		const s = fakeServer();
		registerTools(s as any, { userId: 'u1' });
		expect(Object.keys(s.tools).sort()).toEqual([
			'get_project', 'get_run', 'get_run_diff',
			'list_projects', 'list_runs', 'list_teams', 'stream_run_events'
		]);
	});

	it('list_projects resout l org puis appelle le service', async () => {
		const s = fakeServer();
		registerTools(s as any, { userId: 'u1' });
		(resolveOrgContext as any).mockResolvedValue('org1');
		(listProjectsForOrg as any).mockResolvedValue([{ id: 'p1' }]);
		const res = await s.tools.list_projects({ team: 'acme' });
		expect(resolveOrgContext).toHaveBeenCalledWith('u1', 'acme');
		expect(JSON.parse(res.content[0].text)).toEqual([{ id: 'p1' }]);
		expect(res.isError).toBeFalsy();
	});

	it('get_run renvoie isError si ressource introuvable', async () => {
		const s = fakeServer();
		registerTools(s as any, { userId: 'u1' });
		(resolveOrgContext as any).mockResolvedValue('org1');
		(getRunForOrg as any).mockResolvedValue(null);
		const res = await s.tools.get_run({ runId: 'x' });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/not found/i);
	});

	it('mappe AmbiguousTeamError en isError listant les slugs', async () => {
		const s = fakeServer();
		registerTools(s as any, { userId: 'u1' });
		const { AmbiguousTeamError } = await import('$lib/server/mcp/context');
		const err = new (AmbiguousTeamError as any)();
		err.slugs = ['acme', 'globex'];
		err.message = 'Multiple teams available - specify one of: acme, globex';
		(resolveOrgContext as any).mockRejectedValue(err);
		const res = await s.tools.list_projects({});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/acme/);
	});
});
