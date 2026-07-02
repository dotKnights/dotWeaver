import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		project: { findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn() }
	}
}));

vi.mock('$lib/server/integrations/github/service', () => ({
	getRepo: vi.fn(),
	mapRepoToProjectInput: vi.fn()
}));

vi.mock('$lib/server/authz/service', () => ({
	listAccessibleProjects: vi.fn(),
	can: vi.fn()
}));

import { prisma } from '$lib/server/prisma';
import { getRepo, mapRepoToProjectInput } from '$lib/server/integrations/github/service';
import { projectResource } from '$lib/authz/resources';
import { listAccessibleProjects, can } from '$lib/server/authz/service';
import {
	listProjectsForOrg,
	getProjectForOrg,
	listProjectsForActor,
	getProjectForActor,
	GithubProjectImportError,
	importGithubProjectForOrg
} from '$lib/server/projects/service';
import type { AuthzActor } from '$lib/server/authz/actor';

type ProjectRow = { id: string };

const findMany = vi.mocked(prisma.project.findMany) as unknown as Mock<() => Promise<ProjectRow[]>>;
const findFirst = vi.mocked(prisma.project.findFirst) as unknown as Mock<
	() => Promise<ProjectRow | null>
>;
const upsert = vi.mocked(prisma.project.upsert) as unknown as Mock<() => Promise<ProjectRow>>;
const getRepoMock = vi.mocked(getRepo) as unknown as Mock;
const mapRepoToProjectInputMock = vi.mocked(mapRepoToProjectInput) as unknown as Mock;
const listAccessibleProjectsMock = vi.mocked(listAccessibleProjects) as unknown as Mock;
const canMock = vi.mocked(can) as unknown as Mock;

const actor: AuthzActor = {
	userId: 'user1',
	internalMemberships: [],
	clientMemberships: []
};

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

	it('listProjectsForActor délègue à listAccessibleProjects', async () => {
		listAccessibleProjectsMock.mockResolvedValue([{ id: 'p1' }]);

		await expect(listProjectsForActor(actor)).resolves.toEqual([{ id: 'p1' }]);
		expect(listAccessibleProjects).toHaveBeenCalledWith(actor);
	});

	it("getProjectForActor renvoie null sans requête Prisma quand l'acteur ne peut pas voir le projet", async () => {
		canMock.mockResolvedValue(false);

		await expect(getProjectForActor(actor, 'p1')).resolves.toBeNull();
		expect(can).toHaveBeenCalledWith(actor, 'project.view', projectResource('p1'));
		expect(prisma.project.findFirst).not.toHaveBeenCalled();
	});

	it("getProjectForActor requête le projet par id quand l'acteur peut le voir", async () => {
		canMock.mockResolvedValue(true);
		findFirst.mockResolvedValue({ id: 'p1' });

		await expect(getProjectForActor(actor, 'p1')).resolves.toEqual({ id: 'p1' });
		expect(can).toHaveBeenCalledWith(actor, 'project.view', projectResource('p1'));
		expect(prisma.project.findFirst).toHaveBeenCalledWith({ where: { id: 'p1' } });
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
