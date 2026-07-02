import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { projectResource } from '$lib/authz/resources';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	}),
	memberFindMany: vi.fn(),
	clientOrganizationMemberFindMany: vi.fn(),
	projectFindUnique: vi.fn(),
	projectFindMany: vi.fn(),
	accessGrantFindMany: vi.fn(),
	runFindFirst: vi.fn()
}));

vi.mock('$app/server', () => ({ getRequestEvent: mocks.getRequestEvent }));
vi.mock('@sveltejs/kit', () => ({ error: mocks.error }));
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		member: { findMany: mocks.memberFindMany },
		clientOrganizationMember: { findMany: mocks.clientOrganizationMemberFindMany },
		project: { findUnique: mocks.projectFindUnique, findMany: mocks.projectFindMany },
		accessGrant: { findMany: mocks.accessGrantFindMany },
		run: { findFirst: mocks.runFindFirst }
	}
}));

import { actorForUserId, requireActor, type AuthzActor } from '$lib/server/authz/actor';
import { can, listAccessibleProjects, requirePermission } from '$lib/server/authz/service';
import { requireRunPermission } from '$lib/server/authz/runs';

const memberFindMany = mocks.memberFindMany as Mock;
const clientOrganizationMemberFindMany = mocks.clientOrganizationMemberFindMany as Mock;
const projectFindUnique = mocks.projectFindUnique as Mock;
const projectFindMany = mocks.projectFindMany as Mock;
const accessGrantFindMany = mocks.accessGrantFindMany as Mock;
const runFindFirst = mocks.runFindFirst as Mock;

const internalActor: AuthzActor = {
	userId: 'user_internal',
	internalMemberships: [{ organizationId: 'org1', role: 'owner' }],
	clientMemberships: []
};

const externalActor: AuthzActor = {
	userId: 'user_client',
	internalMemberships: [],
	clientMemberships: [
		{
			id: 'client_member1',
			organizationId: 'org1',
			clientOrganizationId: 'client_org1',
			role: 'member'
		}
	]
};

const mixedActor: AuthzActor = {
	userId: 'user_mixed',
	internalMemberships: [{ organizationId: 'org1', role: 'member' }],
	clientMemberships: [
		{
			id: 'client_member2',
			organizationId: 'org2',
			clientOrganizationId: 'client_org2',
			role: 'member'
		}
	]
};

describe('authz actor loading', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'user1' } } });
		memberFindMany.mockResolvedValue([{ organizationId: 'org1', role: 'owner' }]);
		clientOrganizationMemberFindMany.mockResolvedValue([
			{
				id: 'client_member1',
				organizationId: 'org1',
				clientOrganizationId: 'client_org1',
				role: 'admin'
			}
		]);
	});

	it('requireActor loads the signed-in user memberships from Prisma', async () => {
		await expect(requireActor()).resolves.toEqual({
			userId: 'user1',
			internalMemberships: [{ organizationId: 'org1', role: 'owner' }],
			clientMemberships: [
				{
					id: 'client_member1',
					organizationId: 'org1',
					clientOrganizationId: 'client_org1',
					role: 'admin'
				}
			]
		});

		expect(memberFindMany).toHaveBeenCalledWith({
			where: { userId: 'user1' },
			select: { organizationId: true, role: true }
		});
		expect(clientOrganizationMemberFindMany).toHaveBeenCalledWith({
			where: { userId: 'user1' },
			select: { id: true, organizationId: true, clientOrganizationId: true, role: true }
		});
	});

	it('actorForUserId loads internal and client memberships for an explicit user id', async () => {
		await actorForUserId('user2');

		expect(memberFindMany).toHaveBeenCalledWith({
			where: { userId: 'user2' },
			select: { organizationId: true, role: true }
		});
		expect(clientOrganizationMemberFindMany).toHaveBeenCalledWith({
			where: { userId: 'user2' },
			select: { id: true, organizationId: true, clientOrganizationId: true, role: true }
		});
	});

	it('unauthenticated requireActor throws 401', async () => {
		mocks.getRequestEvent.mockReturnValue({ locals: {} });

		await expect(requireActor()).rejects.toMatchObject({
			status: 401,
			message: 'Not authenticated'
		});
		expect(memberFindMany).not.toHaveBeenCalled();
		expect(clientOrganizationMemberFindMany).not.toHaveBeenCalled();
	});
});

