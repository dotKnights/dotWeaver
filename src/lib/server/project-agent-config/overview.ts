import { decryptProjectSecretValue } from '$lib/server/project-agent-config/encryption';
import { requireProjectInOrg } from '$lib/server/project-agent-config/project-access';
import { prisma } from '$lib/server/prisma';

export async function listProjectAgentConfigForOrg(organizationId: string, projectId: string) {
	await requireProjectInOrg(organizationId, projectId);
	const [mcpServers, skills, secrets, envVars] = await Promise.all([
		prisma.projectMcpServer.findMany({
			where: { organizationId, projectId },
			orderBy: { name: 'asc' }
		}),
		prisma.projectSkill.findMany({
			where: { organizationId, projectId },
			orderBy: { name: 'asc' }
		}),
		prisma.projectSecret.findMany({
			where: { organizationId, projectId },
			orderBy: { name: 'asc' },
			select: { id: true, name: true }
		}),
		prisma.projectEnvVar.findMany({
			where: { organizationId, projectId },
			orderBy: { key: 'asc' },
			select: { id: true, key: true, enabled: true, sensitive: true, valueEncrypted: true }
		})
	]);

	return {
		mcpServers,
		skills,
		secrets: secrets.map((secret) => ({
			id: secret.id,
			name: secret.name,
			hasValue: true
		})),
		envVars: envVars.map((envVar) => ({
			id: envVar.id,
			key: envVar.key,
			enabled: envVar.enabled,
			sensitive: envVar.sensitive,
			value: envVar.sensitive ? null : decryptProjectSecretValue(envVar.valueEncrypted)
		}))
	};
}
