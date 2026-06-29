import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	profileFindFirst: vi.fn(),
	profileUpdateMany: vi.fn(),
	eventCreate: vi.fn(),
	eventFindFirst: vi.fn(),
	envVarFindMany: vi.fn(),
	ensureMirror: vi.fn(),
	createEnvironmentTemplateCheckout: vi.fn(),
	runContainer: vi.fn(),
	buildRunArgs: vi.fn(),
	getGithubTokenForUser: vi.fn(),
	makeGitAuth: vi.fn(),
	gitAuthCleanup: vi.fn(),
	authedCloneUrl: vi.fn(),
	materializeProjectEnvFile: vi.fn(),
	workspaceRoot: vi.fn(),
	decryptProjectSecretValue: vi.fn(),
	buildProjectEnvironmentServiceOutputsForOrg: vi.fn(),
	ensureDockerNetwork: vi.fn(),
	writeFile: vi.fn(),
	notifyProjectEnvironmentPrepare: vi.fn()
}));

vi.mock('node:fs/promises', async () => {
	const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
	return { ...actual, writeFile: mocks.writeFile };
});

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

vi.mock('$lib/server/projects/workspace', () => ({
	ensureMirror: mocks.ensureMirror,
	createEnvironmentTemplateCheckout: mocks.createEnvironmentTemplateCheckout
}));

vi.mock('$lib/server/runtime/docker', () => ({
	runContainer: mocks.runContainer,
	buildRunArgs: mocks.buildRunArgs
}));

vi.mock('$lib/server/integrations/github/git-auth', () => ({
	getGithubTokenForUser: mocks.getGithubTokenForUser,
	makeGitAuth: mocks.makeGitAuth,
	authedCloneUrl: mocks.authedCloneUrl
}));

vi.mock('$lib/server/project-agent-config/service', () => ({
	materializeProjectEnvFile: mocks.materializeProjectEnvFile
}));

vi.mock('$lib/server/project-agent-config/encryption', () => ({
	decryptProjectSecretValue: mocks.decryptProjectSecretValue
}));

vi.mock('$lib/server/project-environment-services/service', () => ({
	buildProjectEnvironmentServiceOutputsForOrg: mocks.buildProjectEnvironmentServiceOutputsForOrg
}));

vi.mock('$lib/server/runtime/docker-network', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/runtime/docker-network')>(
		'$lib/server/runtime/docker-network'
	);
	return {
		...actual,
		ensureDockerNetwork: mocks.ensureDockerNetwork
	};
});

vi.mock('$lib/server/projects/workspace-paths', () => ({
	workspaceRoot: mocks.workspaceRoot,
	projectEnvironmentMetadataPath: () => '/workspaces/p1/environment/default/metadata.json',
	containerName: (id: string) => `dwrun-${id}`
}));

vi.mock('$lib/server/project-environments/notifications', () => ({
	notifyProjectEnvironmentPrepare: mocks.notifyProjectEnvironmentPrepare
}));

vi.mock('$env/dynamic/private', () => ({ env: { RUNNER_IMAGE: 'dotweaver-runner' } }));

import {
	executeProjectEnvironmentPrepare,
	recoverOrphanedProjectEnvironmentPrepares
} from '$lib/server/project-environments/prepare';

