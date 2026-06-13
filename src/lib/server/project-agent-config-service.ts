import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Prisma } from '@prisma/client';
import { prisma } from '$lib/server/prisma';
import {
	decryptProjectSecretValue,
	encryptProjectSecretValue
} from '$lib/server/project-agent-config-encryption';
import {
	agentConfigNameSchema,
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

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function envPlaceholders(envRefs: unknown): Record<string, string> {
	return Object.fromEntries(Object.keys(asRecord(envRefs)).map((key) => [key, `$${key}`]));
}

function envSecretRefs(envRefs: unknown, serverName: string): EnvRefs {
	const refs: EnvRefs = {};
	for (const [envName, ref] of Object.entries(asRecord(envRefs))) {
		const secretName = asRecord(ref).secretName;
		if (typeof secretName !== 'string') {
			throw new ProjectAgentConfigError(`MCP \`${serverName}\` has an invalid secret reference`);
		}
		refs[envName] = { secretName };
	}
	return refs;
}

function buildMcpJsonServer(server: {
	transport: string;
	config: unknown;
	env: unknown;
}): RuntimeMcpServer {
	const config = asRecord(server.config);
	if (server.transport === 'stdio') {
		return {
			type: 'stdio',
			command: config.command,
			args: Array.isArray(config.args) ? config.args : [],
			env: envPlaceholders(server.env)
		};
	}
	return {
		type: server.transport,
		url: config.url,
		headers: asRecord(config.headers),
		env: envPlaceholders(server.env)
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
	const secretByName = new Map(secrets.map((secret) => [secret.name, secret]));
	const secretEnv: Record<string, string> = {};

	for (const server of mcpServers) {
		for (const [envName, ref] of Object.entries(envSecretRefs(server.env, server.name))) {
			const secret = secretByName.get(ref.secretName);
			if (!secret) {
				throw new ProjectAgentConfigError(
					`MCP \`${server.name}\` references missing secret \`${ref.secretName}\``
				);
			}
			secretEnv[envName] = decryptProjectSecretValue(secret.valueEncrypted);
		}
	}

	return {
		mcpJson: {
			mcpServers: Object.fromEntries(
				mcpServers.map((server) => [server.name, buildMcpJsonServer(server)])
			)
		},
		settings: { enabledMcpjsonServers: mcpServers.map((server) => server.name) },
		skills: skills.map((skill) => ({ name: skill.name, body: skill.body })),
		secretEnv,
		snapshot: {
			enabled: true,
			mcpServers: mcpServers.map((server) => ({
				id: server.id,
				name: server.name,
				transport: server.transport
			})),
			skills: skills.map((skill) => ({ id: skill.id, name: skill.name }))
		}
	};
}

function scrubMcpJsonSecrets(config: RuntimeAgentConfig['mcpJson']): RuntimeAgentConfig['mcpJson'] {
	return {
		mcpServers: Object.fromEntries(
			Object.entries(config.mcpServers).map(([name, server]) => {
				const copy = { ...server };
				if ('env' in copy) {
					copy.env = envPlaceholders(copy.env);
				}
				return [name, copy];
			})
		)
	};
}

export async function materializeRunAgentConfig(
	checkoutPath: string,
	config: RuntimeAgentConfig
): Promise<void> {
	const claudeDir = join(checkoutPath, '.claude');
	await mkdir(claudeDir, { recursive: true });
	await writeFile(
		join(checkoutPath, '.mcp.json'),
		`${JSON.stringify(scrubMcpJsonSecrets(config.mcpJson), null, 2)}\n`
	);
	await writeFile(
		join(claudeDir, 'settings.json'),
		`${JSON.stringify(config.settings, null, 2)}\n`
	);

	for (const skill of config.skills) {
		assertSafeName(skill.name);
		const skillDir = join(claudeDir, 'skills', skill.name);
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			join(skillDir, 'SKILL.md'),
			skill.body.endsWith('\n') ? skill.body : `${skill.body}\n`
		);
	}
}
