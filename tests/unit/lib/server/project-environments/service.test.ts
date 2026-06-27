import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	projectFindFirst: vi.fn(),
	profileFindFirst: vi.fn(),
	profileUpsert: vi.fn(),
	profileUpdateMany: vi.fn(),
	serviceFindMany: vi.fn(),
	buildProjectEnvironmentServiceOutputsForOrg: vi.fn(),
	eventFindMany: vi.fn(),
	envVarFindMany: vi.fn(),
	ensureMirror: vi.fn(),
	readMirrorFiles: vi.fn(),
	makeGitAuth: vi.fn(),
	authedCloneUrl: vi.fn(),
	executeProjectEnvironmentPrepare: vi.fn(),
	appendRunEvent: vi.fn(),
	getNextEventSeq: vi.fn(),
	workspaceRoot: vi.fn(),
	projectEnvironmentTemplatePath: vi.fn(),
	projectEnvironmentMetadataPath: vi.fn(),
	stat: vi.fn(),
	readFile: vi.fn(),
	ProjectEnvironmentPrepareError: class ProjectEnvironmentPrepareError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'ProjectEnvironmentPrepareError';
		}
	}
}));

vi.mock('node:fs/promises', () => ({
	stat: mocks.stat,
	readFile: mocks.readFile
}));

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		project: { findFirst: mocks.projectFindFirst },
		projectEnvironmentProfile: {
			findFirst: mocks.profileFindFirst,
			upsert: mocks.profileUpsert,
			updateMany: mocks.profileUpdateMany
		},
		projectEnvironmentPrepareEvent: { findMany: mocks.eventFindMany },
		projectEnvironmentService: { findMany: mocks.serviceFindMany },
		projectEnvVar: { findMany: mocks.envVarFindMany }
	}
}));

vi.mock('$lib/server/workspace', () => ({
	ensureMirror: mocks.ensureMirror,
	readMirrorFiles: mocks.readMirrorFiles
}));

vi.mock('$lib/server/github-git', () => ({
	makeGitAuth: mocks.makeGitAuth,
	authedCloneUrl: mocks.authedCloneUrl
}));

vi.mock('$lib/server/project-environments/prepare', () => ({
	ProjectEnvironmentPrepareError: mocks.ProjectEnvironmentPrepareError,
	executeProjectEnvironmentPrepare: mocks.executeProjectEnvironmentPrepare
}));

vi.mock('$lib/server/project-environment-services/service', () => ({
	buildProjectEnvironmentServiceOutputsForOrg: mocks.buildProjectEnvironmentServiceOutputsForOrg
}));

vi.mock('$lib/server/run-events', () => ({
	appendRunEvent: mocks.appendRunEvent,
	getNextEventSeq: mocks.getNextEventSeq
}));

vi.mock('$lib/server/workspace-paths', () => ({
	workspaceRoot: mocks.workspaceRoot,
	projectEnvironmentTemplatePath: mocks.projectEnvironmentTemplatePath,
	projectEnvironmentMetadataPath: mocks.projectEnvironmentMetadataPath
}));

vi.mock('$env/dynamic/private', () => ({
	env: { WORKSPACE_ROOT: '/workspaces' }
}));

import {
	ProjectEnvironmentError,
	buildRunEnvironmentConfig,
	detectProjectEnvironmentForOrg,
	getDefaultProjectEnvironmentForOrg,
	listProjectEnvironmentPrepareEventsForOrg,
	prepareRunEnvironmentIfNeeded,
	requireProjectEnvironmentProfileForOrg,
	upsertProjectEnvironmentProfileForOrg
} from '$lib/server/project-environments/service';

