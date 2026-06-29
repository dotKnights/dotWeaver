import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import {
	agentConfigNameSchema,
	importProjectEnvFileSchema,
	importProjectMcpJsonSchema,
	importProjectSkillMarkdownSchema,
	importSkillsShSkillSchema,
	isSensitiveConfigKey,
	projectConfigEnabledSchema,
	projectConfigIdSchema,
	projectEnvVarInputSchema,
	projectMcpServerInputSchema,
	projectSecretInputSchema,
	projectSkillInputSchema,
	setProjectEnvVarSensitiveSchema,
	skillsShSearchSchema,
	skillsShSkillIdSchema,
	type ProjectMcpServerInput
} from '$lib/schemas/project-agent-config';
import { prisma } from '$lib/server/prisma';
import {
	createProjectSecretForOrg,
	importProjectEnvFileForOrg,
	importSkillsShSkillForOrg,
	listProjectAgentConfigForOrg,
	ProjectAgentConfigError,
	revealProjectEnvVarForOrg,
	setProjectEnvVarSensitiveForOrg,
	upsertProjectEnvVarForOrg,
	upsertProjectMcpServerForOrg,
	upsertProjectSecretForOrg,
	upsertProjectSkillForOrg
} from '$lib/server/project-agent-config-service';
import {
	downloadSkillsShSkill,
	searchSkillsShCatalog,
	SkillsShError
} from '$lib/server/skills-sh-service';
import { requireActiveOrg } from '$lib/server/auth/org';
import { requireHeaders } from '$lib/server/utils';

type McpTransport = ProjectMcpServerInput['transport'];
type EnvRefs = Record<string, { secretName: string }>;
type HeaderValues = Extract<ProjectMcpServerInput, { transport: 'http' }>['headers'];
type HeaderSecretRef = Exclude<HeaderValues[string], string>;
type ImportedSecret = { name: string; value: string };
type ImportedMcpServer = { input: ProjectMcpServerInput; secrets: ImportedSecret[] };

const ENV_PLACEHOLDER_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$/;
const ENV_PLACEHOLDER_IN_STRING_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

async function requireOrganizationId(): Promise<string> {
	const headers = requireHeaders();
	return await requireActiveOrg(headers);
}

function mapProjectAgentConfigCommandError(e: unknown): never {
	if (e instanceof ProjectAgentConfigError) error(400, e.message);
	if (e instanceof SkillsShError) error(400, e.message);
	throw e;
}

function mapProjectAgentConfigQueryError(e: unknown): never {
	if (e instanceof ProjectAgentConfigError) {
		error(e.message === 'Project not found' ? 404 : 400, e.message);
	}
	if (e instanceof SkillsShError) error(400, e.message);
	throw e;
}

async function refreshProjectAgentConfig(projectId: string): Promise<void> {
	await getProjectAgentConfig(projectId).refresh();
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		error(400, message);
	}
	return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, message: string): Record<string, unknown> {
	if (value === undefined) return {};
	return requireRecord(value, message);
}

function requireString(value: unknown, message: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		error(400, message);
	}
	return value;
}

function importSecretName(serverName: string, key: string, usedNames: Set<string>): string {
	const sanitized = `${serverName}_${key}`
		.replace(/[^A-Za-z0-9_-]+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '');
	const base = sanitized.length > 0 ? sanitized.slice(0, 80) : 'imported_secret';
	for (let index = 1; index < 1000; index += 1) {
		const suffix = index === 1 ? '' : `_${index}`;
		const candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`;
		if (!usedNames.has(candidate) && agentConfigNameSchema.safeParse(candidate).success) {
			usedNames.add(candidate);
			return candidate;
		}
	}
	error(400, `MCP \`${serverName}\` could not generate a project secret name`);
}

function secretRefRecord(
	value: unknown,
	serverName: string,
	itemName: string
): { secretName: string } {
	const record = requireRecord(value, `MCP \`${serverName}\` ${itemName} must be a secret ref`);
	const secretName = record.secretName;
	if (typeof secretName !== 'string' || secretName.length === 0) {
		error(400, `MCP \`${serverName}\` ${itemName} must be a secret ref`);
	}
	return { secretName };
}

