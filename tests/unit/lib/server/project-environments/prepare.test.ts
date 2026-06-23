import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	profileFindFirst: vi.fn(),
	profileUpdateMany: vi.fn(),
	eventCreate: vi.fn(),
	eventFindFirst: vi.fn(),
	envVarFindMany: vi.fn(),
	ensureMirror: vi.fn(),
	createEnvironmentPrepareCheckout: vi.fn(),
	runContainer: vi.fn(),
	buildRunArgs: vi.fn(),
	getGithubTokenForUser: vi.fn(),
	makeGitAuth: vi.fn(),
	authedCloneUrl: vi.fn(),
	materializeProjectEnvFile: vi.fn(),
	workspaceRoot: vi.fn(),
	decryptProjectSecretValue: vi.fn()
}));

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		projectEnvironmentProfile: {
			findFirst: mocks.profileFindFirst,
			updateMany: mocks.profileUpdateMany
		},
		projectEnvironmentPrepareEvent: {
			create: mocks.eventCreate,
			findFirst: mocks.eventFindFirst
		},
		projectEnvVar: { findMany: mocks.envVarFindMany }
	}
}));

vi.mock('$lib/server/workspace', () => ({
	ensureMirror: mocks.ensureMirror,
	createEnvironmentPrepareCheckout: mocks.createEnvironmentPrepareCheckout
}));

vi.mock('$lib/server/docker', () => ({
	runContainer: mocks.runContainer,
	buildRunArgs: mocks.buildRunArgs
}));

vi.mock('$lib/server/github-git', () => ({
	getGithubTokenForUser: mocks.getGithubTokenForUser,
	makeGitAuth: mocks.makeGitAuth,
	authedCloneUrl: mocks.authedCloneUrl
}));

vi.mock('$lib/server/project-agent-config-service', () => ({
	materializeProjectEnvFile: mocks.materializeProjectEnvFile
}));

vi.mock('$lib/server/project-agent-config-encryption', () => ({
	decryptProjectSecretValue: mocks.decryptProjectSecretValue
}));

vi.mock('$lib/server/workspace-paths', () => ({
	workspaceRoot: mocks.workspaceRoot,
	containerName: (id: string) => `dwrun-${id}`
}));

vi.mock('$env/dynamic/private', () => ({ env: { RUNNER_IMAGE: 'dotweaver-runner' } }));

import { executeProjectEnvironmentPrepare } from '$lib/server/project-environments/prepare';

