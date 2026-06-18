import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { Prisma } from '@prisma/client';
import { buildNativeCdcSkill } from '$lib/domain/cdc-skill';
import { CDC_SKILL_NAME, RUN_MODE, type RunMode } from '$lib/domain/run-mode';
import { git, gitOk } from '$lib/server/git';
import { prisma } from '$lib/server/prisma';
import {
	decryptProjectSecretValue,
	encryptProjectSecretValue
} from '$lib/server/project-agent-config-encryption';
import {
	agentConfigNameSchema,
	envVarKeySchema,
	isSensitiveConfigKey,
	mcpHeaderSecretRefSchema,
	normalizeSkillBody,
	type ProjectEnvVarInput,
	type ProjectMcpServerInput,
	type ProjectSecretInput,
	type ProjectSkillInput
} from '$lib/schemas/project-agent-config';
import { mergeDotenv, parseDotenv } from '$lib/server/dotenv';
import type { SkillsShDownloadedSkill } from '$lib/server/skills-sh-service';

export class ProjectAgentConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectAgentConfigError';
	}
}

export interface RuntimeAgentConfig {
	mcpJson: { mcpServers: Record<string, Record<string, unknown>> };
	settings: { enabledMcpjsonServers: string[] };
	skills: Array<{ name: string; body: string; files: Array<{ path: string; content: string }> }>;
	secretEnv: Record<string, string>;
	envFile: Array<{ key: string; value: string }>;
	snapshot: {
		enabled: boolean;
		mcpServers: Array<{ id: string; name: string; transport: string }>;
		skills: Array<{
			id: string;
			name: string;
			sourceProvider: string | null;
			sourceSkillId: string | null;
			sourceHash: string | null;
		}>;
		envVars: Array<{ key: string }>;
	};
}

type RuntimeMcpServer = RuntimeAgentConfig['mcpJson']['mcpServers'][string];
type EnvRefs = Record<string, { secretName: string }>;
type HeaderRefs = Record<
	string,
	{ secretName: string; prefix?: string | undefined; suffix?: string | undefined }
>;
type ValidatedHttpMcpServer = {
	id: string;
	name: string;
	transport: 'http' | 'sse';
	config: { url: string; headers: Record<string, string>; headerRefs: HeaderRefs };
	env: EnvRefs;
};
type ValidatedStdioMcpServer = {
	id: string;
	name: string;
	transport: 'stdio';
	config: { command: string; args: string[] };
	env: EnvRefs;
};
type ValidatedMcpServer = ValidatedHttpMcpServer | ValidatedStdioMcpServer;

const INTERNAL_MCP_ENV_PREFIX = 'DOTWEAVER_MCP_';
const RESERVED_RUNNER_ENV_NAMES = new Set([
	'RUN_PROMPT',
	'RUN_MODEL',
	'RUN_RESUME_SESSION',
	'CLAUDE_CODE_OAUTH_TOKEN'
]);

async function requireProjectInOrg(organizationId: string, projectId: string) {
	const project = await prisma.project.findFirst({
		where: { id: projectId, organizationId },
		select: { id: true }
	});
	if (!project) throw new ProjectAgentConfigError('Project not found');
	return project;
}

function assertSafeName(name: string): void {
	if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
		throw new ProjectAgentConfigError(`Invalid agent config name: ${name}`);
	}
	const result = agentConfigNameSchema.safeParse(name);
	if (!result.success) {
		throw new ProjectAgentConfigError(`Invalid agent config name: ${name}`);
	}
}

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

function placeholderForEnvName(envName: string): string {
	return `\${${envName}}`;
}

function sanitizeInternalEnvPart(value: string): string {
	return value
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
}

function internalMcpEnvName(serverName: string, envName: string): string {
	const serverPart = sanitizeInternalEnvPart(serverName);
	const envPart = sanitizeInternalEnvPart(envName);
	if (!serverPart || !envPart) {
		throw new ProjectAgentConfigError(`Invalid MCP env reference name for \`${serverName}\``);
	}
	const internalName = `${INTERNAL_MCP_ENV_PREFIX}${serverPart}_${envPart}`;
	if (RESERVED_RUNNER_ENV_NAMES.has(internalName)) {
		throw new ProjectAgentConfigError(
			`MCP env reference collides with reserved env \`${internalName}\``
		);
	}
	return internalName;
}