function headerSecretRefRecord(
	value: unknown,
	serverName: string,
	headerName: string
): HeaderSecretRef {
	const record = requireRecord(
		value,
		`MCP \`${serverName}\` header \`${headerName}\` must be a secret ref`
	);
	const secretName = record.secretName;
	const prefix = record.prefix;
	const suffix = record.suffix;
	if (typeof secretName !== 'string' || secretName.length === 0) {
		error(400, `MCP \`${serverName}\` header \`${headerName}\` must be a secret ref`);
	}
	if (prefix !== undefined && typeof prefix !== 'string') {
		error(400, `MCP \`${serverName}\` header \`${headerName}\` prefix must be a string`);
	}
	if (suffix !== undefined && typeof suffix !== 'string') {
		error(400, `MCP \`${serverName}\` header \`${headerName}\` suffix must be a string`);
	}
	return {
		secretName,
		prefix: prefix || undefined,
		suffix: suffix || undefined
	};
}

function generatedSecretRef(
	value: string,
	serverName: string,
	key: string,
	usedNames: Set<string>
): { ref: { secretName: string }; secret: ImportedSecret } {
	if (value.length === 0) {
		error(400, `MCP \`${serverName}\` secret value for \`${key}\` cannot be empty`);
	}
	const name = importSecretName(serverName, key, usedNames);
	return {
		ref: { secretName: name },
		secret: { name, value }
	};
}

function containsEnvPlaceholder(value: string): boolean {
	ENV_PLACEHOLDER_IN_STRING_RE.lastIndex = 0;
	const hasPlaceholder = ENV_PLACEHOLDER_IN_STRING_RE.test(value);
	ENV_PLACEHOLDER_IN_STRING_RE.lastIndex = 0;
	return hasPlaceholder;
}

function headerTemplateSecretRef(
	value: string,
	serverName: string,
	headerName: string
): HeaderSecretRef | null {
	ENV_PLACEHOLDER_IN_STRING_RE.lastIndex = 0;
	const matches = [...value.matchAll(ENV_PLACEHOLDER_IN_STRING_RE)];
	ENV_PLACEHOLDER_IN_STRING_RE.lastIndex = 0;
	if (matches.length === 0) return null;
	if (matches.length > 1) {
		error(400, `MCP \`${serverName}\` header \`${headerName}\` can reference only one secret`);
	}
	const match = matches[0];
	const index = match.index ?? 0;
	const token = match[0];
	return {
		secretName: match[1],
		prefix: value.slice(0, index) || undefined,
		suffix: value.slice(index + token.length) || undefined
	};
}

function envSecretRef(
	value: unknown,
	serverName: string,
	envName: string,
	usedNames: Set<string>
): { ref: { secretName: string }; secret?: ImportedSecret } {
	if (typeof value === 'string') {
		const placeholder = ENV_PLACEHOLDER_RE.exec(value);
		if (placeholder) return { ref: { secretName: placeholder[1] } };
		if (containsEnvPlaceholder(value)) {
			error(400, `MCP \`${serverName}\` env \`${envName}\` cannot contain partial placeholders`);
		}
		return generatedSecretRef(value, serverName, envName, usedNames);
	}
	return { ref: secretRefRecord(value, serverName, `env \`${envName}\``) };
}

function optionalEnvRefs(
	value: unknown,
	serverName: string,
	usedNames: Set<string>
): { env: EnvRefs; secrets: ImportedSecret[] } {
	const record = optionalRecord(value, `MCP \`${serverName}\` env must be an object`);
	const output: EnvRefs = {};
	const secrets: ImportedSecret[] = [];
	for (const [envName, item] of Object.entries(record)) {
		const imported = envSecretRef(item, serverName, envName, usedNames);
		output[envName] = imported.ref;
		if (imported.secret) secrets.push(imported.secret);
	}
	return { env: output, secrets };
}

