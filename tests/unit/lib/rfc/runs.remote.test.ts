import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	requireHeaders: vi.fn(),
	requireActiveOrg: vi.fn(),
	getGithubToken: vi.fn(),
	startRunForOrg: vi.fn(),
	cancelRunForOrg: vi.fn(),
	approveRunForOrg: vi.fn(),
	projectFindFirst: vi.fn(),
	runCreate: vi.fn(),
	runFindFirst: vi.fn(),
	runUpdateMany: vi.fn(),
	pullRequestCreate: vi.fn(),
	enqueueRun: vi.fn(),
	assertProjectBranchExists: vi.fn(),
	pushBranch: vi.fn(),
	openPullRequest: vi.fn(),
	removeRunCheckout: vi.fn(),
	killContainer: vi.fn(),
	transitionRun: vi.fn(),
	answerPendingRunInteractionForOrg: vi.fn(),
	cancelPendingRunInteractions: vi.fn(),
	listRunsForOrg: vi.fn(),
	getRunForOrg: vi.fn(),
	getRunDiffForOrg: vi.fn(),
	replyToRunForOrg: vi.fn(),
	buildRunAgentConfig: vi.fn(),
	ProjectAgentConfigError: class ProjectAgentConfigError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'ProjectAgentConfigError';
		}
	},
	RunMutationError: class RunMutationError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'RunMutationError';
		}
	}
}));

function remoteHandle<T extends (...args: never[]) => unknown>(
	handler: T
): T & { refresh: () => Promise<void> } {
	const wrapped = vi.fn(handler) as unknown as T & {
		__: { type: 'command' };
		refresh: () => Promise<void>;
	};
	wrapped.__ = { type: 'command' };
	wrapped.refresh = vi.fn(async () => undefined);
	return wrapped;
}

vi.mock('$app/server', () => ({
	command: vi.fn((schemaOrHandler, maybeHandler) => remoteHandle(maybeHandler ?? schemaOrHandler)),
	query: vi.fn((schemaOrHandler, maybeHandler) => {
		const handler = maybeHandler ?? schemaOrHandler;
		const wrapped = vi.fn(() => ({
			current: undefined,
			error: undefined,
			refresh: vi.fn(async () => undefined)
		})) as unknown as { __: { type: 'query' }; serverHandler: unknown };
		wrapped.__ = { type: 'query' };
		wrapped.serverHandler = handler;
		return wrapped;
	}),
	getRequestEvent: mocks.getRequestEvent
}));

vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));

vi.mock('$env/dynamic/private', () => ({ env: { RUN_TIMEOUT_MS: '60000' } }));
vi.mock('$lib/server/utils', () => ({ requireHeaders: mocks.requireHeaders }));
vi.mock('$lib/server/org', () => ({ requireActiveOrg: mocks.requireActiveOrg }));
vi.mock('$lib/server/integrations/github/service', () => ({
	getGithubToken: mocks.getGithubToken
}));
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		project: { findFirst: mocks.projectFindFirst },
		run: {
			create: mocks.runCreate,
			findFirst: mocks.runFindFirst,
			updateMany: mocks.runUpdateMany
		},
		pullRequest: { create: mocks.pullRequestCreate }
	}
}));
vi.mock('$lib/server/queue', () => ({ enqueueRun: mocks.enqueueRun }));
vi.mock('$lib/server/project-branches-service', () => ({
	assertProjectBranchExists: mocks.assertProjectBranchExists
}));
vi.mock('$lib/server/integrations/github/pull-requests', () => ({
	pushBranch: mocks.pushBranch,
	openPullRequest: mocks.openPullRequest
}));
vi.mock('$lib/server/workspace', () => ({ removeRunCheckout: mocks.removeRunCheckout }));
vi.mock('$lib/server/docker', () => ({ killContainer: mocks.killContainer }));
vi.mock('$lib/server/workspace-paths', () => ({
	agentBranch: (runId: string) => `agent/${runId}`,
	runWorktreePath: (...parts: string[]) => parts.join('/'),
	workspaceRoot: () => '/workspace',
	containerName: (runId: string) => `dotweaver-${runId}`
}));
vi.mock('$lib/server/runs/transitions', () => ({ transitionRun: mocks.transitionRun }));
vi.mock('$lib/server/project-agent-config-service', () => ({
	buildRunAgentConfig: vi.fn(),
	ProjectAgentConfigError: mocks.ProjectAgentConfigError
}));
vi.mock('$lib/server/runs/service', () => ({
	listRunsForOrg: mocks.listRunsForOrg,
	getRunForOrg: mocks.getRunForOrg,
	getRunDiffForOrg: mocks.getRunDiffForOrg,
	startRunForOrg: mocks.startRunForOrg,
	cancelRunForOrg: mocks.cancelRunForOrg,
	approveRunForOrg: mocks.approveRunForOrg,
	RunMutationError: mocks.RunMutationError,
	RunWorkspaceUnavailableError: class extends Error {}
}));
vi.mock('$lib/server/runs/interactions-service', () => ({
	answerPendingRunInteractionForOrg: mocks.answerPendingRunInteractionForOrg,
	cancelPendingRunInteractions: mocks.cancelPendingRunInteractions,
	RunInteractionAnswerError: class extends Error {}
}));
vi.mock('$lib/server/runs/reply-service', () => ({
	replyToRunForOrg: mocks.replyToRunForOrg,
	RunReplyError: class extends Error {}
}));
vi.mock('$lib/server/project-agent-config-service', () => ({
	buildRunAgentConfig: mocks.buildRunAgentConfig,
	ProjectAgentConfigError: class extends Error {}
}));