function internalMcpHeaderEnvName(serverName: string, headerName: string): string {
	const serverPart = sanitizeInternalEnvPart(serverName);
	const headerPart = sanitizeInternalEnvPart(headerName);
	if (!serverPart || !headerPart) {
		throw new ProjectAgentConfigError(`Invalid MCP header reference name for \`${serverName}\``);
	}
	const internalName = `${INTERNAL_MCP_ENV_PREFIX}${serverPart}_HEADER_${headerPart}`;
	if (RESERVED_RUNNER_ENV_NAMES.has(internalName)) {
		throw new ProjectAgentConfigError(
			`MCP header reference collides with reserved env \`${internalName}\``
		);
	}
	return internalName;
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

function assertSafeSkillFilePath(path: string): void {
	if (
		path.length === 0 ||
		path.length > 240 ||
		path.startsWith('/') ||
		path.includes('\\') ||
		path.includes('\0')
	) {
		throw new ProjectAgentConfigError(`Unsafe skill file path: ${path}`);
	}
	const segments = path.split('/');
	if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
		throw new ProjectAgentConfigError(`Unsafe skill file path: ${path}`);
	}
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

export async function upsertProjectEnvVarForOrg(
	organizationId: string,
	createdById: string,
	input: ProjectEnvVarInput
) {
	await requireProjectInOrg(organizationId, input.projectId);
	const key = envVarKeySchema.parse(input.key);
	const sensitive = defaultEnvVarSensitivity(key, input.sensitive);
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
	let imported = 0;
	for (const entry of entries) {
		if (entry.value.length === 0) {
			skipped.push(entry.key);
			continue;
		}
		await upsertProjectEnvVarForOrg(organizationId, createdById, {
			projectId: input.projectId,
			key: entry.key,
			value: entry.value
		});
		imported += 1;
	}
	const rawKeys = input.content
		.split('\n')
		.map((line) => line.trim().replace(/^export /, '').split('=')[0].trim())
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

function asOptionalRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ProjectAgentConfigError(message);
	}
	return value as Record<string, unknown>;
}

function requireString(value: unknown, message: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new ProjectAgentConfigError(message);
	}
	return value;
}

function validateHeaders(
	value: unknown,
	serverName: string
): { headers: Record<string, string>; headerRefs: HeaderRefs } {
	const headers = requireRecord(value, `MCP \`${serverName}\` headers must be an object`);
	const validated: Record<string, string> = {};
	const headerRefs: HeaderRefs = {};
	for (const [key, headerValue] of Object.entries(headers)) {
		if (typeof headerValue === 'string') {
			if (isSensitiveConfigKey(key)) {
				throw new ProjectAgentConfigError(
					`MCP \`${serverName}\` header \`${key}\` must be stored as a project secret`
				);
			}
			validated[key] = headerValue;
			continue;
		}
		const ref = mcpHeaderSecretRefSchema.safeParse(headerValue);
		if (!ref.success) {
			throw new ProjectAgentConfigError(
				`MCP \`${serverName}\` header \`${key}\` must be a string or secret ref`
			);
		}
		headerRefs[key] = ref.data;
	}
	return { headers: validated, headerRefs };
}

function validateEnvSecretRefs(envRefs: unknown, serverName: string): EnvRefs {
	const envRecord = requireRecord(envRefs, `MCP \`${serverName}\` env must be an object`);
	const refs: EnvRefs = {};
	for (const [envName, ref] of Object.entries(envRecord)) {
		if (envName.length === 0) {
			throw new ProjectAgentConfigError(`MCP \`${serverName}\` has an empty env name`);
		}
		const refRecord = requireRecord(ref, `MCP \`${serverName}\` has an invalid secret reference`);
		const secretName = refRecord.secretName;
		if (typeof secretName !== 'string' || secretName.length === 0) {
			throw new ProjectAgentConfigError(`MCP \`${serverName}\` has an invalid secret reference`);
		}
		refs[envName] = { secretName };
	}
	return refs;
}

