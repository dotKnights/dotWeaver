import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { z } from 'zod';

vi.mock('$lib/server/mcp/context', () => ({
	resolveOrgContext: vi.fn(),
	resolveMcpActor: vi.fn(),
	AmbiguousTeamError: class extends Error {
		constructor(public slugs: string[] = []) {
			super(`Multiple teams available - specify one of: ${slugs.join(', ')}`);
		}
	},
	TeamAccessError: class extends Error {},
	NoTeamError: class extends Error {}
}));
vi.mock('$lib/server/projects/service', () => ({
	listProjectsForOrg: vi.fn(),
	getProjectForActor: vi.fn(),
	getProjectForOrg: vi.fn(),
	importGithubProjectForOrg: vi.fn(),
	GithubProjectImportError: class GithubProjectImportError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'GithubProjectImportError';
		}
	}
}));
vi.mock('$lib/server/authz/service', () => ({
	listAccessibleProjects: vi.fn(),
	requireProjectPermission: vi.fn()
}));
vi.mock('$lib/server/authz/runs', () => ({
	requireRunPermission: vi.fn()
}));
vi.mock('$lib/server/runs/service', () => ({
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
vi.mock('$lib/server/runs/reply-service', () => ({
	replyToRunForOrg: vi.fn(),
	RunReplyError: class RunReplyError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'RunReplyError';
		}
	}
}));
vi.mock('$lib/server/runs/interactions-service', () => ({
	answerPendingRunQuestionTextForOrg: vi.fn(),
	RunInteractionAnswerError: class RunInteractionAnswerError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'RunInteractionAnswerError';
		}
	}
}));
vi.mock('$lib/server/runs/stream', () => ({ streamRunEvents: vi.fn() }));
vi.mock('$lib/server/integrations/github/git-auth', () => ({ getGithubTokenForUser: vi.fn() }));
vi.mock('$lib/server/project-agent-config/service', () => ({
	ProjectAgentConfigError: class ProjectAgentConfigError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'ProjectAgentConfigError';
		}
	}
}));
vi.mock('$lib/server/teams/service', () => ({ listTeamsForUser: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({ env: { RUN_TIMEOUT_MS: '60000' } }));

import { resolveOrgContext, resolveMcpActor, AmbiguousTeamError } from '$lib/server/mcp/context';
import { getProjectForActor, importGithubProjectForOrg } from '$lib/server/projects/service';
import { listAccessibleProjects, requireProjectPermission } from '$lib/server/authz/service';
import { requireRunPermission } from '$lib/server/authz/runs';
import {
	listRunsForOrg,
	getRunForOrg,
	getRunDiffForOrg,
	startRunForOrg,
	cancelRunForOrg,
	approveRunForOrg,
	RunMutationError
} from '$lib/server/runs/service';
import { replyToRunForOrg } from '$lib/server/runs/reply-service';
import {
	answerPendingRunQuestionTextForOrg,
	RunInteractionAnswerError
} from '$lib/server/runs/interactions-service';
import { streamRunEvents } from '$lib/server/runs/stream';
import { getGithubTokenForUser } from '$lib/server/integrations/github/git-auth';
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
const mockedResolveMcpActor = vi.mocked(resolveMcpActor) as Mock<
	(userId: string) => Promise<unknown>
>;
const mockedListAccessibleProjects = vi.mocked(listAccessibleProjects) as Mock<
	(actor: unknown) => Promise<ProjectRow[]>
>;
const mockedGetProjectForActor = vi.mocked(getProjectForActor) as Mock<
	(actor: unknown, projectId: string) => Promise<ProjectRow | null>
>;
const mockedRequireProjectPermission = vi.mocked(requireProjectPermission) as Mock<
	(actor: unknown, permission: string, projectId: string) => Promise<{ organizationId: string }>
>;
const mockedRequireRunPermission = vi.mocked(requireRunPermission) as Mock<
	(
		actor: unknown,
		permission: string,
		runId: string
	) => Promise<{ id: string; projectId: string; organizationId: string }>
>;
const mockedListRunsForOrg = vi.mocked(listRunsForOrg) as Mock<
	(orgId: string, projectId: string) => Promise<unknown[]>
>;
const mockedGetRunForOrg = vi.mocked(getRunForOrg) as Mock<
	(orgId: string, runId: string) => Promise<unknown | null>
>;
const mockedGetRunDiffForOrg = vi.mocked(getRunDiffForOrg) as Mock<
	(orgId: string, runId: string) => Promise<string | null>
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
const mockedAnswerPendingRunQuestionTextForOrg = vi.mocked(
	answerPendingRunQuestionTextForOrg
) as Mock<(orgId: string, input: Record<string, unknown>) => Promise<unknown | null>>;
const mockedStreamRunEvents = vi.mocked(streamRunEvents) as Mock<
	(runId: string, opts?: Record<string, unknown>) => AsyncIterable<unknown>
>;
const mockedGetGithubTokenForUser = vi.mocked(getGithubTokenForUser) as Mock<
	(userId: string) => Promise<string | null>
>;

async function* emptyRunEventStream() {
	// no events needed for guard tests
}

describe('registerTools', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
		mockedResolveMcpActor.mockResolvedValue({ userId: 'u1' });
		mockedRequireProjectPermission.mockResolvedValue({ organizationId: 'org1' });
		mockedRequireRunPermission.mockResolvedValue({
			id: 'r1',
			projectId: 'p1',
			organizationId: 'org1'
		});
		mockedStreamRunEvents.mockReturnValue(emptyRunEventStream());
	});

	it('enregistre les 13 outils read et write', () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		expect(Object.keys(s.tools).sort()).toEqual([
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
	});

	it('list_projects retourne uniquement les projets accessibles a l acteur MCP', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedListAccessibleProjects.mockResolvedValue([{ id: 'p1' }]);
		const res = await s.tools.list_projects({ team: 'acme' });
		expect(resolveMcpActor).toHaveBeenCalledWith('u1');
		expect(listAccessibleProjects).toHaveBeenCalledWith({ userId: 'u1' });
		expect(resolveOrgContext).not.toHaveBeenCalled();
		expect(JSON.parse(res.content[0].text)).toEqual([{ id: 'p1' }]);
		expect(res.isError).toBeFalsy();
	});

	it('get_project uses actor-aware visibility and hides inaccessible projects', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedGetProjectForActor.mockResolvedValueOnce(null);

		const res = await s.tools.get_project({ projectId: 'p1' });

		expect(resolveMcpActor).toHaveBeenCalledWith('u1');
		expect(getProjectForActor).toHaveBeenCalledWith({ userId: 'u1' }, 'p1');
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toBe('Project not found');
	});

	it('get_run renvoie isError si ressource introuvable', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedRequireRunPermission.mockResolvedValue({
			id: 'x',
			projectId: 'p1',
			organizationId: 'org1'
		});
		mockedGetRunForOrg.mockResolvedValue(null);
		const res = await s.tools.get_run({ runId: 'x' });
		expect(requireRunPermission).toHaveBeenCalledWith({ userId: 'u1' }, 'run.view', 'x');
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/not found/i);
	});

	it('mappe AmbiguousTeamError en isError listant les slugs', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		const err = new AmbiguousTeamError(['acme', 'globex']);
		mockedResolveOrgContext.mockRejectedValue(err);
		const res = await s.tools.import_github_project({ owner: 'acme', name: 'repo' });
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

	it('list_runs requires run.view on the project and uses the project organization', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedListRunsForOrg.mockResolvedValue([{ id: 'r1' }]);

		const res = await s.tools.list_runs({ projectId: 'p1', team: 'core' });

		expect(resolveMcpActor).toHaveBeenCalledWith('u1');
		expect(requireProjectPermission).toHaveBeenCalledWith({ userId: 'u1' }, 'run.view', 'p1');
		expect(listRunsForOrg).toHaveBeenCalledWith('org1', 'p1');
		expect(JSON.parse(res.content[0].text)).toEqual([{ id: 'r1' }]);
		expect(res.isError).toBeFalsy();
	});

	it('start_run requires run.create, recupere le token et applique timeout et config agent par defaut', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedGetGithubTokenForUser.mockResolvedValue('gh-token');
		mockedStartRunForOrg.mockResolvedValue({ runId: 'r1', projectId: 'p1' });

		const res = await s.tools.start_run({
			projectId: 'p1',
			prompt: 'do it',
			baseBranch: 'main',
			model: 'sonnet',
			team: 'core'
		});

		expect(resolveMcpActor).toHaveBeenCalledWith('u1');
		expect(requireProjectPermission).toHaveBeenCalledWith({ userId: 'u1' }, 'run.create', 'p1');
		expect(resolveOrgContext).not.toHaveBeenCalled();
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

	it('answer_pending_question schema refuse les messages vides ou blancs', () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		const schema = z.object(s.schemas.answer_pending_question);

		expect(schema.safeParse({ runId: 'r1', message: 'Compact' }).success).toBe(true);
		expect(schema.safeParse({ runId: 'r1', message: '' }).success).toBe(false);
		expect(schema.safeParse({ runId: 'r1', message: '   ' }).success).toBe(false);
	});

	it('approve_run appelle le service et retourne uniquement la forme publique', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedGetGithubTokenForUser.mockResolvedValue('gh-token');
		mockedApproveRunForOrg.mockResolvedValue({
			status: 'completed',
			pullRequestUrl: 'https://github.com/acme/repo/pull/1',
			projectId: 'p1'
		});

		const res = await s.tools.approve_run({ runId: 'r1', action: 'push_pr', team: 'core' });

		expect(resolveMcpActor).toHaveBeenCalledWith('u1');
		expect(requireRunPermission).toHaveBeenCalledWith({ userId: 'u1' }, 'run.approve', 'r1');
		expect(resolveOrgContext).not.toHaveBeenCalled();
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
		mockedCancelRunForOrg.mockResolvedValue(null);
		mockedReplyToRunForOrg.mockResolvedValue(null);

		const cancelRes = await s.tools.cancel_run({ runId: 'missing' });
		const replyRes = await s.tools.reply_to_run({ runId: 'missing', message: 'continue' });

		expect(cancelRes.isError).toBe(true);
		expect(cancelRes.content[0].text).toBe('Run not found');
		expect(replyRes.isError).toBe(true);
		expect(replyRes.content[0].text).toBe('Run not found');
		expect(requireRunPermission).toHaveBeenCalledWith({ userId: 'u1' }, 'run.reply', 'missing');
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
		mockedGetGithubTokenForUser.mockResolvedValue('gh-token');
		mockedApproveRunForOrg.mockRejectedValue(
			new RunMutationError('Run is not awaiting review (status: running)')
		);

		const res = await s.tools.approve_run({ runId: 'r1', action: 'abandon' });

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toBe('Run is not awaiting review (status: running)');
	});

	it('answer_pending_question resolves org and answers a pending interaction from text', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedAnswerPendingRunQuestionTextForOrg.mockResolvedValue({ runId: 'r1', projectId: 'p1' });

		const res = await s.tools.answer_pending_question({
			runId: 'r1',
			message: 'Use Compact',
			team: 'core'
		});

		expect(resolveMcpActor).toHaveBeenCalledWith('u1');
		expect(requireRunPermission).toHaveBeenCalledWith({ userId: 'u1' }, 'run.reply', 'r1');
		expect(resolveOrgContext).not.toHaveBeenCalled();
		expect(answerPendingRunQuestionTextForOrg).toHaveBeenCalledWith('org1', {
			runId: 'r1',
			message: 'Use Compact'
		});
		expect(JSON.parse(res.content[0].text)).toEqual({ answered: true });
		expect(res.isError).toBeFalsy();
	});

	it('answer_pending_question maps null and interaction errors to tool errors', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedAnswerPendingRunQuestionTextForOrg.mockResolvedValueOnce(null);

		const missing = await s.tools.answer_pending_question({ runId: 'missing', message: 'Compact' });

		mockedAnswerPendingRunQuestionTextForOrg.mockRejectedValueOnce(
			new RunInteractionAnswerError('No pending question for this run')
		);
		const noQuestion = await s.tools.answer_pending_question({ runId: 'r1', message: 'Compact' });

		expect(missing.isError).toBe(true);
		expect(missing.content[0].text).toBe('Run not found');
		expect(noQuestion.isError).toBe(true);
		expect(noQuestion.content[0].text).toBe('No pending question for this run');
	});

	it('maps project authz errors to safe tool failures without stack traces', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		const err = Object.assign(new Error('Forbidden\n    at internal'), { status: 403 });
		mockedRequireProjectPermission.mockRejectedValueOnce(err);

		const res = await s.tools.list_runs({ projectId: 'p1' });

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toBe('Forbidden');
		expect(res.content[0].text).not.toContain('internal');
		expect(listRunsForOrg).not.toHaveBeenCalled();
	});

	it('maps missing project authz errors to Project not found', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedRequireProjectPermission.mockRejectedValueOnce(
			Object.assign(new Error('Project p1 missing\n    at internal'), { status: 404 })
		);

		const res = await s.tools.start_run({ projectId: 'p1', prompt: 'do it' });

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toBe('Project not found');
		expect(res.content[0].text).not.toContain('internal');
		expect(startRunForOrg).not.toHaveBeenCalled();
	});

	it('maps missing run authz errors to Run not found without stack traces', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedRequireRunPermission.mockRejectedValueOnce(
			Object.assign(new Error('Run r1 missing\n    at internal'), { status: 404 })
		);

		const res = await s.tools.get_run({ runId: 'r1' });

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toBe('Run not found');
		expect(res.content[0].text).not.toContain('internal');
		expect(getRunForOrg).not.toHaveBeenCalled();
	});

	it('get_run_diff requires run.diff.view before computing a diff', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedGetRunDiffForOrg.mockResolvedValue('diff --git');

		const res = await s.tools.get_run_diff({ runId: 'r1' });

		expect(resolveMcpActor).toHaveBeenCalledWith('u1');
		expect(requireRunPermission).toHaveBeenCalledWith({ userId: 'u1' }, 'run.diff.view', 'r1');
		expect(getRunDiffForOrg).toHaveBeenCalledWith('org1', 'r1');
		expect(JSON.parse(res.content[0].text)).toBe('diff --git');
		expect(res.isError).toBeFalsy();
	});

	it('stream_run_events requires run.view before loading the run or streaming', async () => {
		const s = fakeServer();
		registerTools(s, { userId: 'u1' });
		mockedGetRunForOrg.mockResolvedValue({ id: 'r1', status: 'completed' });

		const res = await s.tools.stream_run_events({ runId: 'r1' });

		expect(resolveMcpActor).toHaveBeenCalledWith('u1');
		expect(requireRunPermission).toHaveBeenCalledWith({ userId: 'u1' }, 'run.view', 'r1');
		expect(getRunForOrg).toHaveBeenCalledWith('org1', 'r1');
		expect(streamRunEvents).toHaveBeenCalledWith('r1', { signal: undefined });
		expect(mockedRequireRunPermission.mock.invocationCallOrder[0]).toBeLessThan(
			mockedGetRunForOrg.mock.invocationCallOrder[0]
		);
		expect(mockedGetRunForOrg.mock.invocationCallOrder[0]).toBeLessThan(
			mockedStreamRunEvents.mock.invocationCallOrder[0]
		);
		expect(JSON.parse(res.content[0].text)).toEqual({ status: 'completed', events: [] });
		expect(res.isError).toBeFalsy();
	});
});
