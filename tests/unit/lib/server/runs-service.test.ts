import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const mocks = vi.hoisted(() => ({
	projectFindFirst: vi.fn(),
	runFindMany: vi.fn(),
	runFindFirst: vi.fn(),
	runCreate: vi.fn(),
	pullRequestCreate: vi.fn(),
	computeDiff: vi.fn(),
	existsSync: vi.fn(),
	enqueueRun: vi.fn(),
	transitionRun: vi.fn(),
	assertProjectBranchExists: vi.fn(),
	buildRunAgentConfig: vi.fn(),
	cancelPendingRunInteractions: vi.fn(),
	killContainer: vi.fn(),
	pushBranch: vi.fn(),
	openPullRequest: vi.fn(),
	removeRunCheckout: vi.fn(),
	agentBranch: vi.fn(),
	containerName: vi.fn(),
	workspaceRoot: vi.fn(),
	runWorktreePath: vi.fn()
}));

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		project: { findFirst: mocks.projectFindFirst },
		run: {
			findMany: mocks.runFindMany,
			findFirst: mocks.runFindFirst,
			create: mocks.runCreate
		},
		pullRequest: { create: mocks.pullRequestCreate }
	}
}));
vi.mock('$lib/server/projects/diff', () => ({ computeDiff: mocks.computeDiff }));
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }));
vi.mock('$lib/server/runtime/queue', () => ({ enqueueRun: mocks.enqueueRun }));
vi.mock('$lib/server/runs/transitions', () => ({ transitionRun: mocks.transitionRun }));
vi.mock('$lib/server/projects/branches', () => ({
	assertProjectBranchExists: mocks.assertProjectBranchExists
}));
vi.mock('$lib/server/project-agent-config-service', () => ({
	buildRunAgentConfig: mocks.buildRunAgentConfig
}));
vi.mock('$lib/server/runs/interactions-service', () => ({
	cancelPendingRunInteractions: mocks.cancelPendingRunInteractions
}));
vi.mock('$lib/server/runtime/docker', () => ({ killContainer: mocks.killContainer }));
vi.mock('$lib/server/integrations/github/pull-requests', () => ({
	pushBranch: mocks.pushBranch,
	openPullRequest: mocks.openPullRequest
}));
vi.mock('$lib/server/projects/workspace', () => ({ removeRunCheckout: mocks.removeRunCheckout }));
vi.mock('$lib/server/projects/workspace-paths', () => ({
	agentBranch: mocks.agentBranch,
	containerName: mocks.containerName,
	workspaceRoot: mocks.workspaceRoot,
	runWorktreePath: mocks.runWorktreePath
}));

import { prisma } from '$lib/server/prisma';
import { computeDiff } from '$lib/server/projects/diff';
import { existsSync } from 'node:fs';
import { RUN_INTERACTION_STATUS } from '$lib/domain/run-interaction-status';
import { RUN_STATUS, RUN_STATUS_GROUPS } from '$lib/domain/run-status';
import {
	listRunsForOrg,
	getRunForOrg,
	getRunDiffForOrg,
	RunWorkspaceUnavailableError,
	startRunForOrg,
	cancelRunForOrg,
	approveRunForOrg,
	RunMutationError
} from '$lib/server/runs/service';
import { assertProjectBranchExists } from '$lib/server/projects/branches';
import { buildRunAgentConfig } from '$lib/server/project-agent-config-service';
import { enqueueRun } from '$lib/server/runtime/queue';
import { transitionRun } from '$lib/server/runs/transitions';
import { cancelPendingRunInteractions } from '$lib/server/runs/interactions-service';
import { killContainer } from '$lib/server/runtime/docker';
import { pushBranch, openPullRequest } from '$lib/server/integrations/github/pull-requests';
import { removeRunCheckout } from '$lib/server/projects/workspace';

const runFindManyMock = prisma.run.findMany as unknown as Mock;
const runFindFirstMock = prisma.run.findFirst as unknown as Mock;
const computeDiffMock = computeDiff as unknown as Mock;
const existsSyncMock = existsSync as unknown as Mock;
const RUN_ID = '00000000-0000-4000-8000-000000000001';