function optionalHeaderValues(
	value: unknown,
	serverName: string,
	usedNames: Set<string>
): { headers: HeaderValues; secrets: ImportedSecret[] } {
	const record = optionalRecord(value, `MCP \`${serverName}\` headers must be an object`);
	const headers: HeaderValues = {};
	const secrets: ImportedSecret[] = [];
	for (const [key, item] of Object.entries(record)) {
		if (typeof item === 'string') {
			const headerRef = headerTemplateSecretRef(item, serverName, key);
			if (headerRef) {
				headers[key] = headerRef;
			} else if (isSensitiveConfigKey(key)) {
				const imported = generatedSecretRef(item, serverName, key, usedNames);
				headers[key] = imported.ref;
				secrets.push(imported.secret);
			} else {
				headers[key] = item;
			}
			continue;
		}
		headers[key] = headerSecretRefRecord(item, serverName, key);
	}
	return { headers, secrets };
}

function importTransport(server: Record<string, unknown>, serverName: string): McpTransport {
	const transport = server.type ?? server.transport;
	if (transport === 'stdio' || transport === 'sse' || transport === 'http') return transport;
	if (transport !== undefined) {
		error(400, `MCP \`${serverName}\` has unsupported transport`);
	}
	if (server.command !== undefined && server.url === undefined) return 'stdio';
	if (server.url !== undefined) return 'http';
	return 'http';
}

function importProjectMcpServerInput(
	projectId: string,
	name: string,
	serverValue: unknown,
	usedNames: Set<string>
): ImportedMcpServer {
	const server = requireRecord(serverValue, `MCP \`${name}\` config must be an object`);
	const transport = importTransport(server, name);
	const env = optionalEnvRefs(server.env, name, usedNames);
	const base = {
		projectId,
		name,
		enabled: true,
		env: env.env
	};

	if (transport === 'stdio') {
		const args =
			server.args === undefined ? [] : Array.isArray(server.args) ? server.args.map(String) : [];
		if (server.args !== undefined && !Array.isArray(server.args)) {
			error(400, `MCP \`${name}\` args must be an array`);
		}
		return {
			input: parseImportedProjectMcpServerInput(name, {
				...base,
				transport,
				command: requireString(server.command, `MCP \`${name}\` command must be a string`),
				args
			}),
			secrets: env.secrets
		};
	}

	const headers = optionalHeaderValues(server.headers, name, usedNames);
	return {
		input: parseImportedProjectMcpServerInput(name, {
			...base,
			transport,
			url: requireString(server.url, `MCP \`${name}\` url must be a string`),
			headers: headers.headers
		}),
		secrets: [...env.secrets, ...headers.secrets]
	};
}

function parseImportedProjectMcpServerInput(name: string, input: unknown): ProjectMcpServerInput {
	const parsed = projectMcpServerInputSchema.safeParse(input);
	if (!parsed.success) {
		const message = parsed.error.issues[0]?.message ?? 'Invalid MCP server config';
		error(400, `MCP \`${name}\` ${message}`);
	}
	return parsed.data;
}

export const getProjectAgentConfig = query(z.string(), async (projectId) => {
	const organizationId = await requireOrganizationId();
	try {
		return await listProjectAgentConfigForOrg(organizationId, projectId);
	} catch (e) {
		mapProjectAgentConfigQueryError(e);
	}
});

export const searchSkillsSh = query(skillsShSearchSchema, async (input) => {
	await requireOrganizationId();
	try {
		return await searchSkillsShCatalog(input);
	} catch (e) {
		mapProjectAgentConfigQueryError(e);
	}
});

export const getSkillsShSkill = query(skillsShSkillIdSchema, async (input) => {
	await requireOrganizationId();
	try {
		return await downloadSkillsShSkill(input);
	} catch (e) {
		mapProjectAgentConfigQueryError(e);
	}
});

