import {
	PROJECT_ENVIRONMENT_SERVICE_KINDS,
	type ProjectEnvironmentServiceKind
} from '$lib/domain/project-environment-service';
import {
	envVarKeySchema,
	isSensitiveConfigKey,
	type ProjectEnvVarInput
} from '$lib/schemas/project-agent-config';
import {
	decryptProjectSecretValue,
	encryptProjectSecretValue
} from '$lib/server/project-agent-config/encryption';
import { ProjectAgentConfigError } from '$lib/server/project-agent-config/errors';
import { requireProjectInOrg } from '$lib/server/project-agent-config/project-access';
import { defaultServiceEnvMappings } from '$lib/server/project-environment-services/env-mapping';
import { prisma } from '$lib/server/prisma';
import { parseDotenv } from '$lib/server/runtime/dotenv';

const PROJECT_ENVIRONMENT_SERVICE_KIND_SET = new Set<string>(PROJECT_ENVIRONMENT_SERVICE_KINDS);

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