import { approveRun, cancelRun, getRun, startRun } from '$lib/rfc/runs.remote';

describe('runs.remote commands', () => {
	const headers = new Headers({ cookie: 'session=abc' });

	beforeEach(() => {
		vi.resetAllMocks();
		vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
		mocks.requireHeaders.mockReturnValue(headers);
		mocks.requireActiveOrg.mockResolvedValue('org1');
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'user1' } } });
		mocks.getGithubToken.mockResolvedValue('gh-token');
	});

	it('startRun delegates to startRunForOrg with org, user, token, input, and timeout', async () => {
		mocks.startRunForOrg.mockResolvedValue({ runId: 'r1', projectId: 'p1' });

		await expect(
			startRun({
				projectId: 'p1',
				prompt: 'do it',
				agent: 'codex',
				baseBranch: 'feature/login',
				model: 'gpt-5.5',
				useProjectAgentConfig: true
			})
		).resolves.toEqual({ runId: 'r1' });

		expect(mocks.startRunForOrg).toHaveBeenCalledWith({
			organizationId: 'org1',
			userId: 'user1',
			githubToken: 'gh-token',
			projectId: 'p1',
			prompt: 'do it',
			agent: 'codex',
			baseBranch: 'feature/login',
			model: 'gpt-5.5',
			useProjectAgentConfig: true,
			timeoutAt: new Date('2026-01-02T03:05:05.000Z')
		});
	});

	it('startRun maps service null to 404 Project not found', async () => {
		mocks.startRunForOrg.mockResolvedValue(null);

		await expect(startRun({ projectId: 'missing', prompt: 'do it' })).rejects.toMatchObject({
			status: 404,
			message: 'Project not found'
		});
	});

	it('startRun maps base branch validation errors to 400', async () => {
		mocks.startRunForOrg.mockRejectedValue(new Error('Base branch "missing" was not found'));

		await expect(
			startRun({ projectId: 'p1', prompt: 'do it', baseBranch: 'missing' })
		).rejects.toMatchObject({
			status: 400,
			message: 'Base branch "missing" was not found'
		});
	});

	it('cancelRun delegates to cancelRunForOrg and returns canceled state', async () => {
		mocks.cancelRunForOrg.mockResolvedValue({ canceled: true, projectId: 'p1' });

		await expect(cancelRun('r1')).resolves.toEqual({ canceled: true });

		expect(mocks.cancelRunForOrg).toHaveBeenCalledWith('org1', 'r1');
	});

	it('approveRun delegates push_pr to approveRunForOrg with token and returns PR URL', async () => {
		mocks.approveRunForOrg.mockResolvedValue({
			status: 'completed',
			pullRequestUrl: 'https://github.com/acme/repo/pull/42',
			projectId: 'p1'
		});

		await expect(approveRun({ runId: 'r1', action: 'push_pr' })).resolves.toEqual({
			status: 'completed',
			pullRequestUrl: 'https://github.com/acme/repo/pull/42'
		});

		expect(mocks.approveRunForOrg).toHaveBeenCalledWith({
			organizationId: 'org1',
			githubToken: 'gh-token',
			runId: 'r1',
			action: 'push_pr'
		});
	});

	it('approveRun still delegates push action for web push behavior', async () => {
		mocks.approveRunForOrg.mockResolvedValue({
			status: 'completed',
			pullRequestUrl: null,
			projectId: 'p1'
		});

		await expect(approveRun({ runId: 'r1', action: 'push' })).resolves.toEqual({
			status: 'completed',
			pullRequestUrl: null
		});

		expect(mocks.approveRunForOrg).toHaveBeenCalledWith({
			organizationId: 'org1',
			githubToken: 'gh-token',
			runId: 'r1',
			action: 'push'
		});
	});

	it('approveRun preserves service null as 404 Run not found', async () => {
		mocks.approveRunForOrg.mockResolvedValue(null);

		await expect(approveRun({ runId: 'missing', action: 'push_pr' })).rejects.toMatchObject({
			status: 404,
			message: 'Run not found'
		});
	});

	it('approveRun maps concurrent review claim failures to 409', async () => {
		mocks.approveRunForOrg.mockRejectedValue(
			new mocks.RunMutationError('Run is no longer awaiting review')
		);

		await expect(approveRun({ runId: 'r1', action: 'abandon' })).rejects.toMatchObject({
			status: 409,
			message: 'Run is no longer awaiting review'
		});
	});

	it('approveRun maps non-concurrency mutation failures to 400', async () => {
		mocks.approveRunForOrg.mockRejectedValue(
			new mocks.RunMutationError('Run is not awaiting review (status: running)')
		);

		await expect(approveRun({ runId: 'r1', action: 'push_pr' })).rejects.toMatchObject({
			status: 400,
			message: 'Run is not awaiting review (status: running)'
		});
	});

	it('approveRun refreshes the run and surfaces a 500 when push fails after claim', async () => {
		mocks.approveRunForOrg.mockRejectedValue(new Error('Open PR failed'));

		await expect(approveRun({ runId: 'r1', action: 'push_pr' })).rejects.toMatchObject({
			status: 500,
			message: 'Open PR failed'
		});

		expect(getRun).toHaveBeenCalledWith('r1');
		const runQueryResult = vi.mocked(getRun).mock.results[0]?.value;
		expect(runQueryResult.refresh).toHaveBeenCalled();
	});
});