export const upsertProjectMcpServer = command(projectMcpServerInputSchema, async (input) => {
	const organizationId = await requireOrganizationId();
	try {
		const result = await upsertProjectMcpServerForOrg(organizationId, input);
		await refreshProjectAgentConfig(input.projectId);
		return result;
	} catch (e) {
		mapProjectAgentConfigCommandError(e);
	}
});

export const upsertProjectSkill = command(projectSkillInputSchema, async (input) => {
	const organizationId = await requireOrganizationId();
	try {
		const result = await upsertProjectSkillForOrg(organizationId, input);
		await refreshProjectAgentConfig(input.projectId);
		return result;
	} catch (e) {
		mapProjectAgentConfigCommandError(e);
	}
});

export const importSkillsShSkill = command(importSkillsShSkillSchema, async (input) => {
	const organizationId = await requireOrganizationId();
	try {
		const skill = await downloadSkillsShSkill({ id: input.id });
		const result = await importSkillsShSkillForOrg(organizationId, input.projectId, skill, {
			replace: input.replace
		});
		await refreshProjectAgentConfig(input.projectId);
		return result;
	} catch (e) {
		mapProjectAgentConfigCommandError(e);
	}
});

export const upsertProjectSecret = command(projectSecretInputSchema, async (input) => {
	const organizationId = await requireOrganizationId();
	const { locals } = getRequestEvent();
	try {
		const result = await upsertProjectSecretForOrg(organizationId, locals.user!.id, input);
		await refreshProjectAgentConfig(input.projectId);
		return result;
	} catch (e) {
		mapProjectAgentConfigCommandError(e);
	}
});

export const upsertProjectEnvVar = command(projectEnvVarInputSchema, async (input) => {
	const organizationId = await requireOrganizationId();
	const { locals } = getRequestEvent();
	try {
		const result = await upsertProjectEnvVarForOrg(organizationId, locals.user!.id, input);
		await refreshProjectAgentConfig(input.projectId);
		return result;
	} catch (e) {
		mapProjectAgentConfigCommandError(e);
	}
});

export const deleteProjectEnvVar = command(projectConfigIdSchema, async ({ projectId, id }) => {
	const organizationId = await requireOrganizationId();
	const result = await prisma.projectEnvVar.deleteMany({
		where: { id, projectId, organizationId }
	});
	if (result.count === 0) error(404, 'Not found');
	await refreshProjectAgentConfig(projectId);
});

export const setProjectEnvVarEnabled = command(
	projectConfigEnabledSchema,
	async ({ projectId, id, enabled }) => {
		const organizationId = await requireOrganizationId();
		const result = await prisma.projectEnvVar.updateMany({
			where: { id, projectId, organizationId },
			data: { enabled }
		});
		if (result.count === 0) error(404, 'Not found');
		await refreshProjectAgentConfig(projectId);
	}
);

export const setProjectEnvVarSensitive = command(
	setProjectEnvVarSensitiveSchema,
	async ({ projectId, id, sensitive }) => {
		const organizationId = await requireOrganizationId();
		try {
			await setProjectEnvVarSensitiveForOrg(organizationId, { projectId, id, sensitive });
			await refreshProjectAgentConfig(projectId);
		} catch (e) {
			mapProjectAgentConfigCommandError(e);
		}
	}
);

export const revealProjectEnvVar = command(projectConfigIdSchema, async ({ projectId, id }) => {
	const organizationId = await requireOrganizationId();
	try {
		return { value: await revealProjectEnvVarForOrg(organizationId, { projectId, id }) };
	} catch (e) {
		mapProjectAgentConfigCommandError(e);
	}
});

export const importProjectEnvFile = command(importProjectEnvFileSchema, async (input) => {
	const organizationId = await requireOrganizationId();
	const { locals } = getRequestEvent();
	try {
		const result = await importProjectEnvFileForOrg(organizationId, locals.user!.id, input);
		await refreshProjectAgentConfig(input.projectId);
		return result;
	} catch (e) {
		mapProjectAgentConfigCommandError(e);
	}
});