describe('project environment prepare', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.workspaceRoot.mockReturnValue('/workspaces');
		mocks.decryptProjectSecretValue.mockReturnValue('postgres://secret');
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			projectId: 'p1',
			organizationId: 'org1',
			name: 'default',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp1',
			project: {
				id: 'p1',
				cloneUrl: 'https://github.com/acme/repo.git',
				defaultBranch: 'main'
			}
		});
		mocks.profileUpdateMany.mockResolvedValue({ count: 1 });
		mocks.eventFindFirst.mockResolvedValue(null);
		mocks.envVarFindMany.mockResolvedValue([{ key: 'DATABASE_URL', valueEncrypted: 'encrypted' }]);
		mocks.createEnvironmentPrepareCheckout.mockResolvedValue({ checkoutPath: '/checkout' });
		mocks.buildRunArgs.mockReturnValue(['docker', 'args']);
		mocks.runContainer.mockResolvedValue({ exitCode: 0, timedOut: false });
	});

	it('runs install command in Docker, logs events, and marks profile succeeded', async () => {
		await executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: false });

		expect(mocks.buildRunArgs).toHaveBeenCalledWith(
			expect.objectContaining({
				image: 'dotweaver-runner',
				name: 'dwenv-env1',
				workspacePath: '/checkout',
				entrypoint: '/bin/sh',
				command: ['-lc', 'bun install'],
				mounts: expect.arrayContaining([
					expect.objectContaining({ target: '/root/.bun/install/cache' })
				])
			})
		);
		expect(mocks.runContainer).toHaveBeenCalled();
		expect(mocks.profileUpdateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: { id: 'env1', lastPrepareStatus: 'running' },
				data: expect.objectContaining({
					lastPrepareStatus: 'succeeded',
					lastPreparedFingerprint: 'fp1',
					lastPrepareError: null
				})
			})
		);
	});

	it('marks profile failed and rejects when install exits non-zero', async () => {
		mocks.runContainer.mockResolvedValue({ exitCode: 1, timedOut: false });

		await expect(
			executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: true })
		).rejects.toThrow('Install command failed with exit code 1');

		expect(mocks.profileUpdateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastPrepareStatus: 'failed',
					lastPrepareError: 'Install command failed with exit code 1'
				})
			})
		);
	});

	it('scrubs env values from prepare output events', async () => {
		mocks.runContainer.mockImplementation(async (_args, onStdout) => {
			await onStdout('connecting postgres://secret');
			return { exitCode: 0, timedOut: false };
		});

		await executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: true });

		expect(mocks.eventCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					type: 'output',
					payload: { text: 'connecting [redacted]' }
				})
			})
		);
	});

	it('returns without succeeding an empty install command when another prepare is running', async () => {
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			projectId: 'p1',
			organizationId: 'org1',
			name: 'default',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: '',
			currentFingerprint: 'fp1',
			project: {
				id: 'p1',
				cloneUrl: 'https://github.com/acme/repo.git',
				defaultBranch: 'main'
			}
		});
		mocks.profileUpdateMany.mockResolvedValueOnce({ count: 0 });

		await executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: false });

		expect(mocks.profileUpdateMany).toHaveBeenCalledTimes(1);
		expect(mocks.profileUpdateMany).toHaveBeenCalledWith({
			where: { id: 'env1', lastPrepareStatus: { not: 'running' } },
			data: { lastPrepareStatus: 'running', lastPrepareError: null }
		});
		expect(mocks.runContainer).not.toHaveBeenCalled();
	});

	it('marks an empty install command as a skipped successful prepare after claiming it', async () => {
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			projectId: 'p1',
			organizationId: 'org1',
			name: 'default',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: '',
			currentFingerprint: 'fp1',
			project: {
				id: 'p1',
				cloneUrl: 'https://github.com/acme/repo.git',
				defaultBranch: 'main'
			}
		});
		mocks.profileUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });

		await executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: false });

		expect(mocks.eventCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					type: 'result',
					payload: { status: 'succeeded', skipped: true, reason: 'no_install_command' }
				})
			})
		);
		expect(mocks.profileUpdateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: { id: 'env1', lastPrepareStatus: 'running' },
				data: expect.objectContaining({
					lastPrepareStatus: 'succeeded',
					lastPreparedFingerprint: 'fp1',
					lastPrepareError: null
				})
			})
		);
		expect(mocks.runContainer).not.toHaveBeenCalled();
	});

	it('scrubs env values from prepare stderr events', async () => {
		mocks.runContainer.mockImplementation(async (_args, _onStdout, _options, onStderr) => {
			onStderr?.('connecting postgres://secret');
			return { exitCode: 0, timedOut: false };
		});

		await executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: true });

		expect(mocks.eventCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					type: 'error',
					payload: { text: 'connecting [redacted]' }
				})
			})
		);
	});

	it('marks profile failed when output event persistence fails', async () => {
		mocks.runContainer.mockImplementation(async (_args, onStdout) => {
			await onStdout('connecting postgres://secret');
			return { exitCode: 0, timedOut: false };
		});
		mocks.eventCreate
			.mockResolvedValueOnce({ id: 'event-system' })
			.mockRejectedValueOnce(new Error('event write failed'));

		await expect(
			executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: true })
		).rejects.toThrow('event write failed');

		expect(mocks.profileUpdateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: { id: 'env1', lastPrepareStatus: 'running' },
				data: expect.objectContaining({
					lastPrepareStatus: 'failed',
					lastPrepareError: 'event write failed'
				})
			})
		);
	});

	it('returns without running Docker when a non-empty install command is already claimed', async () => {
		mocks.profileUpdateMany.mockResolvedValueOnce({ count: 0 });

		await executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: true });

		expect(mocks.profileUpdateMany).toHaveBeenCalledTimes(1);
		expect(mocks.profileUpdateMany).toHaveBeenCalledWith({
			where: { id: 'env1', lastPrepareStatus: { not: 'running' } },
			data: { lastPrepareStatus: 'running', lastPrepareError: null }
		});
		expect(mocks.runContainer).not.toHaveBeenCalled();
		expect(mocks.eventCreate).not.toHaveBeenCalled();
	});
});
