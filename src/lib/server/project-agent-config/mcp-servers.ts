import type { ProjectMcpServerInput } from '$lib/schemas/project-agent-config';
import { requireProjectInOrg } from '$lib/server/project-agent-config/project-access';
import { asPrismaJson } from '$lib/server/project-agent-config/prisma-json';
import { assertSafeName } from '$lib/server/project-agent-config/validation';
import { prisma } from '$lib/server/prisma';

function mcpConfigForInput(input: ProjectMcpServerInput): Record<string, unknown> {
	if (input.transport === 'stdio') {
		return { command: input.command, args: input.args };
	}
	return { url: input.url, headers: input.headers };
}

export async function upsertProjectMcpServerForOrg(
	organizationId: string,
	input: ProjectMcpServerInput
) {
	await requireProjectInOrg(organizationId, input.projectId);
	assertSafeName(input.name);
	const config = mcpConfigForInput(input);
	return prisma.projectMcpServer.upsert({
		where: { projectId_name: { projectId: input.projectId, name: input.name } },
		create: {
			projectId: input.projectId,
			organizationId,
			name: input.name,
			transport: input.transport,
			enabled: input.enabled,
			config: asPrismaJson(config),
			env: asPrismaJson(input.env)
		},
		update: {
			transport: input.transport,
			enabled: input.enabled,
			config: asPrismaJson(config),
			env: asPrismaJson(input.env)
		}
	});
}