function validateMcpServerRow(server: {
	id: string;
	name: string;
	transport: string;
	config: unknown;
	env: unknown;
}): ValidatedMcpServer {
	assertSafeName(server.name);
	const config = requireRecord(server.config, `MCP \`${server.name}\` config must be an object`);
	const env = validateEnvSecretRefs(server.env, server.name);

	if (server.transport === 'http' || server.transport === 'sse') {
		const headers = validateHeaders(config.headers, server.name);
		return {
			id: server.id,
			name: server.name,
			transport: server.transport,
			config: {
				url: requireString(config.url, `MCP \`${server.name}\` url must be a string`),
				headers: headers.headers,
				headerRefs: headers.headerRefs
			},
			env
		};
	}
	if (server.transport === 'stdio') {
		return {
			id: server.id,
			name: server.name,
			transport: 'stdio',
			config: {
				command: requireString(config.command, `MCP \`${server.name}\` command must be a string`),
				args: validateStdioArgs(config.args, server.name)
			},
			env
		};
	}
	throw new ProjectAgentConfigError(`MCP \`${server.name}\` has unsupported transport`);
}

function validateStdioArgs(value: unknown, serverName: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((arg) => typeof arg !== 'string')) {
		throw new ProjectAgentConfigError(`MCP \`${serverName}\` args must be an array of strings`);
	}
	return value;
}

function buildMcpJsonServer(
	server: ValidatedMcpServer,
	envPlaceholders: Record<string, string>,
	headerPlaceholders: Record<string, string>
): RuntimeMcpServer {
	if (server.transport === 'stdio') {
		return {
			type: 'stdio',
			command: server.config.command,
			args: server.config.args,
			env: envPlaceholders
		};
	}
	return {
		type: server.transport,
		url: server.config.url,
		headers: { ...server.config.headers, ...headerPlaceholders },
		env: envPlaceholders
	};
}

