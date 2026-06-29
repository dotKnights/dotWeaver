import type { ProjectSecretInput } from '$lib/schemas/project-agent-config';
import { encryptProjectSecretValue } from '$lib/server/project-agent-config/encryption';
import { ProjectAgentConfigError } from '$lib/server/project-agent-config/errors';
import { requireProjectInOrg } from '$lib/server/project-agent-config/project-access';
import { assertSafeName } from '$lib/server/project-agent-config/validation';
import { prisma } from '$lib/server/prisma';

export async function upsertProjectSecretForOrg(
	organizationId: string,
	createdById: string,
	input: ProjectSecretInput
) {
	await requireProjectInOrg(organizationId, input.projectId);
	assertSafeName(input.name);
	return prisma.projectSecret.upsert({
		where: { projectId_name: { projectId: input.projectId, name: input.name } },
		create: {
			projectId: input.projectId,
			organizationId,
			name: input.name,
			valueEncrypted: encryptProjectSecretValue(input.value),
			createdById
		},
		update: {
			valueEncrypted: encryptProjectSecretValue(input.value)
		}
	});
}

export async function createProjectSecretForOrg(
	organizationId: string,
	createdById: string,
	input: ProjectSecretInput
) {
	await requireProjectInOrg(organizationId, input.projectId);
	assertSafeName(input.name);
	try {
		return await prisma.projectSecret.create({
			data: {
				projectId: input.projectId,
				organizationId,
				name: input.name,
				valueEncrypted: encryptProjectSecretValue(input.value),
				createdById
			}
		});
	} catch (e) {
		if (isPrismaUniqueConstraintError(e)) {
			throw new ProjectAgentConfigError(`Project secret \`${input.name}\` already exists`);
		}
		throw e;
	}
}

function isPrismaUniqueConstraintError(e: unknown): boolean {
	return (
		typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002'
	);
}