function metadataWritePayload(): Record<string, unknown> {
	return JSON.parse(String(mocks.writeFile.mock.calls[0][1])) as Record<string, unknown>;
}

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
		mocks.buildProjectEnvironmentServiceOutputsForOrg.mockResolvedValue({
			env: [],
			warnings: [],
			fingerprintInputs: []
		});
		mocks.ensureDockerNetwork.mockResolvedValue(undefined);
		mocks.createEnvironmentTemplateCheckout.mockResolvedValue({
			checkoutPath: '/template',
			baseSha: 'abc123'
		});
		mocks.getGithubTokenForUser.mockResolvedValue('token');
		mocks.makeGitAuth.mockResolvedValue({
			env: { GIT_ASKPASS: '/tmp/askpass' },
			cleanup: mocks.gitAuthCleanup
		});
		mocks.authedCloneUrl.mockReturnValue('https://github.com/acme/repo.git');
		mocks.buildRunArgs.mockReturnValue(['docker', 'args']);
		mocks.runContainer.mockResolvedValue({ exitCode: 0, timedOut: false });
	});

	it('runs install command in Docker, logs events, and marks profile ready and succeeded', async () => {
		const result = await executeProjectEnvironmentPrepare({
			profileId: 'env1',
			requestedById: 'u1',
			force: false
		});

		expect(result).toEqual({ status: 'prepared' });
		expect(mocks.createEnvironmentTemplateCheckout).toHaveBeenCalledWith(
			'p1',
			'default',
			'main',
			expect.anything()
		);
		expect(mocks.buildRunArgs).toHaveBeenCalledWith(
			expect.objectContaining({
				image: 'dotweaver-runner',
				name: 'dwenv-env1',
				workspacePath: '/template',
				entrypoint: '/bin/sh',
				command: ['-c', expect.stringContaining('bun install')],
				network: 'dotweaver-runner',
				mounts: expect.arrayContaining([
					expect.objectContaining({ target: '/root/.bun/install/cache' })
				])
			})
		);
		expect(mocks.ensureDockerNetwork).toHaveBeenCalledWith('dotweaver-runner');
		expect(mocks.ensureDockerNetwork.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.buildRunArgs.mock.invocationCallOrder[0]
		);
		const prepareCommand = mocks.buildRunArgs.mock.calls[0][0].command as string[];
		expect(prepareCommand[1]).toContain('dotWeaver workspace mount check failed');
		expect(prepareCommand[1]).toContain('test -e .git');
		expect(prepareCommand[1].trim()).toMatch(/bun install$/);
		expect(mocks.runContainer).toHaveBeenCalled();
		expect(mocks.writeFile).toHaveBeenCalledWith(
			'/workspaces/p1/environment/default/metadata.json',
			expect.stringContaining('"fingerprint": "fp1"')
		);
		const metadata = metadataWritePayload();
		expect(Object.keys(metadata).sort()).toEqual(
			[
				'baseSha',
				'fingerprint',
				'installCommand',
				'packageManager',
				'preparedAt',
				'profileId',
				'profileName',
				'projectId',
				'runtime'
			].sort()
		);
		expect(metadata).toEqual(
			expect.objectContaining({
				projectId: 'p1',
				profileId: 'env1',
				profileName: 'default',
				runtime: 'node',
				packageManager: 'bun',
				installCommand: 'bun install',
				fingerprint: 'fp1',
				baseSha: 'abc123',
				preparedAt: expect.any(String)
			})
		);
		expect(Number.isNaN(Date.parse(String(metadata.preparedAt)))).toBe(false);
		const metadataText = String(mocks.writeFile.mock.calls[0][1]);
		expect(metadataText).not.toContain('postgres://secret');
		expect(metadataText).not.toContain('GIT_ASKPASS');
		expect(metadataText).not.toContain('/tmp/askpass');
		expect(metadataText).not.toContain('https://github.com/acme/repo.git');
		expect(mocks.profileUpdateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: { id: 'env1', lastPrepareStatus: 'running' },
				data: expect.objectContaining({
					status: 'ready',
					lastPrepareStatus: 'succeeded',
					lastPreparedFingerprint: 'fp1',
					lastPrepareError: null
				})
			})
		);
		expect(mocks.notifyProjectEnvironmentPrepare).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: 'org1',
				projectId: 'p1',
				profileId: 'env1',
				kind: 'event',
				seq: expect.any(Number)
			})
		);
		expect(mocks.notifyProjectEnvironmentPrepare).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: 'org1',
				projectId: 'p1',
				profileId: 'env1',
				kind: 'profile'
			})
		);
	});

	it('marks an already prepared detected profile ready when prepare is current', async () => {
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			projectId: 'p1',
			organizationId: 'org1',
			name: 'default',
			status: 'detected',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp1',
			lastPreparedFingerprint: 'fp1',
			lastPrepareStatus: 'succeeded',
			project: {
				id: 'p1',
				cloneUrl: 'https://github.com/acme/repo.git',
				defaultBranch: 'main'
			}
		});

		await expect(
			executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: false })
		).resolves.toEqual({ status: 'skipped_current' });

		expect(mocks.profileUpdateMany).toHaveBeenCalledWith({
			where: {
				id: 'env1',
				status: 'detected',
				currentFingerprint: 'fp1',
				lastPreparedFingerprint: 'fp1',
				lastPrepareStatus: 'succeeded'
			},
			data: { status: 'ready' }
		});
		expect(mocks.notifyProjectEnvironmentPrepare).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: 'org1',
				projectId: 'p1',
				profileId: 'env1',
				kind: 'profile'
			})
		);
		expect(mocks.runContainer).not.toHaveBeenCalled();
		expect(mocks.eventCreate).not.toHaveBeenCalled();
	});

	it('returns skipped_current when the profile fingerprint is already prepared', async () => {
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			projectId: 'p1',
			organizationId: 'org1',
			name: 'default',
			status: 'ready',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp1',
			lastPreparedFingerprint: 'fp1',
			lastPrepareStatus: 'succeeded',
			project: {
				id: 'p1',
				cloneUrl: 'https://github.com/acme/repo.git',
				defaultBranch: 'main'
			}
		});

		await expect(
			executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: false })
		).resolves.toEqual({ status: 'skipped_current' });

		expect(mocks.profileUpdateMany).not.toHaveBeenCalled();
		expect(mocks.runContainer).not.toHaveBeenCalled();
		expect(mocks.eventCreate).not.toHaveBeenCalled();
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

		await expect(
			executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: false })
		).resolves.toEqual({ status: 'already_running' });

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

		const result = await executeProjectEnvironmentPrepare({
			profileId: 'env1',
			requestedById: 'u1',
			force: false
		});

		expect(result).toEqual({ status: 'prepared' });
		expect(mocks.createEnvironmentTemplateCheckout).toHaveBeenCalledWith(
			'p1',
			'default',
			'main',
			expect.anything()
		);
		expect(mocks.materializeProjectEnvFile).toHaveBeenCalledWith(
			'/template',
			[{ key: 'DATABASE_URL', value: 'postgres://secret' }],
			[],
			[]
		);
		expect(mocks.writeFile).toHaveBeenCalledWith(
			'/workspaces/p1/environment/default/metadata.json',
			expect.stringContaining('"installCommand": ""')
		);
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
					status: 'ready',
					lastPrepareStatus: 'succeeded',
					lastPreparedFingerprint: 'fp1',
					lastPrepareError: null
				})
			})
		);
		expect(mocks.runContainer).not.toHaveBeenCalled();
	});

	it('marks profile failed when metadata persistence fails', async () => {
		mocks.writeFile.mockRejectedValue(new Error('metadata write failed'));

		await expect(
			executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: true })
		).rejects.toThrow('metadata write failed');

		expect(mocks.profileUpdateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: { id: 'env1', lastPrepareStatus: 'running' },
				data: expect.objectContaining({
					lastPrepareStatus: 'failed',
					lastPrepareError: 'metadata write failed'
				})
			})
		);
		expect(mocks.eventCreate).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					type: 'result',
					payload: expect.objectContaining({ status: 'succeeded' })
				})
			})
		);
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

	it('records Bun dotenv load stderr as output instead of error', async () => {
		mocks.runContainer.mockImplementation(async (_args, _onStdout, _options, onStderr) => {
			onStderr?.('[0.26ms] ".env"');
			return { exitCode: 0, timedOut: false };
		});

		await executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: true });

		expect(mocks.eventCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					type: 'output',
					payload: { text: '[0.26ms] ".env"' }
				})
			})
		);
		expect(mocks.eventCreate).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					type: 'error',
					payload: { text: '[0.26ms] ".env"' }
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

		await expect(
			executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: true })
		).resolves.toEqual({ status: 'already_running' });

		expect(mocks.profileUpdateMany).toHaveBeenCalledTimes(1);
		expect(mocks.profileUpdateMany).toHaveBeenCalledWith({
			where: { id: 'env1', lastPrepareStatus: { not: 'running' } },
			data: { lastPrepareStatus: 'running', lastPrepareError: null }
		});
		expect(mocks.runContainer).not.toHaveBeenCalled();
		expect(mocks.eventCreate).not.toHaveBeenCalled();
	});

	it('scrubs dotenv-escaped secret values from prepare events', async () => {
		mocks.decryptProjectSecretValue.mockReturnValue('say "hi"');
		mocks.runContainer.mockImplementation(async (_args, onStdout) => {
			await onStdout('DATABASE_URL="say \\"hi\\""');
			return { exitCode: 0, timedOut: false };
		});

		await executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: true });

		const outputTexts = mocks.eventCreate.mock.calls
			.map(([call]) => call.data)
			.filter((data) => data.type === 'output')
			.map((data) => data.payload.text);
		expect(outputTexts).toContain('DATABASE_URL="[redacted]"');
		expect(outputTexts.join('\n')).not.toContain('say "hi"');
		expect(outputTexts.join('\n')).not.toContain('say \\"hi\\"');
	});

	it('scrubs multiline secret fragments from prepare events', async () => {
		mocks.decryptProjectSecretValue.mockReturnValue('line-one\nline-two');
		mocks.runContainer.mockImplementation(async (_args, onStdout) => {
			await onStdout('first=line-one');
			await onStdout('second=line-two');
			return { exitCode: 0, timedOut: false };
		});

		await executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: true });

		const outputTexts = mocks.eventCreate.mock.calls
			.map(([call]) => call.data)
			.filter((data) => data.type === 'output')
			.map((data) => data.payload.text);
		expect(outputTexts).toEqual(expect.arrayContaining(['first=[redacted]', 'second=[redacted]']));
		expect(outputTexts.join('\n')).not.toContain('line-one');
		expect(outputTexts.join('\n')).not.toContain('line-two');
	});

	it('scrubs JSON string body secret variants from prepare events', async () => {
		const secret = 'path\twith-tab';
		const jsonBody = JSON.stringify(secret).slice(1, -1);
		mocks.decryptProjectSecretValue.mockReturnValue(secret);
		mocks.runContainer.mockImplementation(async (_args, onStdout) => {
			await onStdout(`VALUE=${jsonBody}`);
			return { exitCode: 0, timedOut: false };
		});

		await executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: true });

		const outputTexts = mocks.eventCreate.mock.calls
			.map(([call]) => call.data)
			.filter((data) => data.type === 'output')
			.map((data) => data.payload.text);
		expect(outputTexts).toContain('VALUE=[redacted]');
		expect(outputTexts.join('\n')).not.toContain(jsonBody);
	});

	it('injects ready service env values and scrubs them from prepare logs', async () => {
		mocks.buildProjectEnvironmentServiceOutputsForOrg.mockResolvedValue({
			env: [
				{
					key: 'SERVICE_DATABASE_URL',
					value: 'postgres://service-secret@db.internal/app',
					sensitive: true
				}
			],
			warnings: [],
			fingerprintInputs: []
		});
		mocks.runContainer.mockImplementation(async (_args, onStdout) => {
			await onStdout('SERVICE_DATABASE_URL=postgres://service-secret@db.internal/app');
			return { exitCode: 0, timedOut: false };
		});

		await executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: true });

		expect(mocks.buildProjectEnvironmentServiceOutputsForOrg).toHaveBeenCalledWith(
			'org1',
			'p1',
			'env1'
		);
		expect(mocks.materializeProjectEnvFile).toHaveBeenCalledWith(
			'/template',
			[{ key: 'DATABASE_URL', value: 'postgres://secret' }],
			[],
			[
				{
					key: 'SERVICE_DATABASE_URL',
					value: 'postgres://service-secret@db.internal/app',
					sensitive: true
				}
			]
		);
		const outputTexts = mocks.eventCreate.mock.calls
			.map(([call]) => call.data)
			.filter((data) => data.type === 'output')
			.map((data) => data.payload.text);
		expect(outputTexts).toContain('SERVICE_DATABASE_URL=[redacted]');
		expect(outputTexts.join('\n')).not.toContain('service-secret');
	});

	it('materializes mapped service env vars into prepared environments', async () => {
		mocks.buildProjectEnvironmentServiceOutputsForOrg.mockResolvedValue({
			env: [
				{ key: 'DIRECT_URL', value: 'postgres://secret@db/app', sensitive: true },
				{ key: 'DB_HOST', value: 'db.internal', sensitive: false }
			],
			warnings: [],
			fingerprintInputs: []
		});

		await executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: true });

		expect(mocks.materializeProjectEnvFile).toHaveBeenCalledWith(
			'/template',
			[{ key: 'DATABASE_URL', value: 'postgres://secret' }],
			[],
			[
				{ key: 'DIRECT_URL', value: 'postgres://secret@db/app', sensitive: true },
				{ key: 'DB_HOST', value: 'db.internal', sensitive: false }
			]
		);
	});

	it('recovers orphaned running prepares as failed', async () => {
		mocks.profileUpdateMany.mockResolvedValueOnce({ count: 2 });

		await expect(recoverOrphanedProjectEnvironmentPrepares()).resolves.toBe(2);

		expect(mocks.profileUpdateMany).toHaveBeenCalledWith({
			where: { lastPrepareStatus: 'running' },
			data: {
				lastPrepareStatus: 'failed',
				lastPrepareError: 'Interrupted by a worker restart'
			}
		});
	});
});
