import { error } from '@sveltejs/kit';
import type { Permission, PermissionKey } from '$lib/authz/permissions';
import { isPermission, permissionRegistry } from '$lib/authz/permissions';
import type { AuthzResource } from '$lib/authz/resources';
import type { AuthzActor, ClientMembership } from '$lib/server/authz/actor';
import { prisma } from '$lib/server/prisma';

type ProjectOwner = {
	organizationId: string;
};

type ProjectContext = {
	id: string;
	organizationId: string;
};

type SubjectScope = {
	organizationIds: string[];
	clientOrganizationIds: string[];
	clientMemberIds: string[];
};

async function resolveResourceOwner(resource: AuthzResource): Promise<ProjectOwner | null> {
	if (resource.type !== 'project') return null;

	return prisma.project.findUnique({
		where: { id: resource.id },
		select: { organizationId: true }
	});
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
	const seen = new Set<string>();
	const uniqueValues: T[] = [];

	for (const value of values) {
		if (seen.has(value.id)) continue;

		seen.add(value.id);
		uniqueValues.push(value);
	}

	return uniqueValues;
}

const INTERNAL_ADMIN_ROLES = new Set(['owner', 'admin']);

function hasInternalMembership(actor: AuthzActor, organizationId: string): boolean {
	return actor.internalMemberships.some(
		(membership) => membership.organizationId === organizationId
	);
}

function hasInternalAdminRole(actor: AuthzActor, organizationId: string): boolean {
	return actor.internalMemberships.some(
		(membership) =>
			membership.organizationId === organizationId && INTERNAL_ADMIN_ROLES.has(membership.role)
	);
}

/**
 * Managing who else can access a resource is an administrative action: only internal
 * owners/admins qualify. Throws 403 otherwise. Used for org-level client management where
 * there is no project resource to check `project.manage_access` against.
 */
export function requireInternalOrgAdmin(actor: AuthzActor, organizationId: string): void {
	if (!hasInternalAdminRole(actor, organizationId)) error(403, 'Forbidden');
}

function clientMembershipsForOrg(actor: AuthzActor, organizationId: string): ClientMembership[] {
	return actor.clientMemberships.filter(
		(membership) => membership.organizationId === organizationId
	);
}

function subjectScopeForMemberships(memberships: ClientMembership[]): SubjectScope {
	return {
		organizationIds: unique(memberships.map((membership) => membership.organizationId)),
		clientOrganizationIds: unique(memberships.map((membership) => membership.clientOrganizationId)),
		clientMemberIds: unique(memberships.map((membership) => membership.id))
	};
}

function grantSubjectWhere(scope: SubjectScope) {
	return [
		{ subjectType: 'client_organization' as const, subjectId: { in: scope.clientOrganizationIds } },
		{ subjectType: 'client_member' as const, subjectId: { in: scope.clientMemberIds } }
	];
}

function collectValidPermissions(grants: Array<{ permissions: string[] }>): Set<PermissionKey> {
	const permissions = new Set<PermissionKey>();

	for (const grant of grants) {
		for (const permission of grant.permissions) {
			if (isPermission(permission)) permissions.add(permission);
		}
	}

	return permissions;
}

async function canAccessProjectWithOwner(
	actor: AuthzActor,
	permission: Permission,
	project: ProjectContext
): Promise<boolean> {
	if (hasInternalMembership(actor, project.organizationId)) {
		// Internal members keep full access to functional permissions, but managing who else
		// can access a project is reserved for internal owners/admins.
		if (permission === 'project.manage_access') {
			return hasInternalAdminRole(actor, project.organizationId);
		}
		return true;
	}

	const clientMemberships = clientMembershipsForOrg(actor, project.organizationId);
	if (clientMemberships.length === 0) {
		return false;
	}

	const scope = subjectScopeForMemberships(clientMemberships);
	const grants = await prisma.accessGrant.findMany({
		where: {
			organizationId: project.organizationId,
			resourceType: 'project',
			resourceId: project.id,
			OR: grantSubjectWhere(scope)
		},
		select: { permissions: true }
	});

	return collectValidPermissions(grants).has(permission);
}