describe('project environment service', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.projectFindFirst.mockResolvedValue({
			id: 'p1',
			organizationId: 'org1',
			cloneUrl: 'https://github.com/acme/repo.git',
			defaultBranch: 'main'
		});
		mocks.profileFindFirst.mockResolvedValue(null);
		mocks.profileUpsert.mockResolvedValue({ id: 'env1', name: 'default' });
		mocks.eventFindMany.mockResolvedValue([]);
		mocks.serviceFindMany.mockResolvedValue([]);
		mocks.buildProjectEnvironmentServiceOutputsForOrg.mockResolvedValue({
			env: [],
			warnings: [],
			fingerprintInputs: []
		});
		mocks.envVarFindMany.mockResolvedValue([{ key: 'DATABASE_URL' }]);
		mocks.readMirrorFiles.mockResolvedValue({
			'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
			'bun.lock': 'lock'
		});
		mocks.makeGitAuth.mockResolvedValue({ env: { GIT_ASKPASS: '/tmp/askpass' }, cleanup: vi.fn() });
		mocks.authedCloneUrl.mockImplementation((url: string) => `${url}?auth=1`);
		mocks.executeProjectEnvironmentPrepare.mockResolvedValue({ status: 'prepared' });
		mocks.appendRunEvent.mockResolvedValue(undefined);
		mocks.getNextEventSeq.mockResolvedValue(0);
		mocks.workspaceRoot.mockReturnValue('/workspaces');
		mocks.projectEnvironmentTemplatePath.mockImplementation(
			(root: string, projectId: string, profileName: string) =>
				`${root}/${projectId}/environment/${profileName}/template`
		);
		mocks.projectEnvironmentMetadataPath.mockImplementation(
			(root: string, projectId: string, profileName: string) =>
				`${root}/${projectId}/environment/${profileName}/metadata.json`
		);
		mocks.stat.mockResolvedValue({ isDirectory: () => true });
		mocks.readFile.mockResolvedValue(
			JSON.stringify({
				projectId: 'p1',
				profileId: 'env1',
				profileName: 'default',
				runtime: 'node',
				packageManager: 'bun',
				installCommand: 'bun install',
				fingerprint: 'fp1'
			})
		);
	});

	it('builds a disabled run environment snapshot when no default profile exists', async () => {
		await expect(buildRunEnvironmentConfig('org1', 'p1')).resolves.toEqual({
			cacheMounts: [],
			snapshot: {
				enabled: false,
				warning: 'No project environment profile configured'
			}
		});
		expect(mocks.profileFindFirst).toHaveBeenCalledWith({
			where: { organizationId: 'org1', projectId: 'p1', name: 'default' }
		});
	});

	it('builds an enabled run environment snapshot for a current prepared profile', async () => {
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			name: 'default',
			status: 'ready',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp1',
			lastPreparedFingerprint: 'fp1',
			lastPrepareStatus: 'succeeded'
		});

		await expect(buildRunEnvironmentConfig('org1', 'p1')).resolves.toEqual({
			cacheMounts: [
				{
					source: '/workspaces/p1/cache/default/node/bun/install',
					target: '/root/.bun/install/cache'
				}
			],
			snapshot: {
				enabled: true,
				profileId: 'env1',
				profileName: 'default',
				runtime: 'node',
				packageManager: 'bun',
				installCommand: 'bun install',
				currentFingerprint: 'fp1',
				lastPreparedFingerprint: 'fp1',
				lastPrepareStatus: 'succeeded',
				needsPrepare: false,
				prepared: true,
				services: [],
				templatePath: '/workspaces/p1/environment/default/template'
			}
		});
	});

	it('adds ready services to the run environment snapshot', async () => {
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			name: 'default',
			status: 'ready',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp1',
			lastPreparedFingerprint: 'fp1',
			lastPrepareStatus: 'succeeded'
		});
		mocks.serviceFindMany.mockResolvedValueOnce([
			{
				id: 'svc1',
				kind: 'postgres',
				name: 'database',
				status: 'ready'
			}
		]);

		await expect(buildRunEnvironmentConfig('org1', 'p1')).resolves.toEqual({
			cacheMounts: [
				{
					source: '/workspaces/p1/cache/default/node/bun/install',
					target: '/root/.bun/install/cache'
				}
			],
			snapshot: expect.objectContaining({
				enabled: true,
				services: [
					{
						id: 'svc1',
						kind: 'postgres',
						name: 'database',
						status: 'ready'
					}
				]
			})
		});
	});

	it('returns ready service outputs as container env without storing values in the snapshot', async () => {
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			name: 'default',
			status: 'ready',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp1',
			lastPreparedFingerprint: 'fp1',
			lastPrepareStatus: 'succeeded'
		});
		mocks.serviceFindMany.mockResolvedValueOnce([
			{
				id: 'svc1',
				kind: 'postgres',
				name: 'database',
				status: 'ready'
			}
		]);
		mocks.buildProjectEnvironmentServiceOutputsForOrg.mockResolvedValueOnce({
			env: [
				{ key: 'DATABASE_URL', value: 'postgresql://secret', sensitive: true },
				{ key: 'POSTGRES_HOST', value: 'dotweaver-postgres', sensitive: false }
			],
			warnings: [],
			fingerprintInputs: []
		});

		await expect(buildRunEnvironmentConfig('org1', 'p1')).resolves.toEqual({
			cacheMounts: expect.any(Array),
			containerEnv: [
				{ key: 'DATABASE_URL', value: 'postgresql://secret', sensitive: true },
				{ key: 'POSTGRES_HOST', value: 'dotweaver-postgres', sensitive: false }
			],
			snapshot: expect.not.objectContaining({
				containerEnv: expect.any(Array)
			})
		});
		expect(mocks.buildProjectEnvironmentServiceOutputsForOrg).toHaveBeenCalledWith(
			'org1',
			'p1',
			'env1'
		);
	});

	it('rejects run environments when an enabled service is not ready', async () => {
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			name: 'default',
			status: 'ready',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp1',
			lastPreparedFingerprint: 'fp1',
			lastPrepareStatus: 'succeeded'
		});
		mocks.serviceFindMany.mockResolvedValueOnce([
			{
				id: 'svc1',
				kind: 'redis',
				name: 'cache',
				status: 'configured'
			}
		]);

		const promise = buildRunEnvironmentConfig('org1', 'p1');
		await expect(promise).rejects.toBeInstanceOf(ProjectEnvironmentError);
		await expect(promise).rejects.toThrow('Project environment service is not ready');
	});

	it('promotes a current prepared detected profile before building a run snapshot', async () => {
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			name: 'default',
			status: 'detected',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp1',
			lastPreparedFingerprint: 'fp1',
			lastPrepareStatus: 'succeeded'
		});

		await expect(buildRunEnvironmentConfig('org1', 'p1')).resolves.toEqual({
			cacheMounts: [
				{
					source: '/workspaces/p1/cache/default/node/bun/install',
					target: '/root/.bun/install/cache'
				}
			],
			snapshot: expect.objectContaining({
				enabled: true,
				profileId: 'env1',
				profileName: 'default',
				prepared: true,
				templatePath: '/workspaces/p1/environment/default/template'
			})
		});
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
	});

	it('rejects stale ready profiles instead of preparing inside a run', async () => {
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			name: 'default',
			status: 'ready',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp2',
			lastPreparedFingerprint: 'fp1',
			lastPrepareStatus: 'succeeded'
		});

		const promise = buildRunEnvironmentConfig('org1', 'p1');
		await expect(promise).rejects.toBeInstanceOf(ProjectEnvironmentError);
		await expect(promise).rejects.toThrow('Prepare the project environment before starting a run');
	});

	it('rejects current profiles when the prepared template is missing', async () => {
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			name: 'default',
			status: 'ready',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp1',
			lastPreparedFingerprint: 'fp1',
			lastPrepareStatus: 'succeeded'
		});
		mocks.stat.mockRejectedValueOnce(
			Object.assign(new Error('missing template'), { code: 'ENOENT' })
		);

		const promise = buildRunEnvironmentConfig('org1', 'p1');
		await expect(promise).rejects.toBeInstanceOf(ProjectEnvironmentError);
		await expect(promise).rejects.toThrow('Prepare the project environment before starting a run');
		expect(mocks.readFile).not.toHaveBeenCalled();
	});

	it('rejects current profiles when prepared metadata is stale', async () => {
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			name: 'default',
			status: 'ready',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp2',
			lastPreparedFingerprint: 'fp2',
			lastPrepareStatus: 'succeeded'
		});
		mocks.readFile.mockResolvedValueOnce(
			JSON.stringify({
				projectId: 'p1',
				profileId: 'env1',
				profileName: 'default',
				runtime: 'node',
				packageManager: 'bun',
				installCommand: 'bun install',
				fingerprint: 'fp1'
			})
		);

		const promise = buildRunEnvironmentConfig('org1', 'p1');
		await expect(promise).rejects.toBeInstanceOf(ProjectEnvironmentError);
		await expect(promise).rejects.toThrow('Prepare the project environment before starting a run');
	});

	it('builds a prepared run environment snapshot for an empty install command profile', async () => {
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			name: 'default',
			status: 'ready',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: '',
			currentFingerprint: 'fp1',
			lastPreparedFingerprint: 'fp1',
			lastPrepareStatus: 'succeeded'
		});
		mocks.readFile.mockResolvedValueOnce(
			JSON.stringify({
				projectId: 'p1',
				profileId: 'env1',
				profileName: 'default',
				runtime: 'node',
				packageManager: 'bun',
				installCommand: '',
				fingerprint: 'fp1'
			})
		);

		await expect(buildRunEnvironmentConfig('org1', 'p1')).resolves.toEqual({
			cacheMounts: [
				{
					source: '/workspaces/p1/cache/default/node/bun/install',
					target: '/root/.bun/install/cache'
				}
			],
			snapshot: {
				enabled: true,
				profileId: 'env1',
				profileName: 'default',
				runtime: 'node',
				packageManager: 'bun',
				installCommand: '',
				currentFingerprint: 'fp1',
				lastPreparedFingerprint: 'fp1',
				lastPrepareStatus: 'succeeded',
				needsPrepare: false,
				prepared: true,
				services: [],
				templatePath: '/workspaces/p1/environment/default/template'
			}
		});
	});

	it('builds a disabled run environment snapshot for a detected profile that is not ready', async () => {
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			name: 'default',
			status: 'detected',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp1',
			lastPreparedFingerprint: null,
			lastPrepareStatus: 'never'
		});

		await expect(buildRunEnvironmentConfig('org1', 'p1')).resolves.toEqual({
			cacheMounts: [],
			snapshot: {
				enabled: false,
				warning: 'Project environment profile default is not ready',
				status: 'detected',
				profileId: 'env1'
			}
		});
	});

	it('builds a disabled run environment snapshot for an unconfigured profile that is not ready', async () => {
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			name: 'default',
			status: 'unconfigured',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp1',
			lastPreparedFingerprint: null,
			lastPrepareStatus: 'never'
		});

		await expect(buildRunEnvironmentConfig('org1', 'p1')).resolves.toEqual({
			cacheMounts: [],
			snapshot: {
				enabled: false,
				warning: 'Project environment profile default is not ready',
				status: 'unconfigured',
				profileId: 'env1'
			}
		});
	});

	it('rejects an invalid default run environment profile', async () => {
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			name: 'default',
			status: 'invalid',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp1',
			lastPreparedFingerprint: null,
			lastPrepareStatus: 'never'
		});

		await expect(buildRunEnvironmentConfig('org1', 'p1')).rejects.toThrow(ProjectEnvironmentError);
		await expect(buildRunEnvironmentConfig('org1', 'p1')).rejects.toThrow(
			'Environment profile default is invalid'
		);
	});

	it('skips run environment preparation unless the snapshot is enabled and stale', async () => {
		await prepareRunEnvironmentIfNeeded({
			runId: 'r1',
			checkoutPath: '/checkout',
			createdById: 'u1',
			environmentSnapshot: { enabled: false }
		});
		await prepareRunEnvironmentIfNeeded({
			runId: 'r1',
			checkoutPath: '/checkout',
			createdById: 'u1',
			environmentSnapshot: { enabled: true, profileId: 'env1', needsPrepare: false }
		});

		expect(mocks.getNextEventSeq).not.toHaveBeenCalled();
		expect(mocks.appendRunEvent).not.toHaveBeenCalled();
		expect(mocks.executeProjectEnvironmentPrepare).not.toHaveBeenCalled();
	});

	it('appends started and completed events around run environment preparation', async () => {
		mocks.getNextEventSeq.mockResolvedValue(4);

		await prepareRunEnvironmentIfNeeded({
			runId: 'r1',
			checkoutPath: '/checkout',
			createdById: 'u1',
			environmentSnapshot: { enabled: true, profileId: 'env1', needsPrepare: true }
		});

		expect(mocks.getNextEventSeq).toHaveBeenCalledWith('r1');
		expect(mocks.appendRunEvent).toHaveBeenNthCalledWith(1, 'r1', 4, {
			type: 'system',
			subtype: 'environment_prepare_started',
			profileId: 'env1'
		});
		expect(mocks.executeProjectEnvironmentPrepare).toHaveBeenCalledWith({
			profileId: 'env1',
			requestedById: 'u1',
			force: false
		});
		expect(mocks.appendRunEvent).toHaveBeenNthCalledWith(2, 'r1', 5, {
			type: 'system',
			subtype: 'environment_prepare_completed',
			profileId: 'env1'
		});
		expect(mocks.appendRunEvent.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.executeProjectEnvironmentPrepare.mock.invocationCallOrder[0]
		);
		expect(mocks.executeProjectEnvironmentPrepare.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.appendRunEvent.mock.invocationCallOrder[1]
		);
	});

	it('appends a skipped completed event when run environment preparation is already current', async () => {
		mocks.getNextEventSeq.mockResolvedValue(6);
		mocks.executeProjectEnvironmentPrepare.mockResolvedValue({ status: 'skipped_current' });

		await prepareRunEnvironmentIfNeeded({
			runId: 'r1',
			checkoutPath: '/checkout',
			createdById: 'u1',
			environmentSnapshot: { enabled: true, profileId: 'env1', needsPrepare: true }
		});

		expect(mocks.appendRunEvent).toHaveBeenNthCalledWith(1, 'r1', 6, {
			type: 'system',
			subtype: 'environment_prepare_started',
			profileId: 'env1'
		});
		expect(mocks.appendRunEvent).toHaveBeenNthCalledWith(2, 'r1', 7, {
			type: 'system',
			subtype: 'environment_prepare_completed',
			profileId: 'env1',
			skipped: true
		});
	});

	it('appends a running event and rejects when run environment preparation is already running', async () => {
		mocks.getNextEventSeq.mockResolvedValue(10);
		mocks.executeProjectEnvironmentPrepare.mockResolvedValue({ status: 'already_running' });

		await expect(
			prepareRunEnvironmentIfNeeded({
				runId: 'r1',
				checkoutPath: '/checkout',
				createdById: 'u1',
				environmentSnapshot: { enabled: true, profileId: 'env1', needsPrepare: true }
			})
		).rejects.toThrow('Project environment preparation is already running');

		expect(mocks.appendRunEvent).toHaveBeenNthCalledWith(1, 'r1', 10, {
			type: 'system',
			subtype: 'environment_prepare_started',
			profileId: 'env1'
		});
		expect(mocks.appendRunEvent).toHaveBeenNthCalledWith(2, 'r1', 11, {
			type: 'system',
			subtype: 'environment_prepare_running',
			profileId: 'env1',
			error: 'Project environment preparation is already running'
		});
	});

	it('appends a failed event and rethrows when run environment preparation fails', async () => {
		mocks.getNextEventSeq.mockResolvedValue(8);
		mocks.executeProjectEnvironmentPrepare.mockRejectedValue(
			new Error('Install command failed with exit code 1')
		);

		await expect(
			prepareRunEnvironmentIfNeeded({
				runId: 'r1',
				checkoutPath: '/checkout',
				createdById: 'u1',
				environmentSnapshot: { enabled: true, profileId: 'env1', needsPrepare: true }
			})
		).rejects.toThrow('Install command failed with exit code 1');

		expect(mocks.appendRunEvent).toHaveBeenNthCalledWith(1, 'r1', 8, {
			type: 'system',
			subtype: 'environment_prepare_started',
			profileId: 'env1'
		});
		expect(mocks.appendRunEvent).toHaveBeenNthCalledWith(2, 'r1', 9, {
			type: 'system',
			subtype: 'environment_prepare_failed',
			profileId: 'env1',
			error: 'Install command failed with exit code 1'
		});
	});

	it('returns null when the default profile does not exist', async () => {
		await expect(getDefaultProjectEnvironmentForOrg('org1', 'p1')).resolves.toBeNull();
		expect(mocks.projectFindFirst).toHaveBeenCalledWith({
			where: { id: 'p1', organizationId: 'org1' },
			select: { id: true }
		});
	});

	it('detects a project environment and upserts a detected default profile', async () => {
		await expect(
			detectProjectEnvironmentForOrg({
				organizationId: 'org1',
				userId: 'u1',
				projectId: 'p1',
				githubToken: 'gh-token'
			})
		).resolves.toEqual({ id: 'env1', name: 'default' });

		expect(mocks.ensureMirror).toHaveBeenCalled();
		expect(mocks.profileUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId_name: { projectId: 'p1', name: 'default' } },
				create: expect.objectContaining({
					projectId: 'p1',
					organizationId: 'org1',
					createdById: 'u1',
					runtime: 'node',
					packageManager: 'bun',
					status: 'detected',
					currentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
				})
			})
		);
	});

	it('changes detected fingerprint when dependency manifests change', async () => {
		mocks.readMirrorFiles
			.mockResolvedValueOnce({
				'package.json': JSON.stringify({
					scripts: { test: 'vitest' },
					dependencies: { svelte: '5.0.0' }
				}),
				'bun.lock': 'lock'
			})
			.mockResolvedValueOnce({
				'package.json': JSON.stringify({
					scripts: { test: 'vitest' },
					dependencies: { svelte: '5.1.0' }
				}),
				'bun.lock': 'lock'
			});

		await detectProjectEnvironmentForOrg({
			organizationId: 'org1',
			userId: 'u1',
			projectId: 'p1',
			githubToken: null
		});
		await detectProjectEnvironmentForOrg({
			organizationId: 'org1',
			userId: 'u1',
			projectId: 'p1',
			githubToken: null
		});

		const firstUpsert = mocks.profileUpsert.mock.calls[0][0];
		const secondUpsert = mocks.profileUpsert.mock.calls[1][0];

		expect(firstUpsert.create.currentFingerprint).not.toBe(secondUpsert.create.currentFingerprint);
	});

	it('changes detected fingerprint when existing service outputs change', async () => {
		mocks.profileFindFirst.mockResolvedValue({ id: 'env1' });
		mocks.envVarFindMany.mockResolvedValue([]);
		mocks.buildProjectEnvironmentServiceOutputsForOrg
			.mockResolvedValueOnce({
				env: [{ key: 'DATABASE_URL', value: 'postgres://first', sensitive: true }],
				warnings: [],
				fingerprintInputs: [
					{
						kind: 'postgres',
						name: 'database',
						enabled: true,
						status: 'ready',
						providerVersion: '1',
						config: { image: 'postgres:17-alpine', port: 5432 },
						outputKeys: ['DATABASE_URL'],
						outputValueHashes: ['first-hash']
					}
				]
			})
			.mockResolvedValueOnce({
				env: [{ key: 'DATABASE_URL', value: 'postgres://second', sensitive: true }],
				warnings: [],
				fingerprintInputs: [
					{
						kind: 'postgres',
						name: 'database',
						enabled: true,
						status: 'ready',
						providerVersion: '1',
						config: { image: 'postgres:17-alpine', port: 5432 },
						outputKeys: ['DATABASE_URL'],
						outputValueHashes: ['second-hash']
					}
				]
			});

		await detectProjectEnvironmentForOrg({
			organizationId: 'org1',
			userId: 'u1',
			projectId: 'p1',
			githubToken: null
		});
		await detectProjectEnvironmentForOrg({
			organizationId: 'org1',
			userId: 'u1',
			projectId: 'p1',
			githubToken: null
		});

		const firstUpsert = mocks.profileUpsert.mock.calls[0][0];
		const secondUpsert = mocks.profileUpsert.mock.calls[1][0];

		expect(mocks.buildProjectEnvironmentServiceOutputsForOrg).toHaveBeenCalledWith(
			'org1',
			'p1',
			'env1'
		);
		expect(firstUpsert.create.currentFingerprint).not.toBe(secondUpsert.create.currentFingerprint);
	});

	it('changes detected fingerprint when mapped service env keys change', async () => {
		mocks.profileFindFirst.mockResolvedValue({ id: 'env1' });
		mocks.envVarFindMany.mockResolvedValue([]);
		mocks.buildProjectEnvironmentServiceOutputsForOrg
			.mockResolvedValueOnce({
				env: [{ key: 'DIRECT_URL', value: 'postgres://same', sensitive: true }],
				warnings: [],
				fingerprintInputs: [
					{
						kind: 'postgres',
						name: 'database',
						enabled: true,
						status: 'ready',
						providerVersion: '1',
						config: { image: 'postgres:17-alpine' },
						outputKeys: ['DIRECT_URL'],
						outputValueHashes: ['same-hash']
					}
				]
			})
			.mockResolvedValueOnce({
				env: [{ key: 'DATABASE_URL', value: 'postgres://same', sensitive: true }],
				warnings: [],
				fingerprintInputs: [
					{
						kind: 'postgres',
						name: 'database',
						enabled: true,
						status: 'ready',
						providerVersion: '1',
						config: { image: 'postgres:17-alpine' },
						outputKeys: ['DATABASE_URL'],
						outputValueHashes: ['same-hash']
					}
				]
			});

		await detectProjectEnvironmentForOrg({
			organizationId: 'org1',
			userId: 'u1',
			projectId: 'p1',
			githubToken: null
		});
		await detectProjectEnvironmentForOrg({
			organizationId: 'org1',
			userId: 'u1',
			projectId: 'p1',
			githubToken: null
		});

		const firstUpsert = mocks.profileUpsert.mock.calls[0][0];
		const secondUpsert = mocks.profileUpsert.mock.calls[1][0];

		expect(firstUpsert.create.currentFingerprint).not.toBe(secondUpsert.create.currentFingerprint);
	});

	it('upserts a validated ready profile from user input', async () => {
		await upsertProjectEnvironmentProfileForOrg('org1', 'u1', {
			projectId: 'p1',
			runtime: 'node',
			adapterId: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			testCommand: 'bun run test',
			buildCommand: '',
			devCommand: ''
		});

		expect(mocks.profileUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					status: 'ready',
					currentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
				}),
				update: expect.objectContaining({
					status: 'ready',
					detection: { source: 'manual' },
					currentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
				})
			})
		);
	});

	it('changes manual profile fingerprint when existing service outputs change', async () => {
		mocks.profileFindFirst.mockResolvedValue({ id: 'env1' });
		mocks.envVarFindMany.mockResolvedValue([]);
		mocks.buildProjectEnvironmentServiceOutputsForOrg
			.mockResolvedValueOnce({
				env: [{ key: 'REDIS_URL', value: 'redis://first', sensitive: true }],
				warnings: [],
				fingerprintInputs: [
					{
						kind: 'redis',
						name: 'cache',
						enabled: true,
						status: 'ready',
						providerVersion: '1',
						config: { image: 'redis:7-alpine', port: 6379 },
						outputKeys: ['REDIS_URL'],
						outputValueHashes: ['first-hash']
					}
				]
			})
			.mockResolvedValueOnce({
				env: [{ key: 'REDIS_URL', value: 'redis://second', sensitive: true }],
				warnings: [],
				fingerprintInputs: [
					{
						kind: 'redis',
						name: 'cache',
						enabled: true,
						status: 'ready',
						providerVersion: '1',
						config: { image: 'redis:7-alpine', port: 6379 },
						outputKeys: ['REDIS_URL'],
						outputValueHashes: ['second-hash']
					}
				]
			});

		await upsertProjectEnvironmentProfileForOrg('org1', 'u1', {
			projectId: 'p1',
			runtime: 'node',
			adapterId: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			testCommand: 'bun run test',
			buildCommand: '',
			devCommand: ''
		});
		await upsertProjectEnvironmentProfileForOrg('org1', 'u1', {
			projectId: 'p1',
			runtime: 'node',
			adapterId: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			testCommand: 'bun run test',
			buildCommand: '',
			devCommand: ''
		});

		const firstUpsert = mocks.profileUpsert.mock.calls[0][0];
		const secondUpsert = mocks.profileUpsert.mock.calls[1][0];

		expect(mocks.buildProjectEnvironmentServiceOutputsForOrg).toHaveBeenCalledWith(
			'org1',
			'p1',
			'env1'
		);
		expect(firstUpsert.create.currentFingerprint).not.toBe(secondUpsert.create.currentFingerprint);
	});

	it('throws ProjectEnvironmentError when the project is outside the organization', async () => {
		mocks.projectFindFirst.mockResolvedValue(null);

		await expect(getDefaultProjectEnvironmentForOrg('org1', 'p1')).rejects.toBeInstanceOf(
			ProjectEnvironmentError
		);
	});

	it('requires a project environment profile scoped to org and project', async () => {
		mocks.profileFindFirst.mockResolvedValue({ id: 'env1' });

		await expect(requireProjectEnvironmentProfileForOrg('org1', 'p1', 'env1')).resolves.toEqual({
			id: 'env1'
		});

		expect(mocks.projectFindFirst).toHaveBeenCalledWith({
			where: { id: 'p1', organizationId: 'org1' },
			select: { id: true }
		});
		expect(mocks.profileFindFirst).toHaveBeenCalledWith({
			where: { id: 'env1', projectId: 'p1', organizationId: 'org1' },
			select: { id: true }
		});
		expect(mocks.projectFindFirst.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.profileFindFirst.mock.invocationCallOrder[0]
		);
	});

	it('throws ProjectEnvironmentError when the scoped project environment profile is missing', async () => {
		mocks.profileFindFirst.mockResolvedValue(null);
		const promise = requireProjectEnvironmentProfileForOrg('org1', 'p1', 'env1');

		await expect(promise).rejects.toBeInstanceOf(ProjectEnvironmentError);
		await expect(promise).rejects.toThrow('Project environment profile not found');
	});

	it('lists prepare events scoped to org and project', async () => {
		mocks.profileFindFirst.mockResolvedValue({ id: 'env1', projectId: 'p1' });
		mocks.eventFindMany.mockResolvedValue([{ id: 'e1', seq: 0 }]);

		await expect(listProjectEnvironmentPrepareEventsForOrg('org1', 'p1', 'env1')).resolves.toEqual([
			{ id: 'e1', seq: 0 }
		]);
	});
});