export const deleteProjectMcpServer = command(projectConfigIdSchema, async ({ projectId, id }) => {
	const organizationId = await requireOrganizationId();
	const result = await prisma.projectMcpServer.deleteMany({
		where: { id, projectId, organizationId }
	});
	if (result.count === 0) error(404, 'Not found');
	await refreshProjectAgentConfig(projectId);
});

export const deleteProjectSkill = command(projectConfigIdSchema, async ({ projectId, id }) => {
	const organizationId = await requireOrganizationId();
	const result = await prisma.projectSkill.deleteMany({
		where: { id, projectId, organizationId }
	});
	if (result.count === 0) error(404, 'Not found');
	await refreshProjectAgentConfig(projectId);
});

export const deleteProjectSecret = command(projectConfigIdSchema, async ({ projectId, id }) => {
	const organizationId = await requireOrganizationId();
	const result = await prisma.projectSecret.deleteMany({
		where: { id, projectId, organizationId }
	});
	if (result.count === 0) error(404, 'Not found');
	await refreshProjectAgentConfig(projectId);
});

export const setProjectMcpServerEnabled = command(
	projectConfigEnabledSchema,
	async ({ projectId, id, enabled }) => {
		const organizationId = await requireOrganizationId();
		const result = await prisma.projectMcpServer.updateMany({
			where: { id, projectId, organizationId },
			data: { enabled }
		});
		if (result.count === 0) error(404, 'Not found');
		await refreshProjectAgentConfig(projectId);
	}
);

export const setProjectSkillEnabled = command(
	projectConfigEnabledSchema,
	async ({ projectId, id, enabled }) => {
		const organizationId = await requireOrganizationId();
		const result = await prisma.projectSkill.updateMany({
			where: { id, projectId, organizationId },
			data: { enabled }
		});
		if (result.count === 0) error(404, 'Not found');
		await refreshProjectAgentConfig(projectId);
	}
);

export const importProjectMcpJson = command(
	importProjectMcpJsonSchema,
	async ({ projectId, json }) => {
		const organizationId = await requireOrganizationId();
		let parsed: unknown;
		try {
			parsed = JSON.parse(json);
		} catch {
			error(400, 'Invalid .mcp.json');
		}

		const root = requireRecord(parsed, 'Invalid .mcp.json');
		const mcpServers = requireRecord(root.mcpServers, '.mcp.json mcpServers must be an object');

		try {
			const existingSecrets = await prisma.projectSecret.findMany({
				where: { organizationId, projectId },
				select: { name: true }
			});
			const generatedSecretNames = new Set(existingSecrets.map((secret) => secret.name));
			const imports = Object.entries(mcpServers).map(([name, server]) =>
				importProjectMcpServerInput(projectId, name, server, generatedSecretNames)
			);
			const { locals } = getRequestEvent();
			const importedSecrets = imports.flatMap((item) => item.secrets);
			for (const secret of importedSecrets) {
				await createProjectSecretForOrg(organizationId, locals.user!.id, {
					projectId,
					name: secret.name,
					value: secret.value
				});
			}
			for (const { input } of imports) {
				await upsertProjectMcpServerForOrg(organizationId, input);
			}
			await refreshProjectAgentConfig(projectId);
			return { imported: imports.length, secretsImported: importedSecrets.length };
		} catch (e) {
			mapProjectAgentConfigCommandError(e);
		}
	}
);

export const importProjectSkillMarkdown = command(
	importProjectSkillMarkdownSchema,
	async ({ projectId, name, markdown }) => {
		const organizationId = await requireOrganizationId();
		const skillName = name ?? 'imported-skill';
		try {
			const result = await upsertProjectSkillForOrg(organizationId, {
				projectId,
				name: skillName,
				description: `Imported skill ${skillName}`,
				body: markdown,
				enabled: true
			});
			await refreshProjectAgentConfig(projectId);
			return result;
		} catch (e) {
			mapProjectAgentConfigCommandError(e);
		}
	}
);
