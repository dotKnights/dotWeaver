import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import {
	importProjectEnvFileSchema,
	importProjectMcpJsonSchema,
	importSkillsShSkillSchema,
	projectConfigEnabledSchema,
	projectConfigIdSchema,
	projectEnvVarInputSchema,
	projectMcpServerInputSchema,
	projectSecretInputSchema,
	projectSkillInputSchema,
	setProjectEnvVarSensitiveSchema,
	skillsShSearchSchema,
	skillsShSkillIdSchema
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
} from '$lib/server/project-agent-config/service';
import {
	downloadSkillsShSkill,
	searchSkillsShCatalog,
	SkillsShError
} from '$lib/server/integrations/skills-sh/service';
import {
	parseProjectMcpJsonImport,
	parseProjectMcpJsonServers,
	ProjectMcpImportError
} from '$lib/server/project-agent-config/mcp-import';
import { requireActiveOrg } from '$lib/server/auth/org';
import { requireHeaders } from '$lib/server/auth/request';

async function requireOrganizationId(): Promise<string> {
	const headers = requireHeaders();
	return await requireActiveOrg(headers);
}

function mapProjectAgentConfigCommandError(e: unknown): never {
	if (e instanceof ProjectAgentConfigError) error(400, e.message);
	if (e instanceof ProjectMcpImportError) error(400, e.message);
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
		try {
			const mcpServers = parseProjectMcpJsonServers(json);
			const existingSecrets = await prisma.projectSecret.findMany({
				where: { organizationId, projectId },
				select: { name: true }
			});
			const imports = parseProjectMcpJsonImport({
				projectId,
				mcpServers,
				existingSecretNames: existingSecrets.map((secret) => secret.name)
			});
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