describe('authz service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		projectFindUnique.mockResolvedValue({ organizationId: 'org1' });
		accessGrantFindMany.mockResolvedValue([]);
	});

	it('allows internal team members of the project organization without querying grants', async () => {
		await expect(can(internalActor, 'run.create', projectResource('project1'))).resolves.toBe(true);

		expect(projectFindUnique).toHaveBeenCalledWith({
			where: { id: 'project1' },
			select: { organizationId: true }
		});
		expect(accessGrantFindMany).not.toHaveBeenCalled();
	});

	it('denies access to absent resources without querying grants', async () => {
		projectFindUnique.mockResolvedValue(null);

		await expect(can(externalActor, 'project.view', projectResource('missing'))).resolves.toBe(
			false
		);

		expect(projectFindUnique).toHaveBeenCalledWith({
			where: { id: 'missing' },
			select: { organizationId: true }
		});
		expect(accessGrantFindMany).not.toHaveBeenCalled();
	});

	it('allows external clients through inherited client-organization grants only for granted permissions', async () => {
		accessGrantFindMany.mockResolvedValue([
			{
				permissions: ['project.view'],
				subjectType: 'client_organization',
				subjectId: 'client_org1'
			}
		]);

		await expect(can(externalActor, 'project.view', projectResource('project1'))).resolves.toBe(
			true
		);
		await expect(can(externalActor, 'run.view', projectResource('project1'))).resolves.toBe(false);

		expect(accessGrantFindMany).toHaveBeenCalledWith({
			where: {
				organizationId: 'org1',
				resourceType: 'project',
				resourceId: 'project1',
				OR: [
					{ subjectType: 'client_organization', subjectId: { in: ['client_org1'] } },
					{ subjectType: 'client_member', subjectId: { in: ['client_member1'] } }
				]
			},
			select: { permissions: true }
		});
	});

	it('unions inherited client-organization grants and direct client-member grants', async () => {
		accessGrantFindMany.mockResolvedValue([
			{
				permissions: ['project.view'],
				subjectType: 'client_organization',
				subjectId: 'client_org1'
			},
			{ permissions: ['run.view'], subjectType: 'client_member', subjectId: 'client_member1' }
		]);

		await expect(can(externalActor, 'project.view', projectResource('project1'))).resolves.toBe(
			true
		);
		await expect(can(externalActor, 'run.view', projectResource('project1'))).resolves.toBe(true);
	});

	it('ignores unknown stale permission strings stored in grants', async () => {
		accessGrantFindMany.mockResolvedValue([
			{ permissions: ['project.view', 'project.retired', 'run.launch'] }
		]);

		await expect(can(externalActor, 'project.view', projectResource('project1'))).resolves.toBe(
			true
		);
		await expect(can(externalActor, 'run.create', projectResource('project1'))).resolves.toBe(
			false
		);
	});

	it('requirePermission throws 403 Forbidden when a permission is missing', async () => {
		await expect(
			requirePermission(externalActor, 'run.create', projectResource('project1'))
		).rejects.toMatchObject({
			status: 403,
			message: 'Forbidden'
		});
	});

	it('listAccessibleProjects returns granted external projects deduped and sorted by Prisma', async () => {
		accessGrantFindMany.mockResolvedValue([
			{ resourceId: 'project2' },
			{ resourceId: 'project1' },
			{ resourceId: 'project1' }
		]);
		projectFindMany.mockResolvedValue([{ id: 'project2' }, { id: 'project1' }]);

		await expect(listAccessibleProjects(externalActor)).resolves.toEqual([
			{ id: 'project2' },
			{ id: 'project1' }
		]);

		expect(accessGrantFindMany).toHaveBeenCalledWith({
			where: {
				organizationId: { in: ['org1'] },
				resourceType: 'project',
				permissions: { has: 'project.view' },
				OR: [
					{ subjectType: 'client_organization', subjectId: { in: ['client_org1'] } },
					{ subjectType: 'client_member', subjectId: { in: ['client_member1'] } }
				]
			},
			select: { resourceId: true }
		});
		expect(projectFindMany).toHaveBeenCalledWith({
			where: {
				organizationId: { in: ['org1'] },
				id: { in: ['project2', 'project1'] }
			},
			orderBy: { createdAt: 'desc' }
		});
	});

	it('listAccessibleProjects returns all projects from internal memberships', async () => {
		projectFindMany.mockResolvedValue([{ id: 'project1' }, { id: 'project2' }]);

		await expect(listAccessibleProjects(internalActor)).resolves.toEqual([
			{ id: 'project1' },
			{ id: 'project2' }
		]);

		expect(projectFindMany).toHaveBeenCalledWith({
			where: { organizationId: { in: ['org1'] } },
			orderBy: { createdAt: 'desc' }
		});
		expect(accessGrantFindMany).not.toHaveBeenCalled();
	});

	it('listAccessibleProjects unions internal projects and external grants for mixed actors', async () => {
		projectFindMany
			.mockResolvedValueOnce([{ id: 'internal_project' }, { id: 'shared_project' }])
			.mockResolvedValueOnce([{ id: 'external_project' }, { id: 'shared_project' }]);
		accessGrantFindMany.mockResolvedValue([
			{ resourceId: 'external_project' },
			{ resourceId: 'shared_project' },
			{ resourceId: 'external_project' }
		]);

		await expect(listAccessibleProjects(mixedActor)).resolves.toEqual([
			{ id: 'internal_project' },
			{ id: 'shared_project' },
			{ id: 'external_project' }
		]);

		expect(projectFindMany).toHaveBeenNthCalledWith(1, {
			where: { organizationId: { in: ['org1'] } },
			orderBy: { createdAt: 'desc' }
		});
		expect(accessGrantFindMany).toHaveBeenCalledWith({
			where: {
				organizationId: { in: ['org2'] },
				resourceType: 'project',
				permissions: { has: 'project.view' },
				OR: [
					{ subjectType: 'client_organization', subjectId: { in: ['client_org2'] } },
					{ subjectType: 'client_member', subjectId: { in: ['client_member2'] } }
				]
			},
			select: { resourceId: true }
		});
		expect(projectFindMany).toHaveBeenNthCalledWith(2, {
			where: {
				organizationId: { in: ['org2'] },
				id: { in: ['external_project', 'shared_project'] }
			},
			orderBy: { createdAt: 'desc' }
		});
	});
});