export async function can(
	actor: AuthzActor,
	permission: Permission,
	resource: AuthzResource
): Promise<boolean> {
	const owner = await resolveResourceOwner(resource);
	if (!owner) return false;
	return canAccessProjectWithOwner(actor, permission, {
		id: resource.id,
		organizationId: owner.organizationId
	});
}

export async function requirePermission(
	actor: AuthzActor,
	permission: Permission,
	resource: AuthzResource
): Promise<void> {
	if (!(await can(actor, permission, resource))) {
		error(403, 'Forbidden');
	}
}

export async function requireProjectPermission(
	actor: AuthzActor,
	permission: Permission,
	projectId: string
): Promise<{ id: string; organizationId: string }> {
	const project = await prisma.project.findUnique({
		where: { id: projectId },
		select: { id: true, organizationId: true }
	});
	if (!project) error(404, 'Project not found');

	if (!(await canAccessProjectWithOwner(actor, 'project.view', project))) {
		error(404, 'Project not found');
	}
	if (
		permission !== 'project.view' &&
		!(await canAccessProjectWithOwner(actor, permission, project))
	) {
		error(403, 'Forbidden');
	}
	return project;
}

export async function listProjectPermissions(
	actor: AuthzActor,
	projectId: string
): Promise<PermissionKey[]> {
	const project = await prisma.project.findUnique({
		where: { id: projectId },
		select: { id: true, organizationId: true }
	});
	if (!project) error(404, 'Project not found');

	if (hasInternalMembership(actor, project.organizationId)) {
		const isAdmin = hasInternalAdminRole(actor, project.organizationId);
		return permissionRegistry.permissions
			.map((permission) => permission.key)
			.filter((permission) => isAdmin || permission !== 'project.manage_access');
	}

	const clientMemberships = clientMembershipsForOrg(actor, project.organizationId);
	if (clientMemberships.length === 0) {
		error(404, 'Project not found');
	}

	const scope = subjectScopeForMemberships(clientMemberships);
	const grants = await prisma.accessGrant.findMany({
		where: {
			organizationId: project.organizationId,
			resourceType: 'project',
			resourceId: project.id,
			OR: grantSubjectWhere(scope)
		},
		select: { permissions: true }
	});
	const permissions = collectValidPermissions(grants);

	if (!permissions.has('project.view')) {
		error(404, 'Project not found');
	}

	return permissionRegistry.permissions
		.map((permission) => permission.key)
		.filter((permission) => permissions.has(permission));
}

export async function listAccessibleProjects(actor: AuthzActor) {
	const internalOrganizationIds = unique(
		actor.internalMemberships.map((membership) => membership.organizationId)
	);

	const internalProjects =
		internalOrganizationIds.length > 0
			? await prisma.project.findMany({
					where: { organizationId: { in: internalOrganizationIds } },
					orderBy: { createdAt: 'desc' }
				})
			: [];

	const scope = subjectScopeForMemberships(actor.clientMemberships);
	if (
		scope.organizationIds.length === 0 ||
		(scope.clientOrganizationIds.length === 0 && scope.clientMemberIds.length === 0)
	) {
		return internalProjects;
	}

	const grants = await prisma.accessGrant.findMany({
		where: {
			organizationId: { in: scope.organizationIds },
			resourceType: 'project',
			permissions: { has: 'project.view' },
			OR: grantSubjectWhere(scope)
		},
		select: { resourceId: true }
	});
	const projectIds = unique(grants.map((grant) => grant.resourceId));

	if (projectIds.length === 0) return internalProjects;

	const externalProjects = await prisma.project.findMany({
		where: {
			organizationId: { in: scope.organizationIds },
			id: { in: projectIds }
		},
		orderBy: { createdAt: 'desc' }
	});

	return uniqueById([...internalProjects, ...externalProjects]);
}