export async function buildRunAgentConfig(
	organizationId: string,
	projectId: string,
	options: { useProjectAgentConfig: boolean; mode?: RunMode }
): Promise<RuntimeAgentConfig> {
	if (!options.useProjectAgentConfig) {
		return {
			mcpJson: { mcpServers: {} },
			settings: { enabledMcpjsonServers: [] },
			skills: [],
			secretEnv: {},
			envFile: [],
			snapshot: { enabled: false, mcpServers: [], skills: [], envVars: [] }
		};
	}

	await requireProjectInOrg(organizationId, projectId);
	const [mcpServers, skills, secrets, envVars] = await Promise.all([
		prisma.projectMcpServer.findMany({
			where: { organizationId, projectId, enabled: true },
			orderBy: { name: 'asc' }
		}),
		prisma.projectSkill.findMany({
			where: { organizationId, projectId, enabled: true },
			orderBy: { name: 'asc' },
			include: { files: { orderBy: { path: 'asc' } } }
		}),
		prisma.projectSecret.findMany({ where: { organizationId, projectId } }),
		prisma.projectEnvVar.findMany({
			where: { organizationId, projectId, enabled: true },
			orderBy: { key: 'asc' },
			select: { key: true, valueEncrypted: true }
		})
	]);
	const validatedMcpServers = mcpServers.map((server) => validateMcpServerRow(server));
	const secretByName = new Map(secrets.map((secret) => [secret.name, secret]));
	const secretEnv: Record<string, string> = {};
	const internalEnvSources = new Map<string, string>();
	const envPlaceholdersByServer = new Map<string, Record<string, string>>();
	const headerPlaceholdersByServer = new Map<string, Record<string, string>>();

	for (const server of validatedMcpServers) {
		const envPlaceholders: Record<string, string> = {};
		const headerPlaceholders: Record<string, string> = {};
		for (const [envName, ref] of Object.entries(server.env)) {
			const internalEnvName = internalMcpEnvName(server.name, envName);
			const source = `${server.name}.${envName}`;
			const existingSource = internalEnvSources.get(internalEnvName);
			if (existingSource) {
				throw new ProjectAgentConfigError(
					`MCP env reference \`${source}\` collides with \`${existingSource}\``
				);
			}
			const secret = secretByName.get(ref.secretName);
			if (!secret) {
				throw new ProjectAgentConfigError(
					`MCP \`${server.name}\` references missing secret \`${ref.secretName}\``
				);
			}
			internalEnvSources.set(internalEnvName, source);
			envPlaceholders[envName] = placeholderForEnvName(internalEnvName);
			secretEnv[internalEnvName] = decryptProjectSecretValue(secret.valueEncrypted);
		}
		if (server.transport !== 'stdio') {
			for (const [headerName, ref] of Object.entries(server.config.headerRefs)) {
				const internalEnvName = internalMcpHeaderEnvName(server.name, headerName);
				const source = `${server.name}.header.${headerName}`;
				const existingSource = internalEnvSources.get(internalEnvName);
				if (existingSource) {
					throw new ProjectAgentConfigError(
						`MCP secret reference \`${source}\` collides with \`${existingSource}\``
					);
				}
				const secret = secretByName.get(ref.secretName);
				if (!secret) {
					throw new ProjectAgentConfigError(
						`MCP \`${server.name}\` references missing secret \`${ref.secretName}\``
					);
				}
				internalEnvSources.set(internalEnvName, source);
				headerPlaceholders[headerName] =
					`${ref.prefix ?? ''}${placeholderForEnvName(internalEnvName)}${ref.suffix ?? ''}`;
				secretEnv[internalEnvName] = decryptProjectSecretValue(secret.valueEncrypted);
			}
		}
		envPlaceholdersByServer.set(server.name, envPlaceholders);
		headerPlaceholdersByServer.set(server.name, headerPlaceholders);
	}

	const envFile = envVars.map((envVar) => ({
		key: envVar.key,
		value: decryptProjectSecretValue(envVar.valueEncrypted)
	}));

	// CDC runs always get a native cahier-des-charges skill unless the project
	// already defines its own skill with that name (which then takes precedence).
	const includeNativeCdcSkill =
		options.mode === RUN_MODE.CDC && !skills.some((skill) => skill.name === CDC_SKILL_NAME);
	const runtimeSkills = [
		...skills.map((skill) => ({
			name: skill.name,
			body: skill.body,
			files: Array.isArray(skill.files)
				? skill.files.map((file) => ({ path: file.path, content: file.content }))
				: []
		})),
		...(includeNativeCdcSkill ? [buildNativeCdcSkill()] : [])
	];
	const snapshotSkills = [
		...skills.map((skill) => ({
			id: skill.id,
			name: skill.name,
			sourceProvider: skill.sourceProvider ?? null,
			sourceSkillId: skill.sourceSkillId ?? null,
			sourceHash: skill.sourceHash ?? null
		})),
		...(includeNativeCdcSkill
			? [
					{
						id: `native:${CDC_SKILL_NAME}`,
						name: CDC_SKILL_NAME,
						sourceProvider: 'dotweaver-native',
						sourceSkillId: null,
						sourceHash: null
					}
				]
			: [])
	];

	return {
		mcpJson: {
			mcpServers: Object.fromEntries(
				validatedMcpServers.map((server) => [
					server.name,
					buildMcpJsonServer(
						server,
						envPlaceholdersByServer.get(server.name) ?? {},
						headerPlaceholdersByServer.get(server.name) ?? {}
					)
				])
			)
		},
		settings: { enabledMcpjsonServers: validatedMcpServers.map((server) => server.name) },
		skills: runtimeSkills,
		secretEnv,
		envFile,
		snapshot: {
			enabled: true,
			mcpServers: validatedMcpServers.map((server) => ({
				id: server.id,
				name: server.name,
				transport: server.transport
			})),
			skills: snapshotSkills,
			envVars: envVars.map((envVar) => ({ key: envVar.key }))
		}
	};
}

