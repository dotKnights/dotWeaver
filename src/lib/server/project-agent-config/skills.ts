import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { normalizeSkillBody, type ProjectSkillInput } from '$lib/schemas/project-agent-config';
import type { SkillsShDownloadedSkill } from '$lib/server/integrations/skills-sh/service';
import { ProjectAgentConfigError } from '$lib/server/project-agent-config/errors';
import { requireProjectInOrg } from '$lib/server/project-agent-config/project-access';
import { asPrismaJson } from '$lib/server/project-agent-config/prisma-json';
import {
	assertSafeName,
	assertSafeSkillFilePath
} from '$lib/server/project-agent-config/validation';
import { prisma } from '$lib/server/prisma';

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
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
