import { error } from '@sveltejs/kit';
import type { Permission, PermissionKey } from '$lib/authz/permissions';
import { isPermission } from '$lib/authz/permissions';
import type { AuthzResource } from '$lib/authz/resources';
import type { AuthzActor, ClientMembership } from '$lib/server/authz/actor';
import { prisma } from '$lib/server/prisma';

type ProjectOwner = {
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

function hasInternalMembership(actor: AuthzActor, organizationId: string): boolean {
	return actor.internalMemberships.some(
		(membership) => membership.organizationId === organizationId
	);
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

export async function can(
	actor: AuthzActor,
	permission: Permission,
	resource: AuthzResource
): Promise<boolean> {
	const owner = await resolveResourceOwner(resource);
	if (!owner) return false;

	if (hasInternalMembership(actor, owner.organizationId)) {
		return true;
	}

	const clientMemberships = clientMembershipsForOrg(actor, owner.organizationId);
	if (clientMemberships.length === 0) {
		return false;
	}

	const scope = subjectScopeForMemberships(clientMemberships);
	const grants = await prisma.accessGrant.findMany({
		where: {
			organizationId: owner.organizationId,
			resourceType: resource.type,
			resourceId: resource.id,
			OR: grantSubjectWhere(scope)
		},
		select: { permissions: true }
	});

	return collectValidPermissions(grants).has(permission);
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