function replaceSecretValues(value: unknown, secretEnv: Record<string, string>): unknown {
	if (typeof value === 'string') {
		let scrubbed = value;
		for (const [envName, secretValue] of Object.entries(secretEnv)) {
			if (secretValue.length > 0) {
				scrubbed = scrubbed.split(secretValue).join(placeholderForEnvName(envName));
			}
		}
		return scrubbed;
	}
	if (Array.isArray(value)) {
		return value.map((item) => replaceSecretValues(item, secretEnv));
	}
	const record = asOptionalRecord(value);
	if (Object.keys(record).length > 0) {
		return Object.fromEntries(
			Object.entries(record).map(([key, item]) => [key, replaceSecretValues(item, secretEnv)])
		);
	}
	return value;
}

function scrubMcpJsonSecrets(
	config: RuntimeAgentConfig['mcpJson'],
	secretEnv: RuntimeAgentConfig['secretEnv']
): RuntimeAgentConfig['mcpJson'] {
	return replaceSecretValues(config, secretEnv) as RuntimeAgentConfig['mcpJson'];
}

export async function materializeRunAgentConfig(
	checkoutPath: string,
	config: RuntimeAgentConfig
): Promise<void> {
	const claudeDir = join(checkoutPath, '.claude');
	const generatedPaths = ['.mcp.json', '.claude/settings.json'];
	await mkdir(claudeDir, { recursive: true });
	await writeFile(
		join(checkoutPath, '.mcp.json'),
		`${JSON.stringify(scrubMcpJsonSecrets(config.mcpJson, config.secretEnv), null, 2)}\n`
	);
	await writeFile(
		join(claudeDir, 'settings.json'),
		`${JSON.stringify(config.settings, null, 2)}\n`
	);

	for (const skill of config.skills) {
		assertSafeName(skill.name);
		generatedPaths.push(`.claude/skills/${skill.name}/SKILL.md`);
		const skillDir = join(claudeDir, 'skills', skill.name);
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			join(skillDir, 'SKILL.md'),
			skill.body.endsWith('\n') ? skill.body : `${skill.body}\n`
		);
		for (const file of skill.files ?? []) {
			assertSafeSkillFilePath(file.path);
			generatedPaths.push(`.claude/skills/${skill.name}/${file.path}`);
			const filePath = join(skillDir, file.path);
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, file.content);
		}
	}

	if (config.envFile.length > 0) {
		const envPath = join(checkoutPath, '.env');
		let existing = '';
		try {
			existing = await readFile(envPath, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		}
		await writeFile(envPath, mergeDotenv(existing, config.envFile));
		generatedPaths.push('.env');
	}

	await protectGeneratedAgentConfigFiles(checkoutPath, generatedPaths);
}

async function protectGeneratedAgentConfigFiles(
	checkoutPath: string,
	relativePaths: string[]
): Promise<void> {
	const gitWorkTree = await git(['rev-parse', '--is-inside-work-tree'], {
		cwd: checkoutPath,
		env: process.env
	});
	if (gitWorkTree.code !== 0 || gitWorkTree.stdout.trim() !== 'true') return;

	const gitExclude = await gitOk(['rev-parse', '--git-path', 'info/exclude'], {
		cwd: checkoutPath,
		env: process.env
	});
	const gitExcludePath = isAbsolute(gitExclude) ? gitExclude : join(checkoutPath, gitExclude);

	const uniquePaths = [...new Set(relativePaths)];
	await mkdir(dirname(gitExcludePath), { recursive: true });
	await appendFile(
		gitExcludePath,
		`\n# dotWeaver generated Claude Code config\n${uniquePaths.join('\n')}\n`
	);

	const trackedPaths: string[] = [];
	for (const relativePath of uniquePaths) {
		const result = await git(['ls-files', '--error-unmatch', '--', relativePath], {
			cwd: checkoutPath,
			env: process.env
		});
		if (result.code === 0) trackedPaths.push(relativePath);
	}

	if (trackedPaths.length > 0) {
		await gitOk(['update-index', '--skip-worktree', '--', ...trackedPaths], {
			cwd: checkoutPath,
			env: process.env
		});
	}
}
