import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	RunStartError: class RunStartError extends Error {},
	getRequestEvent: vi.fn(),
	requireHeaders: vi.fn(),
	requireActiveOrg: vi.fn(),
	startRunForOrg: vi.fn(),
	projectFindFirst: vi.fn(),
	runCreate: vi.fn(),
	runFindFirst: vi.fn(),
	runUpdate: vi.fn(),
	runUpdateMany: vi.fn(),
	pullRequestCreate: vi.fn(),
	enqueueRun: vi.fn(),
	getGithubToken: vi.fn(),
	pushBranch: vi.fn(),
	openPullRequest: vi.fn(),
	removeRunCheckout: vi.fn(),
	killContainer: vi.fn(),
	answerPendingRunInteractionForOrg: vi.fn(),
	cancelPendingRunInteractions: vi.fn(),
	listRunsForOrg: vi.fn(),
	getRunForOrg: vi.fn(),
	getRunDiffForOrg: vi.fn(),
	assertProjectBranchExists: vi.fn(),
	buildRunAgentConfig: vi.fn()
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
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		project: { findFirst: mocks.projectFindFirst },
		run: {
			create: mocks.runCreate,
			findFirst: mocks.runFindFirst,
			update: mocks.runUpdate,
			updateMany: mocks.runUpdateMany
		},
		pullRequest: { create: mocks.pullRequestCreate }
	}
}));
vi.mock('$lib/server/queue', () => ({ enqueueRun: mocks.enqueueRun }));
vi.mock('$lib/server/github', () => ({ getGithubToken: mocks.getGithubToken }));
vi.mock('$lib/server/github-push', () => ({
	pushBranch: mocks.pushBranch,
	openPullRequest: mocks.openPullRequest
}));
vi.mock('$lib/server/workspace', () => ({ removeRunCheckout: mocks.removeRunCheckout }));
vi.mock('$lib/server/docker', () => ({ killContainer: mocks.killContainer }));
vi.mock('$lib/server/runs-service', () => ({
	listRunsForOrg: mocks.listRunsForOrg,
	getRunForOrg: mocks.getRunForOrg,
	getRunDiffForOrg: mocks.getRunDiffForOrg,
	RunWorkspaceUnavailableError: class extends Error {}
}));
vi.mock('$lib/server/run-interactions-service', () => ({
	answerPendingRunInteractionForOrg: mocks.answerPendingRunInteractionForOrg,
	cancelPendingRunInteractions: mocks.cancelPendingRunInteractions,
	RunInteractionAnswerError: class extends Error {}
}));
vi.mock('$lib/server/project-branches-service', () => ({
	assertProjectBranchExists: mocks.assertProjectBranchExists
}));
vi.mock('$lib/server/project-agent-config-service', () => ({
	buildRunAgentConfig: mocks.buildRunAgentConfig,
	ProjectAgentConfigError: class ProjectAgentConfigError extends Error {}
}));
vi.mock('$lib/server/run-start-service', () => ({
	startRunForOrg: mocks.startRunForOrg,
	RunStartError: mocks.RunStartError
}));

import { approveRun, startRun } from '$lib/rfc/runs.remote';

