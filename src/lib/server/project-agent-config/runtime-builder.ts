import type { ProjectMcpServer } from '@prisma/client';
import { isSensitiveConfigKey, mcpHeaderSecretRefSchema } from '$lib/schemas/project-agent-config';
import { decryptProjectSecretValue } from '$lib/server/project-agent-config/encryption';
import { ProjectAgentConfigError } from '$lib/server/project-agent-config/errors';
import { requireProjectInOrg } from '$lib/server/project-agent-config/project-access';
import type {
	RuntimeAgentConfig,
	RuntimeMcpServer
} from '$lib/server/project-agent-config/runtime-types';
import { assertSafeName } from '$lib/server/project-agent-config/validation';
import { prisma } from '$lib/server/prisma';

type EnvRefs = Record<string, { secretName: string }>;
type HeaderRefs = Record<
	string,
	{ secretName: string; prefix?: string | undefined; suffix?: string | undefined }
>;
type ValidatedMcpServerBase = Pick<ProjectMcpServer, 'id' | 'name'> & {
	env: EnvRefs;
};
type ValidatedHttpMcpServer = ValidatedMcpServerBase & {
	transport: Extract<ProjectMcpServer['transport'], 'http' | 'sse'>;
	config: { url: string; headers: Record<string, string>; headerRefs: HeaderRefs };
};
type ValidatedStdioMcpServer = ValidatedMcpServerBase & {
	transport: Extract<ProjectMcpServer['transport'], 'stdio'>;
	config: { command: string; args: string[] };
};
type ValidatedMcpServer = ValidatedHttpMcpServer | ValidatedStdioMcpServer;

const INTERNAL_MCP_ENV_PREFIX = 'DOTWEAVER_MCP_';
const RESERVED_RUNNER_ENV_NAMES = new Set([
	'RUN_PROMPT',
	'RUN_MODEL',
	'RUN_RESUME_SESSION',
	'CLAUDE_CODE_OAUTH_TOKEN'
]);

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
		skills: skills.map((skill) => ({
			name: skill.name,
			body: skill.body,
			files: Array.isArray(skill.files)
				? skill.files.map((file) => ({ path: file.path, content: file.content }))
				: []
		})),
		secretEnv,
		envFile,
		snapshot: {
			enabled: true,
			mcpServers: validatedMcpServers.map((server) => ({
				id: server.id,
				name: server.name,
				transport: server.transport
			})),
			skills: skills.map((skill) => ({
				id: skill.id,
				name: skill.name,
				sourceProvider: skill.sourceProvider ?? null,
				sourceSkillId: skill.sourceSkillId ?? null,
				sourceHash: skill.sourceHash ?? null
			})),
			envVars: envVars.map((envVar) => ({ key: envVar.key }))
		}
	};
}