describe('runs-service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.agentBranch.mockImplementation((runId: string) => `claude/${runId}`);
		mocks.containerName.mockImplementation((runId: string) => `dwrun-${runId}`);
		mocks.workspaceRoot.mockReturnValue('/workspace-root');
		mocks.runWorktreePath.mockImplementation(
			(root: string, projectId: string, runId: string) => `${root}/${projectId}/runs/${runId}`
		);
		mocks.transitionRun.mockResolvedValue(false);
		vi.spyOn(crypto, 'randomUUID').mockReturnValue(RUN_ID);
	});

	it('RunMutationError uses the expected name', () => {
		expect(new RunMutationError('x').name).toBe('RunMutationError');
	});

	it('listRunsForOrg scope projet + org, trie queuedAt desc', async () => {
		runFindManyMock.mockResolvedValue([{ id: 'r1' }]);
		await listRunsForOrg('org1', 'p1');
		expect(prisma.run.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { projectId: 'p1', organizationId: 'org1' } })
		);
		expect(runFindManyMock.mock.calls[0][0].select).toMatchObject({
			agentBranch: true,
			baseBranch: true
		});
	});

	it('getRunForOrg inclut les events ordonnes', async () => {
		runFindFirstMock.mockResolvedValue({ id: 'r1' });
		await getRunForOrg('org1', 'r1');
		expect(prisma.run.findFirst).toHaveBeenCalledWith({
			where: { id: 'r1', organizationId: 'org1' },
			include: {
				events: { orderBy: { seq: 'asc' } },
				interactions: {
					where: { status: RUN_INTERACTION_STATUS.PENDING },
					orderBy: { createdAt: 'desc' },
					take: 1
				}
			}
		});
	});

	it('getRunForOrg renvoie null hors org', async () => {
		runFindFirstMock.mockResolvedValue(null);
		expect(await getRunForOrg('org1', 'x')).toBeNull();
	});

	it('getRunDiffForOrg renvoie diff vide si pas de SHAs', async () => {
		runFindFirstMock.mockResolvedValue({ id: 'r1', baseCommitSha: null });
		expect(await getRunDiffForOrg('org1', 'r1')).toEqual({
			files: [],
			patch: '',
			truncated: false
		});
	});

	it('getRunDiffForOrg leve RunWorkspaceUnavailableError si checkout absent', async () => {
		runFindFirstMock.mockResolvedValue({
			id: 'r1',
			projectId: 'p1',
			baseCommitSha: 'a',
			headCommitSha: 'b'
		});
		existsSyncMock.mockReturnValue(false);
		await expect(getRunDiffForOrg('org1', 'r1')).rejects.toBeInstanceOf(
			RunWorkspaceUnavailableError
		);
	});

	it('getRunDiffForOrg calcule le diff si checkout present', async () => {
		runFindFirstMock.mockResolvedValue({
			id: 'r1',
			projectId: 'p1',
			baseCommitSha: 'a',
			headCommitSha: 'b'
		});
		existsSyncMock.mockReturnValue(true);
		computeDiffMock.mockResolvedValue({ files: [], patch: 'x', truncated: false });
		const res = await getRunDiffForOrg('org1', 'r1');
		expect(res).toEqual({ files: [], patch: 'x', truncated: false });
	});

	it('startRunForOrg returns null when project is missing or outside org', async () => {
		mocks.projectFindFirst.mockResolvedValue(null);

		await expect(
			startRunForOrg({
				organizationId: 'org1',
				userId: 'user1',
				githubToken: null,
				projectId: 'p1',
				prompt: 'do it',
				useProjectAgentConfig: false,
				timeoutAt: new Date('2026-01-01T00:00:00Z')
			})
		).resolves.toBeNull();

		expect(mocks.projectFindFirst).toHaveBeenCalledWith({
			where: { id: 'p1', organizationId: 'org1' }
		});
		expect(mocks.runCreate).not.toHaveBeenCalled();
	});

	it('startRunForOrg validates branch and agent config, creates queued run and enqueues', async () => {
		const timeoutAt = new Date('2026-01-01T00:00:00Z');
		const project = {
			id: 'p1',
			organizationId: 'org1',
			defaultBranch: 'main',
			cloneUrl: 'https://github.com/acme/repo.git'
		};
		mocks.projectFindFirst.mockResolvedValue(project);
		mocks.assertProjectBranchExists.mockResolvedValue(undefined);
		mocks.buildRunAgentConfig.mockResolvedValue({ env: [] });
		mocks.runCreate.mockResolvedValue({ id: RUN_ID });
		mocks.enqueueRun.mockResolvedValue(undefined);

		await expect(
			startRunForOrg({
				organizationId: 'org1',
				userId: 'user1',
				githubToken: 'gh-token',
				projectId: 'p1',
				prompt: 'do it',
				agent: 'codex',
				baseBranch: 'feature/login',
				model: 'gpt-5.5',
				useProjectAgentConfig: true,
				timeoutAt
			})
		).resolves.toEqual({ runId: RUN_ID, projectId: 'p1' });

		expect(assertProjectBranchExists).toHaveBeenCalledWith(project, 'feature/login', 'gh-token');
		expect(buildRunAgentConfig).toHaveBeenCalledWith('org1', 'p1', {
			useProjectAgentConfig: true
		});
		expect(mocks.runCreate).toHaveBeenCalledWith({
			data: {
				id: RUN_ID,
				projectId: 'p1',
				organizationId: 'org1',
				createdById: 'user1',
				prompt: 'do it',
				agent: 'codex',
				model: 'gpt-5.5',
				useProjectAgentConfig: true,
				agentBranch: `claude/${RUN_ID}`,
				baseBranch: 'feature/login',
				status: RUN_STATUS.QUEUED,
				timeoutAt
			}
		});
		expect(enqueueRun).toHaveBeenCalledWith(RUN_ID);
	});

	it('startRunForOrg defaults branch and model, and skips agent config when disabled', async () => {
		const timeoutAt = new Date('2026-01-01T00:00:00Z');
		const project = {
			id: 'p1',
			organizationId: 'org1',
			defaultBranch: 'main',
			cloneUrl: 'https://github.com/acme/repo.git'
		};
		mocks.projectFindFirst.mockResolvedValue(project);
		mocks.assertProjectBranchExists.mockResolvedValue(undefined);
		mocks.runCreate.mockResolvedValue({ id: RUN_ID });
		mocks.enqueueRun.mockResolvedValue(undefined);

		await expect(
			startRunForOrg({
				organizationId: 'org1',
				userId: 'user1',
				githubToken: null,
				projectId: 'p1',
				prompt: 'do it',
				useProjectAgentConfig: false,
				timeoutAt
			})
		).resolves.toEqual({ runId: RUN_ID, projectId: 'p1' });

		expect(assertProjectBranchExists).toHaveBeenCalledWith(project, 'main', null);
		expect(buildRunAgentConfig).not.toHaveBeenCalled();
		expect(mocks.runCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				baseBranch: 'main',
				model: null,
				useProjectAgentConfig: false
			})
		});
	});

	it('startRunForOrg marks failed if enqueue fails after creation', async () => {
		mocks.projectFindFirst.mockResolvedValue({
			id: 'p1',
			organizationId: 'org1',
			defaultBranch: 'main'
		});
		mocks.assertProjectBranchExists.mockResolvedValue(undefined);
		mocks.runCreate.mockResolvedValue({ id: RUN_ID });
		mocks.enqueueRun.mockRejectedValue(new Error('queue unavailable'));

		await expect(
			startRunForOrg({
				organizationId: 'org1',
				userId: 'user1',
				githubToken: null,
				projectId: 'p1',
				prompt: 'do it',
				useProjectAgentConfig: false,
				timeoutAt: new Date('2026-01-01T00:00:00Z')
			})
		).rejects.toThrow('queue unavailable');

		expect(transitionRun).toHaveBeenCalledWith(
			RUN_ID,
			RUN_STATUS.QUEUED,
			RUN_STATUS.FAILED,
			expect.objectContaining({
				error: 'queue unavailable',
				finishedAt: expect.any(Date)
			})
		);
	});

	it('startRunForOrg rethrows enqueue failure when failure transition also rejects', async () => {
		mocks.projectFindFirst.mockResolvedValue({
			id: 'p1',
			organizationId: 'org1',
			defaultBranch: 'main'
		});
		mocks.assertProjectBranchExists.mockResolvedValue(undefined);
		mocks.runCreate.mockResolvedValue({ id: RUN_ID });
		mocks.enqueueRun.mockRejectedValue(new Error('queue unavailable'));
		mocks.transitionRun.mockRejectedValue(new Error('transition unavailable'));

		await expect(
			startRunForOrg({
				organizationId: 'org1',
				userId: 'user1',
				githubToken: null,
				projectId: 'p1',
				prompt: 'do it',
				useProjectAgentConfig: false,
				timeoutAt: new Date('2026-01-01T00:00:00Z')
			})
		).rejects.toThrow('queue unavailable');

		expect(transitionRun).toHaveBeenCalledWith(
			RUN_ID,
			RUN_STATUS.QUEUED,
			RUN_STATUS.FAILED,
			expect.objectContaining({ error: 'queue unavailable' })
		);
	});

	it('cancelRunForOrg returns null for missing run', async () => {
		runFindFirstMock.mockResolvedValue(null);

		await expect(cancelRunForOrg('org1', 'r1')).resolves.toBeNull();

		expect(runFindFirstMock).toHaveBeenCalledWith({
			where: { id: 'r1', organizationId: 'org1' },
			select: { id: true, status: true, projectId: true }
		});
		expect(transitionRun).not.toHaveBeenCalled();
	});

	it('cancelRunForOrg transitions, cancels pending interactions, and kills container when claimed', async () => {
		runFindFirstMock.mockResolvedValue({ id: 'r1', status: RUN_STATUS.RUNNING, projectId: 'p1' });
		mocks.transitionRun.mockResolvedValue(true);
		mocks.cancelPendingRunInteractions.mockResolvedValue(undefined);
		mocks.killContainer.mockResolvedValue(undefined);

		await expect(cancelRunForOrg('org1', 'r1')).resolves.toEqual({
			canceled: true,
			projectId: 'p1'
		});

		expect(transitionRun).toHaveBeenCalledWith(
			'r1',
			RUN_STATUS_GROUPS.CANCELABLE,
			RUN_STATUS.CANCELED,
			{ finishedAt: expect.any(Date) }
		);
		expect(cancelPendingRunInteractions).toHaveBeenCalledWith('r1');
		expect(killContainer).toHaveBeenCalledWith('dwrun-r1');
	});

	it('cancelRunForOrg returns not canceled and skips side effects when transition is not claimed', async () => {
		runFindFirstMock.mockResolvedValue({ id: 'r1', status: RUN_STATUS.RUNNING, projectId: 'p1' });
		mocks.transitionRun.mockResolvedValue(false);

		await expect(cancelRunForOrg('org1', 'r1')).resolves.toEqual({
			canceled: false,
			projectId: 'p1'
		});

		expect(cancelPendingRunInteractions).not.toHaveBeenCalled();
		expect(killContainer).not.toHaveBeenCalled();
	});

	it('approveRunForOrg returns null for missing run', async () => {
		runFindFirstMock.mockResolvedValue(null);

		await expect(
			approveRunForOrg({
				organizationId: 'org1',
				githubToken: 'gh-token',
				runId: 'r1',
				action: 'push'
			})
		).resolves.toBeNull();

		expect(transitionRun).not.toHaveBeenCalled();
	});

	it('approveRunForOrg refuses non-awaiting_review with RunMutationError', async () => {
		runFindFirstMock.mockResolvedValue({
			id: 'r1',
			status: RUN_STATUS.RUNNING,
			projectId: 'p1',
			project: { id: 'p1' }
		});

		await expect(
			approveRunForOrg({
				organizationId: 'org1',
				githubToken: 'gh-token',
				runId: 'r1',
				action: 'push'
			})
		).rejects.toThrow(RunMutationError);
		await expect(
			approveRunForOrg({
				organizationId: 'org1',
				githubToken: 'gh-token',
				runId: 'r1',
				action: 'push'
			})
		).rejects.toThrow('Run is not awaiting review (status: running)');
	});

	it('approveRunForOrg(abandon) cancels and removes checkout', async () => {
		runFindFirstMock.mockResolvedValue({
			id: 'r1',
			status: RUN_STATUS.AWAITING_REVIEW,
			projectId: 'p1',
			project: { id: 'p1' }
		});
		mocks.transitionRun.mockResolvedValue(true);
		mocks.removeRunCheckout.mockResolvedValue(undefined);

		await expect(
			approveRunForOrg({
				organizationId: 'org1',
				githubToken: null,
				runId: 'r1',
				action: 'abandon'
			})
		).resolves.toEqual({
			status: RUN_STATUS.CANCELED,
			pullRequestUrl: null,
			projectId: 'p1'
		});

		expect(transitionRun).toHaveBeenCalledWith(
			'r1',
			RUN_STATUS.AWAITING_REVIEW,
			RUN_STATUS.CANCELED,
			{ finishedAt: expect.any(Date) }
		);
		expect(removeRunCheckout).toHaveBeenCalledWith('p1', 'r1');
	});

	it('approveRunForOrg(abandon) throws when the awaiting review transition is not claimed', async () => {
		runFindFirstMock.mockResolvedValue({
			id: 'r1',
			status: RUN_STATUS.AWAITING_REVIEW,
			projectId: 'p1',
			project: { id: 'p1' }
		});
		mocks.transitionRun.mockResolvedValue(false);

		await expect(
			approveRunForOrg({
				organizationId: 'org1',
				githubToken: null,
				runId: 'r1',
				action: 'abandon'
			})
		).rejects.toThrow(new RunMutationError('Run is no longer awaiting review'));

		expect(removeRunCheckout).not.toHaveBeenCalled();
	});

	it('approveRunForOrg requires a GitHub token before claiming or pushing', async () => {
		runFindFirstMock.mockResolvedValue({
			id: 'r1',
			status: RUN_STATUS.AWAITING_REVIEW,
			projectId: 'p1',
			project: { id: 'p1' }
		});

		await expect(
			approveRunForOrg({
				organizationId: 'org1',
				githubToken: null,
				runId: 'r1',
				action: 'push'
			})
		).rejects.toThrow(new RunMutationError('Connect your GitHub account to continue'));

		expect(transitionRun).not.toHaveBeenCalled();
		expect(pushBranch).not.toHaveBeenCalled();
	});

	it('approveRunForOrg prevents push when awaiting review claim fails', async () => {
		runFindFirstMock.mockResolvedValue({
			id: 'r1',
			status: RUN_STATUS.AWAITING_REVIEW,
			projectId: 'p1',
			agentBranch: 'claude/r1',
			baseBranch: 'main',
			prompt: 'ship it',
			project: {
				id: 'p1',
				owner: 'acme',
				name: 'repo',
				cloneUrl: 'https://github.com/acme/repo.git'
			}
		});
		mocks.transitionRun.mockResolvedValue(false);

		await expect(
			approveRunForOrg({
				organizationId: 'org1',
				githubToken: 'gh-token',
				runId: 'r1',
				action: 'push'
			})
		).rejects.toThrow(new RunMutationError('Run is no longer awaiting review'));

		expect(pushBranch).not.toHaveBeenCalled();
	});

	it('approveRunForOrg marks failed and rethrows when PR creation fails after claim', async () => {
		runFindFirstMock.mockResolvedValue({
			id: 'r1',
			status: RUN_STATUS.AWAITING_REVIEW,
			projectId: 'p1',
			agentBranch: 'claude/r1',
			baseBranch: 'main',
			prompt: 'ship it',
			project: {
				id: 'p1',
				owner: 'acme',
				name: 'repo',
				cloneUrl: 'https://github.com/acme/repo.git'
			}
		});
		mocks.transitionRun.mockResolvedValue(true);
		mocks.pushBranch.mockResolvedValue(undefined);
		mocks.openPullRequest.mockRejectedValue(new Error('pr unavailable'));

		await expect(
			approveRunForOrg({
				organizationId: 'org1',
				githubToken: 'gh-token',
				runId: 'r1',
				action: 'push_pr'
			})
		).rejects.toThrow('pr unavailable');

		expect(pushBranch).toHaveBeenCalledWith(
			'/workspace-root/p1/runs/r1',
			'https://github.com/acme/repo.git',
			'claude/r1',
			'gh-token'
		);
		expect(transitionRun).toHaveBeenLastCalledWith('r1', RUN_STATUS.PUSHING, RUN_STATUS.FAILED, {
			error: 'pr unavailable'
		});
	});

	it('approveRunForOrg(push_pr) pushes, opens PR, creates PullRequest, and completes run', async () => {
		runFindFirstMock.mockResolvedValue({
			id: 'r1',
			status: RUN_STATUS.AWAITING_REVIEW,
			projectId: 'p1',
			agentBranch: 'claude/r1',
			baseBranch: 'feature/login',
			prompt: 'ship the login flow\nwith tests',
			project: {
				id: 'p1',
				owner: 'acme',
				name: 'repo',
				cloneUrl: 'https://github.com/acme/repo.git'
			}
		});
		mocks.transitionRun.mockResolvedValue(true);
		mocks.pushBranch.mockResolvedValue(undefined);
		mocks.openPullRequest.mockResolvedValue({
			number: 42,
			url: 'https://github.com/acme/repo/pull/42',
			state: 'open'
		});
		mocks.pullRequestCreate.mockResolvedValue({ id: 'pr1' });

		await expect(
			approveRunForOrg({
				organizationId: 'org1',
				githubToken: 'gh-token',
				runId: 'r1',
				action: 'push_pr'
			})
		).resolves.toEqual({
			status: RUN_STATUS.COMPLETED,
			pullRequestUrl: 'https://github.com/acme/repo/pull/42',
			projectId: 'p1'
		});

		expect(pushBranch).toHaveBeenCalledWith(
			'/workspace-root/p1/runs/r1',
			'https://github.com/acme/repo.git',
			'claude/r1',
			'gh-token'
		);
		expect(openPullRequest).toHaveBeenCalledWith(
			'gh-token',
			'acme',
			'repo',
			'claude/r1',
			'feature/login',
			'ship the login flow',
			expect.stringContaining('**Prompt:**')
		);
		expect(mocks.pullRequestCreate).toHaveBeenCalledWith({
			data: {
				runId: 'r1',
				number: 42,
				url: 'https://github.com/acme/repo/pull/42',
				state: 'open'
			}
		});
		expect(transitionRun).toHaveBeenLastCalledWith('r1', RUN_STATUS.PUSHING, RUN_STATUS.COMPLETED, {
			finishedAt: expect.any(Date)
		});
	});

	it('approveRunForOrg(push) pushes without opening PR and completes with null PR URL', async () => {
		runFindFirstMock.mockResolvedValue({
			id: 'r1',
			status: RUN_STATUS.AWAITING_REVIEW,
			projectId: 'p1',
			agentBranch: 'claude/r1',
			baseBranch: 'main',
			prompt: 'ship it',
			project: {
				id: 'p1',
				owner: 'acme',
				name: 'repo',
				cloneUrl: 'https://github.com/acme/repo.git'
			}
		});
		mocks.transitionRun.mockResolvedValue(true);
		mocks.pushBranch.mockResolvedValue(undefined);

		await expect(
			approveRunForOrg({
				organizationId: 'org1',
				githubToken: 'gh-token',
				runId: 'r1',
				action: 'push'
			})
		).resolves.toEqual({
			status: RUN_STATUS.COMPLETED,
			pullRequestUrl: null,
			projectId: 'p1'
		});

		expect(pushBranch).toHaveBeenCalledWith(
			'/workspace-root/p1/runs/r1',
			'https://github.com/acme/repo.git',
			'claude/r1',
			'gh-token'
		);
		expect(openPullRequest).not.toHaveBeenCalled();
		expect(mocks.pullRequestCreate).not.toHaveBeenCalled();
		expect(transitionRun).toHaveBeenLastCalledWith('r1', RUN_STATUS.PUSHING, RUN_STATUS.COMPLETED, {
			finishedAt: expect.any(Date)
		});
	});
});
