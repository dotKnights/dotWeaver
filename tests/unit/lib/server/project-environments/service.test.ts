import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	projectFindFirst: vi.fn(),
	profileFindFirst: vi.fn(),
	profileUpsert: vi.fn(),
	profileUpdateMany: vi.fn(),
	eventFindMany: vi.fn(),
	envVarFindMany: vi.fn(),
	ensureMirror: vi.fn(),
	readMirrorFiles: vi.fn(),
	makeGitAuth: vi.fn(),
	authedCloneUrl: vi.fn()
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

vi.mock('$env/dynamic/private', () => ({
	env: { WORKSPACE_ROOT: '/workspaces' }
}));

import {
	ProjectEnvironmentError,
	detectProjectEnvironmentForOrg,
	getDefaultProjectEnvironmentForOrg,
	listProjectEnvironmentPrepareEventsForOrg,
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
		mocks.envVarFindMany.mockResolvedValue([{ key: 'DATABASE_URL' }]);
		mocks.readMirrorFiles.mockResolvedValue({
			'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
			'bun.lock': 'lock'
		});
		mocks.makeGitAuth.mockResolvedValue({ env: { GIT_ASKPASS: '/tmp/askpass' }, cleanup: vi.fn() });
		mocks.authedCloneUrl.mockImplementation((url: string) => `${url}?auth=1`);
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
				create: expect.objectContaining({ status: 'ready' }),
				update: expect.objectContaining({
					status: 'ready',
					detection: { source: 'manual' }
				})
			})
		);
	});

	it('throws ProjectEnvironmentError when the project is outside the organization', async () => {
		mocks.projectFindFirst.mockResolvedValue(null);

		await expect(getDefaultProjectEnvironmentForOrg('org1', 'p1')).rejects.toBeInstanceOf(
			ProjectEnvironmentError
		);
	});

	it('lists prepare events scoped to org and project', async () => {
		mocks.profileFindFirst.mockResolvedValue({ id: 'env1', projectId: 'p1' });
		mocks.eventFindMany.mockResolvedValue([{ id: 'e1', seq: 0 }]);

		await expect(listProjectEnvironmentPrepareEventsForOrg('org1', 'p1', 'env1')).resolves.toEqual([
			{ id: 'e1', seq: 0 }
		]);
	});
});
