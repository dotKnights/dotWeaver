import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '$lib/server/prisma';
import {
	PROJECT_ENVIRONMENT_SERVICE_KINDS,
	type ProjectEnvironmentServiceKind
} from '$lib/domain/project-environment-service';
import {
	decryptProjectSecretValue,
	encryptProjectSecretValue
} from '$lib/server/project-agent-config/encryption';
import { defaultServiceEnvMappings } from '$lib/server/project-environment-services/env-mapping';
import {
	envVarKeySchema,
	isSensitiveConfigKey,
	normalizeSkillBody,
	type ProjectEnvVarInput,
	type ProjectMcpServerInput,
	type ProjectSecretInput,
	type ProjectSkillInput
} from '$lib/schemas/project-agent-config';
import { parseDotenv } from '$lib/server/runtime/dotenv';
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
export { buildRunAgentConfig } from '$lib/server/project-agent-config/runtime-builder';
const PROJECT_ENVIRONMENT_SERVICE_KIND_SET = new Set<string>(PROJECT_ENVIRONMENT_SERVICE_KINDS);

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

function defaultEnvVarSensitivity(key: string, explicit: boolean | undefined): boolean {
	return explicit ?? isSensitiveConfigKey(key);
}

function isProjectEnvironmentServiceKind(value: unknown): value is ProjectEnvironmentServiceKind {
	return typeof value === 'string' && PROJECT_ENVIRONMENT_SERVICE_KIND_SET.has(value);
}

function asOptionalRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function enabledServiceEnvMappingKeys(config: unknown): string[] | null {
	const record = asOptionalRecord(config);
	const mappings = record.envMappings;
	if (!Array.isArray(mappings)) return null;
	const keys: string[] = [];
	for (const mapping of mappings) {
		if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) continue;
		const record = mapping as Record<string, unknown>;
		if (record.enabled === false || typeof record.key !== 'string') continue;
		keys.push(record.key);
	}
	return keys;
}

async function serviceManagedEnvKeysForProject(
	organizationId: string,
	projectId: string
): Promise<Map<string, { serviceName: string; serviceKind: ProjectEnvironmentServiceKind }>> {
	const services = await prisma.projectEnvironmentService.findMany({
		where: {
			organizationId,
			projectId,
			enabled: true,
			status: { not: 'disabled' }
		},
		orderBy: [{ kind: 'asc' }, { name: 'asc' }],
		select: { kind: true, name: true, config: true }
	});
	const reserved = new Map<
		string,
		{ serviceName: string; serviceKind: ProjectEnvironmentServiceKind }
	>();
	for (const service of services) {
		if (!isProjectEnvironmentServiceKind(service.kind)) continue;
		const keys =
			enabledServiceEnvMappingKeys(service.config) ??
			defaultServiceEnvMappings(service.kind).map((mapping) => mapping.key);
		for (const key of keys) {
			if (!reserved.has(key)) {
				reserved.set(key, { serviceName: service.name, serviceKind: service.kind });
			}
		}
	}
	return reserved;
}

async function assertProjectEnvKeysDoNotOverrideServices(
	organizationId: string,
	projectId: string,
	keys: string[]
): Promise<void> {
	const reserved = await serviceManagedEnvKeysForProject(organizationId, projectId);
	for (const key of keys) {
		const source = reserved.get(key);
		if (!source) continue;
		throw new ProjectAgentConfigError(
			`${key} is managed by the ${source.serviceName} service. Rename or disable that service mapping before adding a project env var with the same key.`
		);
	}
}

async function writeProjectEnvVarForOrg(
	organizationId: string,
	createdById: string,
	input: ProjectEnvVarInput,
	key: string,
	sensitive: boolean
) {
	return prisma.projectEnvVar.upsert({
		where: { projectId_key: { projectId: input.projectId, key } },
		create: {
			projectId: input.projectId,
			organizationId,
			key,
			valueEncrypted: encryptProjectSecretValue(input.value),
			sensitive,
			createdById
		},
		update: {
			valueEncrypted: encryptProjectSecretValue(input.value),
			sensitive
		}
	});
}

export async function upsertProjectEnvVarForOrg(
	organizationId: string,
	createdById: string,
	input: ProjectEnvVarInput
) {
	await requireProjectInOrg(organizationId, input.projectId);
	const key = envVarKeySchema.parse(input.key);
	const sensitive = defaultEnvVarSensitivity(key, input.sensitive);
	await assertProjectEnvKeysDoNotOverrideServices(organizationId, input.projectId, [key]);
	return writeProjectEnvVarForOrg(organizationId, createdById, input, key, sensitive);
}

export async function setProjectEnvVarSensitiveForOrg(
	organizationId: string,
	input: { projectId: string; id: string; sensitive: boolean }
) {
	const result = await prisma.projectEnvVar.updateMany({
		where: { id: input.id, projectId: input.projectId, organizationId },
		data: { sensitive: input.sensitive }
	});
	if (result.count === 0) throw new ProjectAgentConfigError('Env var not found');
}

export async function revealProjectEnvVarForOrg(
	organizationId: string,
	input: { projectId: string; id: string }
): Promise<string> {
	const envVar = await prisma.projectEnvVar.findFirst({
		where: { id: input.id, projectId: input.projectId, organizationId },
		select: { valueEncrypted: true }
	});
	if (!envVar) throw new ProjectAgentConfigError('Env var not found');
	return decryptProjectSecretValue(envVar.valueEncrypted);
}

export async function importProjectEnvFileForOrg(
	organizationId: string,
	createdById: string,
	input: { projectId: string; content: string }
): Promise<{ imported: number; skipped: string[] }> {
	await requireProjectInOrg(organizationId, input.projectId);
	const entries = parseDotenv(input.content);
	const skipped: string[] = [];
	const importableEntries = entries.filter((entry) => entry.value.length > 0);
	await assertProjectEnvKeysDoNotOverrideServices(
		organizationId,
		input.projectId,
		importableEntries.map((entry) => entry.key)
	);
	let imported = 0;
	for (const entry of entries) {
		if (entry.value.length === 0) {
			skipped.push(entry.key);
			continue;
		}
		const key = envVarKeySchema.parse(entry.key);
		await writeProjectEnvVarForOrg(
			organizationId,
			createdById,
			{ projectId: input.projectId, key, value: entry.value },
			key,
			defaultEnvVarSensitivity(key, undefined)
		);
		imported += 1;
	}
	const rawKeys = input.content
		.split('\n')
		.map((line) =>
			line
				.trim()
				.replace(/^export /, '')
				.split('=')[0]
				.trim()
		)
		.filter((key) => key.length > 0 && !key.startsWith('#'));
	for (const key of rawKeys) {
		if (!entries.some((entry) => entry.key === key) && !skipped.includes(key)) skipped.push(key);
	}
	return { imported, skipped };
}

function isPrismaUniqueConstraintError(e: unknown): boolean {
	return (
		typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002'
	);
}
