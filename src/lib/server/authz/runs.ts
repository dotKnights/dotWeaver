import { error } from '@sveltejs/kit';
import type { Permission } from '$lib/authz/permissions';
import { projectResource } from '$lib/authz/resources';
import type { AuthzActor } from '$lib/server/authz/actor';
import { can, requirePermission } from '$lib/server/authz/service';
import { prisma } from '$lib/server/prisma';

export async function requireRunPermission(
	actor: AuthzActor,
	permission: Permission,
	runId: string
) {
	const run = await prisma.run.findFirst({
		where: { id: runId },
		select: { id: true, projectId: true, organizationId: true }
	});
	if (!run) error(404, 'Run not found');

	const resource = projectResource(run.projectId);
	if (!(await can(actor, 'project.view', resource))) {
		error(404, 'Run not found');
	}

	await requirePermission(actor, permission, resource);
	return run;
}
