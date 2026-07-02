import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRefreshableRemoteCommand, mockRemoteQueryState } from './remote-test-helpers';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	requireHeaders: vi.fn(),
	requireActiveOrg: vi.fn(),
	requireActor: vi.fn(),
	requireProjectPermission: vi.fn(),
	requireRunPermission: vi.fn(),
	getGithubToken: vi.fn(),
	startRunForOrg: vi.fn(),
	cancelRunForOrg: vi.fn(),
	approveRunForOrg: vi.fn(),
	projectFindFirst: vi.fn(),
	runInteractionFindFirst: vi.fn(),
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

vi.mock('$app/server', () => ({
	command: vi.fn((schemaOrHandler, maybeHandler) =>
		mockRefreshableRemoteCommand(maybeHandler ?? schemaOrHandler)
	),
	query: vi.fn((schemaOrHandler, maybeHandler) => {
		const handler = maybeHandler ?? schemaOrHandler;
		return mockRemoteQueryState(handler);
	}),
	getRequestEvent: mocks.getRequestEvent
}));

vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));

vi.mock('$env/dynamic/private', () => ({ env: { RUN_TIMEOUT_MS: '60000' } }));
vi.mock('$lib/server/auth/request', () => ({ requireHeaders: mocks.requireHeaders }));
vi.mock('$lib/server/auth/org', () => ({ requireActiveOrg: mocks.requireActiveOrg }));
vi.mock('$lib/server/authz/actor', () => ({ requireActor: mocks.requireActor }));
vi.mock('$lib/server/authz/service', () => ({
	requireProjectPermission: mocks.requireProjectPermission
}));
vi.mock('$lib/server/authz/runs', () => ({
	requireRunPermission: mocks.requireRunPermission
}));
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
		runInteraction: { findFirst: mocks.runInteractionFindFirst },
		pullRequest: { create: mocks.pullRequestCreate }
	}
}));
vi.mock('$lib/server/runtime/queue', () => ({ enqueueRun: mocks.enqueueRun }));
vi.mock('$lib/server/projects/branches', () => ({
	assertProjectBranchExists: mocks.assertProjectBranchExists
}));
vi.mock('$lib/server/integrations/github/pull-requests', () => ({
	pushBranch: mocks.pushBranch,
	openPullRequest: mocks.openPullRequest
}));
vi.mock('$lib/server/projects/workspace', () => ({ removeRunCheckout: mocks.removeRunCheckout }));
vi.mock('$lib/server/runtime/docker', () => ({ killContainer: mocks.killContainer }));
vi.mock('$lib/server/projects/workspace-paths', () => ({
	agentBranch: (runId: string) => `agent/${runId}`,
	runWorktreePath: (...parts: string[]) => parts.join('/'),
	workspaceRoot: () => '/workspace',
	containerName: (runId: string) => `dotweaver-${runId}`
}));
vi.mock('$lib/server/runs/transitions', () => ({ transitionRun: mocks.transitionRun }));
vi.mock('$lib/server/project-agent-config/service', () => ({
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
vi.mock('$lib/server/project-agent-config/service', () => ({
	buildRunAgentConfig: mocks.buildRunAgentConfig,
	ProjectAgentConfigError: class extends Error {}
}));

import {
	answerRunInteraction,
	approveRun,
	cancelRun,
	getRun,
	getRunDiff,
	listRuns,
	startRun
} from '$lib/rfc/runs.remote';

const listRunsMock = listRuns as typeof listRuns & {
	serverHandler: (projectId: string) => Promise<unknown>;
};
const getRunMock = getRun as typeof getRun & {
	serverHandler: (runId: string) => Promise<unknown>;
};
const getRunDiffMock = getRunDiff as typeof getRunDiff & {
	serverHandler: (runId: string) => Promise<unknown>;
};

describe('runs.remote commands', () => {
	const headers = new Headers({ cookie: 'session=abc' });

	beforeEach(() => {
		vi.resetAllMocks();
		vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
		mocks.requireHeaders.mockReturnValue(headers);
		mocks.requireActiveOrg.mockResolvedValue('org1');
		mocks.requireActor.mockResolvedValue({ userId: 'user1' });
		mocks.requireProjectPermission.mockResolvedValue({ id: 'p1', organizationId: 'org1' });
		mocks.requireRunPermission.mockResolvedValue({
			id: 'r1',
			projectId: 'p1',
			organizationId: 'org1'
		});
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'user1' } } });
		mocks.getGithubToken.mockResolvedValue('gh-token');
		mocks.runInteractionFindFirst.mockResolvedValue({ runId: 'r1' });
	});

	it('listRuns requires run.view on the project and uses the project organization', async () => {
		mocks.listRunsForOrg.mockResolvedValue([{ id: 'r1' }]);

		await expect(listRunsMock.serverHandler('p1')).resolves.toEqual([{ id: 'r1' }]);

		expect(mocks.requireActor).toHaveBeenCalled();
		expect(mocks.requireProjectPermission).toHaveBeenCalledWith(
			{ userId: 'user1' },
			'run.view',
			'p1'
		);
		expect(mocks.listRunsForOrg).toHaveBeenCalledWith('org1', 'p1');
	});

	it('listRuns blocks without run.view before listing runs', async () => {
		mocks.requireProjectPermission.mockRejectedValueOnce(
			Object.assign(new Error('Forbidden'), { status: 403 })
		);

		await expect(listRunsMock.serverHandler('p1')).rejects.toMatchObject({
			status: 403,
			message: 'Forbidden'
		});
		expect(mocks.listRunsForOrg).not.toHaveBeenCalled();
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
		expect(mocks.requireProjectPermission).toHaveBeenCalledWith(
			{ userId: 'user1' },
			'run.create',
			'p1'
		);
	});

	it('startRun blocks without run.create before starting a run', async () => {
		mocks.requireProjectPermission.mockRejectedValueOnce(
			Object.assign(new Error('Forbidden'), { status: 403 })
		);

		await expect(startRun({ projectId: 'p1', prompt: 'do it' })).rejects.toMatchObject({
			status: 403,
			message: 'Forbidden'
		});
		expect(mocks.startRunForOrg).not.toHaveBeenCalled();
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
		expect(mocks.requireRunPermission).toHaveBeenCalledWith({ userId: 'user1' }, 'run.reply', 'r1');
	});

	it('getRun blocks without run.view before loading run details', async () => {
		mocks.requireRunPermission.mockRejectedValueOnce(
			Object.assign(new Error('Forbidden'), { status: 403 })
		);

		await expect(getRunMock.serverHandler('r1')).rejects.toMatchObject({
			status: 403,
			message: 'Forbidden'
		});
		expect(mocks.getRunForOrg).not.toHaveBeenCalled();
	});

	it('getRunDiff requires run.diff.view before computing a diff', async () => {
		mocks.getRunDiffForOrg.mockResolvedValue('diff --git');

		await expect(getRunDiffMock.serverHandler('r1')).resolves.toBe('diff --git');

		expect(mocks.requireRunPermission).toHaveBeenCalledWith(
			{ userId: 'user1' },
			'run.diff.view',
			'r1'
		);
		expect(mocks.getRunDiffForOrg).toHaveBeenCalledWith('org1', 'r1');
	});

	it('answerRunInteraction maps hidden parent runs to 404 Interaction not found', async () => {
		mocks.requireRunPermission.mockRejectedValueOnce(
			Object.assign(new Error('Run not found'), { status: 404 })
		);

		await expect(
			answerRunInteraction({
				interactionId: 'i1',
				answers: { Question: { selected: ['Yes'] } }
			})
		).rejects.toMatchObject({
			status: 404,
			message: 'Interaction not found'
		});

		expect(mocks.runInteractionFindFirst).toHaveBeenCalledWith({
			where: { id: 'i1' },
			select: { runId: true }
		});
		expect(mocks.requireRunPermission).toHaveBeenCalledWith({ userId: 'user1' }, 'run.reply', 'r1');
		expect(mocks.answerPendingRunInteractionForOrg).not.toHaveBeenCalled();
	});

	it('answerRunInteraction preserves 403 when the parent run is visible but run.reply is missing', async () => {
		mocks.requireRunPermission.mockRejectedValueOnce(
			Object.assign(new Error('Forbidden'), { status: 403 })
		);

		await expect(
			answerRunInteraction({
				interactionId: 'i1',
				answers: { Question: { selected: ['Yes'] } }
			})
		).rejects.toMatchObject({
			status: 403,
			message: 'Forbidden'
		});

		expect(mocks.answerPendingRunInteractionForOrg).not.toHaveBeenCalled();
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
