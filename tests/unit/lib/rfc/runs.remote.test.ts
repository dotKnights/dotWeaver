import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	requireHeaders: vi.fn(),
	requireActiveOrg: vi.fn(),
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
	ProjectAgentConfigError: class extends Error {}
}));

import { approveRun, startRun } from '$lib/rfc/runs.remote';

describe('runs.remote commands', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.requireHeaders.mockReturnValue(new Headers());
		mocks.requireActiveOrg.mockResolvedValue('org1');
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'user1' } } });
		mocks.buildRunAgentConfig.mockResolvedValue({
			mcpJson: { mcpServers: {} },
			settings: { enabledMcpjsonServers: [] },
			skills: [],
			secretEnv: {},
			envFile: [],
			snapshot: { enabled: true, mcpServers: [], skills: [], envVars: [] }
		});
	});

	it('marks a created run failed when queue enqueue fails', async () => {
		mocks.projectFindFirst.mockResolvedValue({
			id: 'p1',
			cloneUrl: 'https://github.com/acme/repo.git',
			defaultBranch: 'main'
		});
		mocks.getGithubToken.mockResolvedValue('gh-token');
		mocks.assertProjectBranchExists.mockResolvedValue(undefined);
		mocks.runCreate.mockResolvedValue({ id: 'run-created' });
		mocks.enqueueRun.mockRejectedValue(new Error('queue unavailable'));

		await expect(startRun({ projectId: 'p1', prompt: 'do it' })).rejects.toThrow(
			'queue unavailable'
		);

		const createdId = mocks.runCreate.mock.calls[0][0].data.id;
		expect(mocks.runUpdateMany).toHaveBeenCalledWith({
			where: { id: createdId, status: { in: ['queued'] } },
			data: expect.objectContaining({
				status: 'failed',
				error: 'queue unavailable',
				finishedAt: expect.any(Date)
			})
		});
	});

	it('persists the selected base branch when starting a run', async () => {
		mocks.projectFindFirst.mockResolvedValue({
			id: 'p1',
			cloneUrl: 'https://github.com/acme/repo.git',
			defaultBranch: 'main'
		});
		mocks.getGithubToken.mockResolvedValue('gh-token');
		mocks.assertProjectBranchExists.mockResolvedValue(undefined);
		mocks.runCreate.mockResolvedValue({ id: 'run-created' });
		mocks.enqueueRun.mockResolvedValue(undefined);

		await startRun({
			projectId: 'p1',
			prompt: 'do it',
			baseBranch: 'feature/login'
		});

		expect(mocks.assertProjectBranchExists).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'p1', defaultBranch: 'main' }),
			'feature/login',
			'gh-token'
		);
		expect(mocks.runCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ baseBranch: 'feature/login' })
			})
		);
	});

	it('persists Codex as the run agent and uses a Codex branch prefix', async () => {
		mocks.projectFindFirst.mockResolvedValue({
			id: 'p1',
			cloneUrl: 'https://github.com/acme/repo.git',
			defaultBranch: 'main'
		});
		mocks.getGithubToken.mockResolvedValue('gh-token');
		mocks.assertProjectBranchExists.mockResolvedValue(undefined);
		mocks.runCreate.mockResolvedValue({ id: 'run-created' });
		mocks.enqueueRun.mockResolvedValue(undefined);

		await startRun({
			projectId: 'p1',
			prompt: 'do it',
			agent: 'codex',
			model: 'gpt-5.5'
		});

		expect(mocks.runCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					agent: 'codex',
					model: 'gpt-5.5',
					agentBranch: expect.stringMatching(/^codex\//)
				})
			})
		);
	});

	it('defaults baseBranch to the project default branch', async () => {
		mocks.projectFindFirst.mockResolvedValue({
			id: 'p1',
			cloneUrl: 'https://github.com/acme/repo.git',
			defaultBranch: 'main'
		});
		mocks.getGithubToken.mockResolvedValue(null);
		mocks.assertProjectBranchExists.mockResolvedValue(undefined);
		mocks.runCreate.mockResolvedValue({ id: 'run-created' });
		mocks.enqueueRun.mockResolvedValue(undefined);

		await startRun({ projectId: 'p1', prompt: 'do it' });

		expect(mocks.assertProjectBranchExists).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'p1', defaultBranch: 'main' }),
			'main',
			null
		);
		expect(mocks.runCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ baseBranch: 'main' })
			})
		);
	});

	it('rejects an unknown base branch before creating a run', async () => {
		mocks.projectFindFirst.mockResolvedValue({
			id: 'p1',
			cloneUrl: 'https://github.com/acme/repo.git',
			defaultBranch: 'main'
		});
		mocks.getGithubToken.mockResolvedValue('gh-token');
		mocks.assertProjectBranchExists.mockRejectedValue(
			new Error('Base branch "missing" was not found')
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
