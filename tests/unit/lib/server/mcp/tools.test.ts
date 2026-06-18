import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { z } from 'zod';

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
	getProjectForOrg: vi.fn(),
	importGithubProjectForOrg: vi.fn(),
	GithubProjectImportError: class GithubProjectImportError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'GithubProjectImportError';
		}
	}
}));
vi.mock('$lib/server/runs-service', () => ({
	listRunsForOrg: vi.fn(),
	getRunForOrg: vi.fn(),
	getRunDiffForOrg: vi.fn(),
	startRunForOrg: vi.fn(),
	cancelRunForOrg: vi.fn(),
	approveRunForOrg: vi.fn(),
	RunWorkspaceUnavailableError: class extends Error {},
	RunMutationError: class RunMutationError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'RunMutationError';
		}
	}
}));
vi.mock('$lib/server/run-reply-service', () => ({
	replyToRunForOrg: vi.fn(),
	RunReplyError: class RunReplyError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'RunReplyError';
		}
	}
}));
vi.mock('$lib/server/github-git', () => ({ getGithubTokenForUser: vi.fn() }));
vi.mock('$lib/server/project-agent-config-service', () => ({
	ProjectAgentConfigError: class ProjectAgentConfigError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'ProjectAgentConfigError';
		}
	}
}));
vi.mock('$lib/server/teams-service', () => ({ listTeamsForUser: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({ env: { RUN_TIMEOUT_MS: '60000' } }));

import { resolveOrgContext, AmbiguousTeamError } from '$lib/server/mcp/context';
import { listProjectsForOrg, importGithubProjectForOrg } from '$lib/server/projects-service';
import {
	getRunForOrg,
	startRunForOrg,
	cancelRunForOrg,
	approveRunForOrg,
	RunMutationError
} from '$lib/server/runs-service';
import { replyToRunForOrg } from '$lib/server/run-reply-service';
import { getGithubTokenForUser } from '$lib/server/github-git';
import { registerTools } from '$lib/server/mcp/tools';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;
type ProjectRow = { id: string };

function fakeServer() {
	const tools: Record<string, ToolHandler> = {};
	const schemas: Record<string, Record<string, z.ZodTypeAny>> = {};
	return {
		tools,
		schemas,
		tool(name: string, _desc: string, schema: Record<string, z.ZodTypeAny>, handler: ToolHandler) {
			schemas[name] = schema;
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
const mockedImportGithubProjectForOrg = vi.mocked(importGithubProjectForOrg) as Mock<
	(input: Record<string, unknown>) => Promise<unknown>
>;
const mockedStartRunForOrg = vi.mocked(startRunForOrg) as Mock<
	(input: Record<string, unknown>) => Promise<unknown | null>
>;
const mockedCancelRunForOrg = vi.mocked(cancelRunForOrg) as Mock<
	(orgId: string, runId: string) => Promise<{ canceled: boolean; projectId?: string } | null>
>;
const mockedApproveRunForOrg = vi.mocked(approveRunForOrg) as Mock<
	(input: Record<string, unknown>) => Promise<unknown | null>
>;
const mockedReplyToRunForOrg = vi.mocked(replyToRunForOrg) as Mock<
	(orgId: string, input: Record<string, unknown>) => Promise<unknown | null>
>;
const mockedGetGithubTokenForUser = vi.mocked(getGithubTokenForUser) as Mock<
	(userId: string) => Promise<string | null>
>;

describe('registerTools', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
	});

	it('enregistre les 12 outils read et write', () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		expect(Object.keys(s.tools).sort()).toEqual([
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

	it('mappe AmbiguousTeamError en isError listant les slugs', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		const err = new AmbiguousTeamError(['acme', 'globex']);
		mockedResolveOrgContext.mockRejectedValue(err);
		const res = await s.tools.list_projects({});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/acme/);
	});

	it('import_github_project resout la team, recupere le token et retourne le projet', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedResolveOrgContext.mockResolvedValue('org1');
		mockedGetGithubTokenForUser.mockResolvedValue('gh-token');
		mockedImportGithubProjectForOrg.mockResolvedValue({ id: 'p1' });

		const res = await s.tools.import_github_project({
			owner: 'acme',
			name: 'repo',
			team: 'core'
		});

		expect(resolveOrgContext).toHaveBeenCalledWith('u1', 'core');
		expect(getGithubTokenForUser).toHaveBeenCalledWith('u1');
		expect(importGithubProjectForOrg).toHaveBeenCalledWith({
			organizationId: 'org1',
			userId: 'u1',
			token: 'gh-token',
			owner: 'acme',
			name: 'repo'
		});
		expect(JSON.parse(res.content[0].text)).toEqual({ id: 'p1' });
		expect(res.isError).toBeFalsy();
	});

	it('start_run resout la team, recupere le token et applique timeout et config agent par defaut', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedResolveOrgContext.mockResolvedValue('org1');
		mockedGetGithubTokenForUser.mockResolvedValue('gh-token');
		mockedStartRunForOrg.mockResolvedValue({ runId: 'r1', projectId: 'p1' });

		const res = await s.tools.start_run({
			projectId: 'p1',
			prompt: 'do it',
			baseBranch: 'main',
			model: 'sonnet',
			team: 'core'
		});

		expect(resolveOrgContext).toHaveBeenCalledWith('u1', 'core');
		expect(getGithubTokenForUser).toHaveBeenCalledWith('u1');
		expect(startRunForOrg).toHaveBeenCalledWith({
			organizationId: 'org1',
			userId: 'u1',
			githubToken: 'gh-token',
			projectId: 'p1',
			prompt: 'do it',
			baseBranch: 'main',
			model: 'sonnet',
			useProjectAgentConfig: true,
			timeoutAt: new Date('2026-01-02T03:05:05.000Z')
		});
		expect(JSON.parse(res.content[0].text)).toEqual({ runId: 'r1' });
		expect(res.isError).toBeFalsy();
	});

	it('approve_run schema accepte push_pr et abandon mais refuse push', () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		const schema = z.object(s.schemas.approve_run);

		expect(schema.safeParse({ runId: 'r1', action: 'push_pr' }).success).toBe(true);
		expect(schema.safeParse({ runId: 'r1', action: 'abandon' }).success).toBe(true);
		expect(schema.safeParse({ runId: 'r1', action: 'push' }).success).toBe(false);
	});

	it('approve_run appelle le service et retourne uniquement la forme publique', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedResolveOrgContext.mockResolvedValue('org1');
		mockedGetGithubTokenForUser.mockResolvedValue('gh-token');
		mockedApproveRunForOrg.mockResolvedValue({
			status: 'completed',
			pullRequestUrl: 'https://github.com/acme/repo/pull/1',
			projectId: 'p1'
		});

		const res = await s.tools.approve_run({ runId: 'r1', action: 'push_pr', team: 'core' });

		expect(resolveOrgContext).toHaveBeenCalledWith('u1', 'core');
		expect(getGithubTokenForUser).toHaveBeenCalledWith('u1');
		expect(approveRunForOrg).toHaveBeenCalledWith({
			organizationId: 'org1',
			githubToken: 'gh-token',
			runId: 'r1',
			action: 'push_pr'
		});
		expect(JSON.parse(res.content[0].text)).toEqual({
			status: 'completed',
			pullRequestUrl: 'https://github.com/acme/repo/pull/1'
		});
	});

	it('cancel_run et reply_to_run mappent les resultats null en Run not found', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedResolveOrgContext.mockResolvedValue('org1');
		mockedCancelRunForOrg.mockResolvedValue(null);
		mockedReplyToRunForOrg.mockResolvedValue(null);

		const cancelRes = await s.tools.cancel_run({ runId: 'missing' });
		const replyRes = await s.tools.reply_to_run({ runId: 'missing', message: 'continue' });

		expect(cancelRes.isError).toBe(true);
		expect(cancelRes.content[0].text).toBe('Run not found');
		expect(replyRes.isError).toBe(true);
		expect(replyRes.content[0].text).toBe('Run not found');
		expect(cancelRunForOrg).toHaveBeenCalledWith('org1', 'missing');
		expect(replyToRunForOrg).toHaveBeenCalledWith('org1', {
			runId: 'missing',
			message: 'continue',
			timeoutAt: new Date('2026-01-02T03:05:05.000Z')
		});
	});

	it('mappe les erreurs metier write en isError avec le message', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedResolveOrgContext.mockResolvedValue('org1');
		mockedGetGithubTokenForUser.mockResolvedValue('gh-token');
		mockedApproveRunForOrg.mockRejectedValue(
			new RunMutationError('Run is not awaiting review (status: running)')
		);

		const res = await s.tools.approve_run({ runId: 'r1', action: 'abandon' });

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toBe('Run is not awaiting review (status: running)');
	});
});