describe('runs.remote commands', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.requireHeaders.mockReturnValue(new Headers());
		mocks.requireActiveOrg.mockResolvedValue('org1');
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'user1' } } });
		mocks.startRunForOrg.mockResolvedValue({
			runId: 'run-created',
			projectId: 'p1',
			mode: 'agent',
			baseBranch: 'main'
		});
		mocks.buildRunAgentConfig.mockResolvedValue({ snapshot: {} });
	});

	it('delegates run creation to the shared start service', async () => {
		await expect(startRun({ projectId: 'p1', prompt: 'do it' })).resolves.toEqual({
			runId: 'run-created'
		});

		expect(mocks.startRunForOrg).toHaveBeenCalledWith({
			organizationId: 'org1',
			userId: 'user1',
			projectId: 'p1',
			prompt: 'do it',
			baseBranch: undefined,
			model: undefined,
			useProjectAgentConfig: undefined,
			mode: undefined
		});
	});

	it('passes selected base branch to the shared start service', async () => {
		await startRun({
			projectId: 'p1',
			prompt: 'do it',
			baseBranch: 'feature/login'
		});

		expect(mocks.startRunForOrg).toHaveBeenCalledWith(
			expect.objectContaining({ baseBranch: 'feature/login' })
		);
	});

	it('stores cdc mode when starting a CDC run (native skill, no project skill required)', async () => {
		await startRun({
			projectId: 'p1',
			prompt: 'cadrer le CRM',
			mode: 'cdc',
			useProjectAgentConfig: true
		});

		expect(mocks.startRunForOrg).toHaveBeenCalledWith(expect.objectContaining({ mode: 'cdc' }));
	});

	it('rejects CDC runs when project agent config is disabled', async () => {
		mocks.startRunForOrg.mockRejectedValue(
			new mocks.RunStartError('CDC runs require project agent config')
		);

		await expect(
			startRun({
				projectId: 'p1',
				prompt: 'cadrer le CRM',
				mode: 'cdc',
				useProjectAgentConfig: false
			})
		).rejects.toMatchObject({ status: 400 });

		expect(mocks.runCreate).not.toHaveBeenCalled();
	});

	it('rejects an unknown base branch before creating a run', async () => {
		mocks.startRunForOrg.mockRejectedValue(
			new mocks.RunStartError('Base branch "missing" was not found')
		);

		await expect(
			startRun({ projectId: 'p1', prompt: 'do it', baseBranch: 'missing' })
		).rejects.toMatchObject({ status: 400 });

		expect(mocks.runCreate).not.toHaveBeenCalled();
		expect(mocks.enqueueRun).not.toHaveBeenCalled();
	});

	it('claims awaiting_review atomically before pushing a run', async () => {
		mocks.runFindFirst.mockResolvedValue({
			id: 'r1',
			status: 'awaiting_review',
			projectId: 'p1',
			agentBranch: 'agent/r1',
			baseBranch: 'feature/login',
			prompt: 'ship it',
			project: {
				owner: 'acme',
				name: 'repo',
				cloneUrl: 'https://github.com/acme/repo.git',
				defaultBranch: 'main'
			}
		});
		mocks.getGithubToken.mockResolvedValue('gh-token');
		mocks.runUpdateMany.mockResolvedValue({ count: 0 });

		await expect(approveRun({ runId: 'r1', action: 'push' })).rejects.toMatchObject({
			status: 409
		});

		expect(mocks.runUpdateMany).toHaveBeenCalledWith({
			where: { id: 'r1', status: { in: ['awaiting_review'] } },
			data: { status: 'pushing' }
		});
		expect(mocks.pushBranch).not.toHaveBeenCalled();
	});

	it('opens pull requests against the run base branch', async () => {
		mocks.runFindFirst.mockResolvedValue({
			id: 'r1',
			status: 'awaiting_review',
			projectId: 'p1',
			agentBranch: 'claude/r1',
			baseBranch: 'feature/login',
			prompt: 'ship it',
			project: {
				owner: 'acme',
				name: 'repo',
				cloneUrl: 'https://github.com/acme/repo.git',
				defaultBranch: 'main'
			}
		});
		mocks.getGithubToken.mockResolvedValue('gh-token');
		mocks.runUpdateMany.mockResolvedValue({ count: 1 });
		mocks.pushBranch.mockResolvedValue(undefined);
		mocks.openPullRequest.mockResolvedValue({
			number: 42,
			url: 'https://github.com/acme/repo/pull/42',
			state: 'open'
		});
		mocks.pullRequestCreate.mockResolvedValue({ id: 'pr1' });

		await approveRun({ runId: 'r1', action: 'push_pr' });

		expect(mocks.openPullRequest).toHaveBeenCalledWith(
			'gh-token',
			'acme',
			'repo',
			'claude/r1',
			'feature/login',
			expect.any(String),
			expect.any(String)
		);
	});
});
