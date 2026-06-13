import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import {
	importProjectMcpJsonSchema,
	importProjectSkillMarkdownSchema,
	projectConfigEnabledSchema,
	projectConfigIdSchema,
	projectMcpServerInputSchema,
	projectSecretInputSchema,
	projectSkillInputSchema,
	type ProjectMcpServerInput
} from '$lib/schemas/project-agent-config';
import { prisma } from '$lib/server/prisma';
import {
	listProjectAgentConfigForOrg,
	ProjectAgentConfigError,
	upsertProjectMcpServerForOrg,
	upsertProjectSecretForOrg,
	upsertProjectSkillForOrg
} from '$lib/server/project-agent-config-service';
import { requireActiveOrg } from '$lib/server/org';
import { requireHeaders } from '$lib/server/utils';

type McpTransport = ProjectMcpServerInput['transport'];
type EnvRefs = Record<string, { secretName: string }>;

const ENV_PLACEHOLDER_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$/;

async function requireOrganizationId(): Promise<string> {
	const headers = requireHeaders();
	return await requireActiveOrg(headers);
}

function mapProjectAgentConfigCommandError(e: unknown): never {
	if (e instanceof ProjectAgentConfigError) error(400, e.message);
	throw e;
}

function mapProjectAgentConfigQueryError(e: unknown): never {
	if (e instanceof ProjectAgentConfigError) {
		error(e.message === 'Project not found' ? 404 : 400, e.message);
	}
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

function optionalStringRecord(value: unknown, serverName: string): Record<string, string> {
	const record = optionalRecord(value, `MCP \`${serverName}\` headers must be an object`);
	const output: Record<string, string> = {};
	for (const [key, item] of Object.entries(record)) {
		if (typeof item !== 'string') {
			error(400, `MCP \`${serverName}\` header \`${key}\` must be a string`);
		}
		output[key] = item;
	}
	return output;
}

function envSecretRef(value: unknown, serverName: string, envName: string): { secretName: string } {
	if (typeof value === 'string') {
		const placeholder = ENV_PLACEHOLDER_RE.exec(value);
		if (!placeholder) {
			error(400, `MCP \`${serverName}\` env \`${envName}\` must reference a project secret`);
		}
		return { secretName: placeholder[1] };
	}
	const record = requireRecord(
		value,
		`MCP \`${serverName}\` env \`${envName}\` must be a secret ref`
	);
	const secretName = record.secretName;
	if (typeof secretName !== 'string' || secretName.length === 0) {
		error(400, `MCP \`${serverName}\` env \`${envName}\` must be a secret ref`);
	}
	return { secretName };
}

function optionalEnvRefs(value: unknown, serverName: string): EnvRefs {
	const record = optionalRecord(value, `MCP \`${serverName}\` env must be an object`);
	const output: EnvRefs = {};
	for (const [envName, item] of Object.entries(record)) {
		output[envName] = envSecretRef(item, serverName, envName);
	}
	return output;
}

function importTransport(server: Record<string, unknown>): McpTransport {
	const transport = server.type ?? server.transport;
	if (transport === 'stdio' || transport === 'sse') return transport;
	return 'http';
}

function importProjectMcpServerInput(
	projectId: string,
	name: string,
	serverValue: unknown
): ProjectMcpServerInput {
	const server = requireRecord(serverValue, `MCP \`${name}\` config must be an object`);
	const transport = importTransport(server);
	const base = {
		projectId,
		name,
		enabled: true,
		env: optionalEnvRefs(server.env, name)
	};

	if (transport === 'stdio') {
		const args =
			server.args === undefined ? [] : Array.isArray(server.args) ? server.args.map(String) : [];
		if (server.args !== undefined && !Array.isArray(server.args)) {
			error(400, `MCP \`${name}\` args must be an array`);
		}
		return parseImportedProjectMcpServerInput(name, {
			...base,
			transport,
			command: requireString(server.command, `MCP \`${name}\` command must be a string`),
			args
		});
	}

	return parseImportedProjectMcpServerInput(name, {
		...base,
		transport,
		url: requireString(server.url, `MCP \`${name}\` url must be a string`),
		headers: optionalStringRecord(server.headers, name)
	});
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
		const mcpServers = optionalRecord(root.mcpServers, '.mcp.json mcpServers must be an object');

		try {
			for (const [name, server] of Object.entries(mcpServers)) {
				await upsertProjectMcpServerForOrg(
					organizationId,
					importProjectMcpServerInput(projectId, name, server)
				);
			}
			await refreshProjectAgentConfig(projectId);
			return { imported: Object.keys(mcpServers).length };
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
