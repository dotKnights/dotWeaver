import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	projectFindFirst: vi.fn(),
	runCreate: vi.fn(),
	runUpdateMany: vi.fn(),
	enqueueRun: vi.fn(),
	getGithubTokenForUser: vi.fn(),
	assertProjectBranchExists: vi.fn(),
	buildRunAgentConfig: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: { RUN_TIMEOUT_MS: '60000' } }));
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		project: { findFirst: mocks.projectFindFirst },
		run: {
			create: mocks.runCreate,
			updateMany: mocks.runUpdateMany
		}
	}
}));
vi.mock('$lib/server/queue', () => ({ enqueueRun: mocks.enqueueRun }));
vi.mock('$lib/server/github-git', () => ({ getGithubTokenForUser: mocks.getGithubTokenForUser }));
vi.mock('$lib/server/project-branches-service', () => ({
	assertProjectBranchExists: mocks.assertProjectBranchExists
}));
vi.mock('$lib/server/project-agent-config-service', () => ({
	buildRunAgentConfig: mocks.buildRunAgentConfig,
	ProjectAgentConfigError: class ProjectAgentConfigError extends Error {}
}));

import { startRunForOrg, RunStartError } from '$lib/server/run-start-service';

describe('startRunForOrg', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.projectFindFirst.mockResolvedValue({
			id: 'p1',
			cloneUrl: 'https://github.com/acme/repo.git',
			defaultBranch: 'main'
		});
		mocks.getGithubTokenForUser.mockResolvedValue('gh-token');
		mocks.assertProjectBranchExists.mockResolvedValue(undefined);
		mocks.buildRunAgentConfig.mockResolvedValue({ snapshot: {} });
		mocks.runCreate.mockResolvedValue({ id: 'run-created' });
		mocks.enqueueRun.mockResolvedValue(undefined);
		mocks.runUpdateMany.mockResolvedValue({ count: 1 });
	});

	it('creates and enqueues a CDC run with native agent config enabled', async () => {
		const run = await startRunForOrg({
			organizationId: 'org1',
			userId: 'user1',
			projectId: 'p1',
			prompt: 'Cadrer un CRM',
			baseBranch: 'main',
			model: 'sonnet',
			mode: 'cdc',
			useProjectAgentConfig: true
		});

		expect(mocks.getGithubTokenForUser).toHaveBeenCalledWith('user1');
		expect(mocks.assertProjectBranchExists).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'p1' }),
			'main',
			'gh-token'
		);
		expect(mocks.buildRunAgentConfig).toHaveBeenCalledWith('org1', 'p1', {
			useProjectAgentConfig: true,
			mode: 'cdc'
		});
		expect(mocks.runCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					projectId: 'p1',
					organizationId: 'org1',
					createdById: 'user1',
					prompt: 'Cadrer un CRM',
					model: 'sonnet',
					mode: 'cdc',
					agent: 'claude',
					useProjectAgentConfig: true,
					baseBranch: 'main',
					status: 'queued'
				})
			})
		);
		expect(mocks.enqueueRun).toHaveBeenCalledWith(expect.any(String));
		expect(run).toMatchObject({
			projectId: 'p1',
			agent: 'claude',
			mode: 'cdc',
			baseBranch: 'main'
		});
	});

	it('stores the selected agent and honors provided token and timeout', async () => {
		const timeoutAt = new Date('2026-01-02T03:05:05.000Z');

		await startRunForOrg({
			organizationId: 'org1',
			userId: 'user1',
			githubToken: 'provided-token',
			projectId: 'p1',
			prompt: 'Do it',
			agent: 'codex',
			useProjectAgentConfig: false,
			timeoutAt
		});

		expect(mocks.getGithubTokenForUser).not.toHaveBeenCalled();
		expect(mocks.assertProjectBranchExists).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'p1' }),
			'main',
			'provided-token'
		);
		expect(mocks.runCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					agent: 'codex',
					mode: 'agent',
					timeoutAt
				})
			})
		);
	});

	it('returns null when the project is outside the organization', async () => {
		mocks.projectFindFirst.mockResolvedValue(null);

		await expect(
			startRunForOrg({
				organizationId: 'org1',
				userId: 'user1',
				projectId: 'missing',
				prompt: 'Do it'
			})
		).resolves.toBeNull();

		expect(mocks.runCreate).not.toHaveBeenCalled();
	});

	it('rejects CDC runs without project agent config', async () => {
		await expect(
			startRunForOrg({
				organizationId: 'org1',
				userId: 'user1',
				projectId: 'p1',
				prompt: 'Cadrer un CRM',
				mode: 'cdc',
				useProjectAgentConfig: false
			})
		).rejects.toThrow(RunStartError);

		expect(mocks.assertProjectBranchExists).not.toHaveBeenCalled();
		expect(mocks.runCreate).not.toHaveBeenCalled();
	});

	it('marks a created run failed when enqueue fails', async () => {
		mocks.enqueueRun.mockRejectedValue(new Error('queue unavailable'));

		await expect(
			startRunForOrg({
				organizationId: 'org1',
				userId: 'user1',
				projectId: 'p1',
				prompt: 'Do it'
			})
		).rejects.toThrow('queue unavailable');

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
});