describe('run authz helpers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		runFindFirst.mockResolvedValue({ id: 'run1', projectId: 'project1' });
		projectFindUnique.mockResolvedValue({ organizationId: 'org1' });
		accessGrantFindMany.mockResolvedValue([{ permissions: ['project.view', 'run.view'] }]);
	});

	it('requireRunPermission resolves the run project and requires the project-level permission', async () => {
		await expect(requireRunPermission(externalActor, 'run.view', 'run1')).resolves.toEqual({
			id: 'run1',
			projectId: 'project1'
		});

		expect(runFindFirst).toHaveBeenCalledWith({
			where: { id: 'run1' },
			select: { id: true, projectId: true }
		});
		expect(projectFindUnique).toHaveBeenCalledWith({
			where: { id: 'project1' },
			select: { organizationId: true }
		});
	});

	it('requireRunPermission throws 404 when the run is absent', async () => {
		runFindFirst.mockResolvedValue(null);

		await expect(requireRunPermission(externalActor, 'run.view', 'missing')).rejects.toMatchObject({
			status: 404,
			message: 'Run not found'
		});
		expect(projectFindUnique).not.toHaveBeenCalled();
	});

	it('requireRunPermission throws 404 when the actor cannot view the run project', async () => {
		accessGrantFindMany.mockResolvedValue([]);

		await expect(requireRunPermission(externalActor, 'run.view', 'run1')).rejects.toMatchObject({
			status: 404,
			message: 'Run not found'
		});
	});

	it('requireRunPermission throws 403 when the project is viewable but the run permission is missing', async () => {
		accessGrantFindMany.mockResolvedValue([{ permissions: ['project.view'] }]);

		await expect(
			requireRunPermission(externalActor, 'run.diff.view', 'run1')
		).rejects.toMatchObject({
			status: 403,
			message: 'Forbidden'
		});
	});
});
