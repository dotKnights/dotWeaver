import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		project: { findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn() }
	}
}));

vi.mock('$lib/server/github', () => ({
	getRepo: vi.fn(),
	mapRepoToProjectInput: vi.fn()
}));

import { prisma } from '$lib/server/prisma';
import { getRepo, mapRepoToProjectInput } from '$lib/server/github';
import {
	listProjectsForOrg,
	getProjectForOrg,
	GithubProjectImportError,
	importGithubProjectForOrg
} from '$lib/server/projects-service';

type ProjectRow = { id: string };

const findMany = vi.mocked(prisma.project.findMany) as unknown as Mock<() => Promise<ProjectRow[]>>;
const findFirst = vi.mocked(prisma.project.findFirst) as unknown as Mock<
	() => Promise<ProjectRow | null>
>;
const upsert = vi.mocked(prisma.project.upsert) as unknown as Mock<() => Promise<ProjectRow>>;
const getRepoMock = vi.mocked(getRepo) as unknown as Mock;
const mapRepoToProjectInputMock = vi.mocked(mapRepoToProjectInput) as unknown as Mock;

describe('projects-service', () => {
	beforeEach(() => vi.clearAllMocks());

	it('listProjectsForOrg scope par organizationId, trié récent', async () => {
		findMany.mockResolvedValue([{ id: 'p1' }]);
		const res = await listProjectsForOrg('org1');
		expect(prisma.project.findMany).toHaveBeenCalledWith({
			where: { organizationId: 'org1' },
			orderBy: { createdAt: 'desc' }
		});
		expect(res).toEqual([{ id: 'p1' }]);
	});

	it("getProjectForOrg renvoie le projet si trouvé dans l'org", async () => {
		findFirst.mockResolvedValue({ id: 'p1' });
		expect(await getProjectForOrg('org1', 'p1')).toEqual({ id: 'p1' });
		expect(prisma.project.findFirst).toHaveBeenCalledWith({
			where: { id: 'p1', organizationId: 'org1' }
		});
	});

	it('getProjectForOrg renvoie null si absent/hors org', async () => {
		findFirst.mockResolvedValue(null);
		expect(await getProjectForOrg('org1', 'nope')).toBeNull();
	});

	it('importGithubProjectForOrg refuse quand le token GitHub est absent', async () => {
		await expect(
			importGithubProjectForOrg({
				organizationId: 'org1',
				userId: 'user1',
				token: null,
				owner: 'octocat',
				name: 'hello-world'
			})
		).rejects.toBeInstanceOf(GithubProjectImportError);

		await expect(
			importGithubProjectForOrg({
				organizationId: 'org1',
				userId: 'user1',
				token: null,
				owner: 'octocat',
				name: 'hello-world'
			})
		).rejects.toThrow('Connect your GitHub account to continue');
		expect(getRepo).not.toHaveBeenCalled();
		expect(prisma.project.upsert).not.toHaveBeenCalled();
	});

	it('importGithubProjectForOrg importe un repo GitHub dans une organisation', async () => {
		const repo = {
			id: 123,
			name: 'hello-world',
			full_name: 'octocat/hello-world',
			private: true,
			default_branch: 'main',
			clone_url: 'https://github.com/octocat/hello-world.git',
			owner: { login: 'octocat' }
		};
		const data = {
			organizationId: 'org1',
			githubRepoId: '123',
			owner: 'octocat',
			name: 'hello-world',
			defaultBranch: 'main',
			cloneUrl: 'https://github.com/octocat/hello-world.git',
			private: true,
			importedById: 'user1'
		};
		getRepoMock.mockResolvedValue(repo);
		mapRepoToProjectInputMock.mockReturnValue(data);
		upsert.mockResolvedValue({ id: 'project1' });

		await expect(
			importGithubProjectForOrg({
				organizationId: 'org1',
				userId: 'user1',
				token: 'gho_token',
				owner: 'octocat',
				name: 'hello-world'
			})
		).resolves.toEqual({ id: 'project1' });
		expect(getRepo).toHaveBeenCalledWith('gho_token', 'octocat', 'hello-world');
		expect(mapRepoToProjectInput).toHaveBeenCalledWith(repo, 'org1', 'user1');
		expect(prisma.project.upsert).toHaveBeenCalledWith({
			where: { organizationId_githubRepoId: { organizationId: 'org1', githubRepoId: '123' } },
			create: data,
			update: { defaultBranch: 'main', cloneUrl: data.cloneUrl, private: true }
		});
	});
});
