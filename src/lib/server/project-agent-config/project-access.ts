import { ProjectAgentConfigError } from '$lib/server/project-agent-config/errors';
import { prisma } from '$lib/server/prisma';

export async function requireProjectInOrg(organizationId: string, projectId: string) {
	const project = await prisma.project.findFirst({
		where: { id: projectId, organizationId },
		select: { id: true }
	});
	if (!project) throw new ProjectAgentConfigError('Project not found');
	return project;
}
