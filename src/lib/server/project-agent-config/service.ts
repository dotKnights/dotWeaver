import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '$lib/server/prisma';
import {
	normalizeSkillBody,
	type ProjectMcpServerInput,
	type ProjectSkillInput
} from '$lib/schemas/project-agent-config';
import { ProjectAgentConfigError } from '$lib/server/project-agent-config/errors';
import { requireProjectInOrg } from '$lib/server/project-agent-config/project-access';
import {
	assertSafeName,
	assertSafeSkillFilePath
} from '$lib/server/project-agent-config/validation';
import type { SkillsShDownloadedSkill } from '$lib/server/integrations/skills-sh/service';

export { ProjectAgentConfigError } from '$lib/server/project-agent-config/errors';
export {
	materializeProjectEnvFile,
	materializeRunAgentConfig
} from '$lib/server/project-agent-config/materialization';
export {
	importProjectEnvFileForOrg,
	revealProjectEnvVarForOrg,
	setProjectEnvVarSensitiveForOrg,
	upsertProjectEnvVarForOrg
} from '$lib/server/project-agent-config/env-vars';
export { listProjectAgentConfigForOrg } from '$lib/server/project-agent-config/overview';
export { buildRunAgentConfig } from '$lib/server/project-agent-config/runtime-builder';
export {
	createProjectSecretForOrg,
	upsertProjectSecretForOrg
} from '$lib/server/project-agent-config/secrets';

function mcpConfigForInput(input: ProjectMcpServerInput): Record<string, unknown> {
	if (input.transport === 'stdio') {
		return { command: input.command, args: input.args };
	}
	return { url: input.url, headers: input.headers };
}

function asPrismaJson(value: unknown): Prisma.InputJsonValue {
	return value as Prisma.InputJsonValue;
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
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

export async function upsertProjectSkillForOrg(organizationId: string, input: ProjectSkillInput) {
	await requireProjectInOrg(organizationId, input.projectId);
	assertSafeName(input.name);
	const body = normalizeSkillBody({
		name: input.name,
		description: input.description,
		body: input.body
	});
	return prisma.projectSkill.upsert({
		where: { projectId_name: { projectId: input.projectId, name: input.name } },
		create: {
			projectId: input.projectId,
			organizationId,
			name: input.name,
			enabled: input.enabled,
			description: input.description,
			body,
			source: 'manual'
		},
		update: {
			enabled: input.enabled,
			description: input.description,
			body
		}
	});
}

function sourceMetadataForSkill(skill: SkillsShDownloadedSkill): Prisma.InputJsonValue {
	return asPrismaJson({
		installs: skill.installs ?? null,
		sourceType: skill.sourceType ?? null,
		installUrl: skill.installUrl ?? null
	});
}

function importedSkillData(
	organizationId: string,
	projectId: string,
	skill: SkillsShDownloadedSkill
): Prisma.ProjectSkillUncheckedCreateInput {
	return {
		projectId,
		organizationId,
		name: skill.name,
		enabled: true,
		description: skill.description,
		body: skill.body,
		source: 'imported',
		sourceProvider: 'skills.sh',
		sourcePackage: skill.source,
		sourceSkillId: skill.id,
		sourceUrl: skill.url ?? null,
		sourceHash: skill.hash,
		sourceMetadata: sourceMetadataForSkill(skill),
		importedAt: new Date()
	};
}

function skillFileRows(projectSkillId: string, skill: SkillsShDownloadedSkill) {
	return skill.files.map((file) => {
		assertSafeSkillFilePath(file.path);
		return {
			projectSkillId,
			path: file.path,
			content: file.content,
			contentHash: sha256(file.content)
		};
	});
}

export async function importSkillsShSkillForOrg(
	organizationId: string,
	projectId: string,
	skill: SkillsShDownloadedSkill,
	options: { replace: boolean }
) {
	await requireProjectInOrg(organizationId, projectId);
	assertSafeName(skill.name);
	for (const file of skill.files) assertSafeSkillFilePath(file.path);

	return await prisma.$transaction(async (tx) => {
		const existing = await tx.projectSkill.findFirst({
			where: { organizationId, projectId, name: skill.name },
			select: { id: true, name: true }
		});
		if (existing && !options.replace) {
			throw new ProjectAgentConfigError(`Project skill \`${skill.name}\` already exists`);
		}

		if (existing) {
			const updated = await tx.projectSkill.update({
				where: { id: existing.id },
				data: importedSkillData(organizationId, projectId, skill)
			});
			await tx.projectSkillFile.deleteMany({ where: { projectSkillId: existing.id } });
			const rows = skillFileRows(existing.id, skill);
			if (rows.length > 0) await tx.projectSkillFile.createMany({ data: rows });
			return updated;
		}

		const created = await tx.projectSkill.create({
			data: importedSkillData(organizationId, projectId, skill)
		});
		const rows = skillFileRows(created.id, skill);
		if (rows.length > 0) await tx.projectSkillFile.createMany({ data: rows });
		return created;
	});
}
