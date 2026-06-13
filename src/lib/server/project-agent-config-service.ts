import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { Prisma } from '@prisma/client';
import { git, gitOk } from '$lib/server/git';
import { prisma } from '$lib/server/prisma';
import {
	decryptProjectSecretValue,
	encryptProjectSecretValue
} from '$lib/server/project-agent-config-encryption';
import {
	agentConfigNameSchema,
	isSensitiveConfigKey,
	mcpHeaderSecretRefSchema,
	normalizeSkillBody,
	type ProjectMcpServerInput,
	type ProjectSecretInput,
	type ProjectSkillInput
} from '$lib/schemas/project-agent-config';

export class ProjectAgentConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectAgentConfigError';
	}
}

export interface RuntimeAgentConfig {
	mcpJson: { mcpServers: Record<string, Record<string, unknown>> };
	settings: { enabledMcpjsonServers: string[] };
	skills: Array<{ name: string; body: string }>;
	secretEnv: Record<string, string>;
	snapshot: {
		enabled: boolean;
		mcpServers: Array<{ id: string; name: string; transport: string }>;
		skills: Array<{ id: string; name: string }>;
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
	const [mcpServers, skills, secrets] = await Promise.all([
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
		})
	]);

	return {
		mcpServers,
		skills,
		secrets: secrets.map((secret) => ({
			id: secret.id,
			name: secret.name,
			hasValue: true
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
	options: { useProjectAgentConfig: boolean }
): Promise<RuntimeAgentConfig> {
	if (!options.useProjectAgentConfig) {
		return {
			mcpJson: { mcpServers: {} },
			settings: { enabledMcpjsonServers: [] },
			skills: [],
			secretEnv: {},
			snapshot: { enabled: false, mcpServers: [], skills: [] }
		};
	}

	await requireProjectInOrg(organizationId, projectId);
	const [mcpServers, skills, secrets] = await Promise.all([
		prisma.projectMcpServer.findMany({
			where: { organizationId, projectId, enabled: true },
			orderBy: { name: 'asc' }
		}),
		prisma.projectSkill.findMany({
			where: { organizationId, projectId, enabled: true },
			orderBy: { name: 'asc' }
		}),
		prisma.projectSecret.findMany({ where: { organizationId, projectId } })
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
		skills: skills.map((skill) => ({ name: skill.name, body: skill.body })),
		secretEnv,
		snapshot: {
			enabled: true,
			mcpServers: validatedMcpServers.map((server) => ({
				id: server.id,
				name: server.name,
				transport: server.transport
			})),
			skills: skills.map((skill) => ({ id: skill.id, name: skill.name }))
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
