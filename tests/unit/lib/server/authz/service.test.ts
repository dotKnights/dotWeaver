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
import {
	can,
	listAccessibleProjects,
	listProjectPermissions,
	requireInternalOrgAdmin,
	requirePermission,
	requireProjectPermission
} from '$lib/server/authz/service';
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
		projectFindUnique.mockResolvedValue({ id: 'project1', organizationId: 'org1' });
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

	it('allows internal owners/admins to manage project access', async () => {
		await expect(
			can(internalActor, 'project.manage_access', projectResource('project1'))
		).resolves.toBe(true);

		const adminActor: AuthzActor = {
			userId: 'user_admin',
			internalMemberships: [{ organizationId: 'org1', role: 'admin' }],
			clientMemberships: []
		};
		await expect(
			can(adminActor, 'project.manage_access', projectResource('project1'))
		).resolves.toBe(true);
	});

	it('forbids non-admin internal members from managing project access but keeps functional access', async () => {
		const memberActor: AuthzActor = {
			userId: 'user_member',
			internalMemberships: [{ organizationId: 'org1', role: 'member' }],
			clientMemberships: []
		};

		await expect(
			can(memberActor, 'project.manage_access', projectResource('project1'))
		).resolves.toBe(false);
		await expect(can(memberActor, 'run.create', projectResource('project1'))).resolves.toBe(true);
	});

	it('omits project.manage_access from a non-admin internal member capabilities', async () => {
		const memberActor: AuthzActor = {
			userId: 'user_member',
			internalMemberships: [{ organizationId: 'org1', role: 'member' }],
			clientMemberships: []
		};

		const permissions = await listProjectPermissions(memberActor, 'project1');
		expect(permissions).toContain('run.create');
		expect(permissions).not.toContain('project.manage_access');
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

	it('requireProjectPermission resolves project context for granted permissions', async () => {
		accessGrantFindMany.mockResolvedValue([
			{ permissions: ['project.view', 'project.config.view'] }
		]);

		await expect(
			requireProjectPermission(externalActor, 'project.config.view', 'project1')
		).resolves.toEqual({
			id: 'project1',
			organizationId: 'org1'
		});

		expect(projectFindUnique).toHaveBeenCalledWith({
			where: { id: 'project1' },
			select: { id: true, organizationId: true }
		});
	});

	it('requireProjectPermission throws 404 when the project is absent', async () => {
		projectFindUnique.mockResolvedValue(null);

		await expect(
			requireProjectPermission(externalActor, 'project.config.view', 'missing')
		).rejects.toMatchObject({
			status: 404,
			message: 'Project not found'
		});
		expect(accessGrantFindMany).not.toHaveBeenCalled();
	});

	it('requireProjectPermission throws 404 when the existing project is not visible', async () => {
		await expect(
			requireProjectPermission(externalActor, 'project.config.manage', 'project1')
		).rejects.toMatchObject({
			status: 404,
			message: 'Project not found'
		});
	});

	it('requireProjectPermission throws 403 when the project is visible but the requested permission is missing', async () => {
		accessGrantFindMany.mockResolvedValue([{ permissions: ['project.view'] }]);

		await expect(
			requireProjectPermission(externalActor, 'project.config.manage', 'project1')
		).rejects.toMatchObject({
			status: 403,
			message: 'Forbidden'
		});
	});

	it('listProjectPermissions returns every registered permission for internal members', async () => {
		await expect(listProjectPermissions(internalActor, 'project1')).resolves.toEqual([
			'project.view',
			'project.manage_access',
			'project.config.view',
			'project.config.manage',
			'run.view',
			'run.create',
			'run.reply',
			'run.diff.view',
			'run.approve'
		]);

		expect(projectFindUnique).toHaveBeenCalledWith({
			where: { id: 'project1' },
			select: { id: true, organizationId: true }
		});
		expect(accessGrantFindMany).not.toHaveBeenCalled();
	});

	it('listProjectPermissions returns granted external permissions in registry order', async () => {
		accessGrantFindMany.mockResolvedValue([
			{ permissions: ['run.view', 'project.retired'] },
			{ permissions: ['project.view', 'run.reply'] }
		]);

		await expect(listProjectPermissions(externalActor, 'project1')).resolves.toEqual([
			'project.view',
			'run.view',
			'run.reply'
		]);
	});

	it('listProjectPermissions throws 404 when an external actor lacks project.view', async () => {
		accessGrantFindMany.mockResolvedValue([{ permissions: ['run.view'] }]);

		await expect(listProjectPermissions(externalActor, 'project1')).rejects.toMatchObject({
			status: 404,
			message: 'Project not found'
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
		runFindFirst.mockResolvedValue({ id: 'run1', projectId: 'project1', organizationId: 'org1' });
		projectFindUnique.mockResolvedValue({ organizationId: 'org1' });
		accessGrantFindMany.mockResolvedValue([{ permissions: ['project.view', 'run.view'] }]);
	});

	it('requireRunPermission resolves the run project and requires the project-level permission', async () => {
		await expect(requireRunPermission(externalActor, 'run.view', 'run1')).resolves.toEqual({
			id: 'run1',
			projectId: 'project1',
			organizationId: 'org1'
		});

		expect(runFindFirst).toHaveBeenCalledWith({
			where: { id: 'run1' },
			select: { id: true, projectId: true, organizationId: true }
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

describe('requireInternalOrgAdmin', () => {
	it('passes for internal owners and admins of the organization', () => {
		expect(() => requireInternalOrgAdmin(internalActor, 'org1')).not.toThrow();
		expect(() =>
			requireInternalOrgAdmin(
				{
					userId: 'user_admin',
					internalMemberships: [{ organizationId: 'org1', role: 'admin' }],
					clientMemberships: []
				},
				'org1'
			)
		).not.toThrow();
	});

	it('throws 403 for non-admin members, other orgs, and external clients', () => {
		expect(() => requireInternalOrgAdmin(mixedActor, 'org1')).toThrow();
		expect(() => requireInternalOrgAdmin(internalActor, 'org_other')).toThrow();
		expect(() => requireInternalOrgAdmin(externalActor, 'org1')).toThrow();
	});
});
