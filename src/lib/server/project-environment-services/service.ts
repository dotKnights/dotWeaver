import type { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { env as privateEnv } from '$env/dynamic/private';
import type {
	ProjectEnvironmentServiceEventType,
	ProjectEnvironmentServiceKind
} from '$lib/domain/project-environment-service';
import { encryptProjectSecretValue } from '$lib/server/project-agent-config-encryption';
import {
	buildServiceContainerName,
	buildServiceNetworkAlias,
	buildServiceRunArgs,
	buildServiceVolumeName,
	runDockerCommand
} from '$lib/server/project-environment-services/docker';
import { notifyProjectEnvironmentService } from '$lib/server/project-environment-services/notifications';
import { getEnvironmentServiceProvider } from '$lib/server/project-environment-services/providers';
import type {
	EnvironmentServiceProvider,
	PlainServiceOutput,
	ProviderRuntimeInput,
	ServiceOutput
} from '$lib/server/project-environment-services/types';
import { prisma } from '$lib/server/prisma';
import {
	projectEnvironmentServiceCreateSchema,
	projectEnvironmentServiceEnabledSchema
} from '$lib/schemas/project-environment-services';

type ProjectEnvironmentServiceCreateRawInput = z.input<
	typeof projectEnvironmentServiceCreateSchema
>;
type ProjectEnvironmentServiceEnabledRawInput = z.input<
	typeof projectEnvironmentServiceEnabledSchema
>;

const RUNNER_NETWORK = privateEnv.RUNNER_NETWORK || 'bridge';

export class ProjectEnvironmentServiceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectEnvironmentServiceError';
	}
}

type ServiceEventTarget = {
	id: string;
	organizationId: string;
	projectId: string;
	profileId: string;
};

type ServiceRuntimeTarget = ServiceEventTarget & {
	kind: ProjectEnvironmentServiceKind;
	name: string;
	config: unknown;
};

function asJson(value: unknown): Prisma.InputJsonValue {
	return value as Prisma.InputJsonValue;
}

function errorMessage(error: unknown): string {
	return String((error as Error)?.message ?? error);
}

function asConfigRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

async function requireProjectEnvironmentProfileForOrg(
	organizationId: string,
	projectId: string,
	profileId: string
) {
	const profile = await prisma.projectEnvironmentProfile.findFirst({
		where: { id: profileId, projectId, organizationId },
		select: { id: true, projectId: true, organizationId: true }
	});
	if (!profile) throw new ProjectEnvironmentServiceError('Project environment profile not found');
	return profile;
}

function requireProvider(kind: ProjectEnvironmentServiceKind): EnvironmentServiceProvider {
	const provider = getEnvironmentServiceProvider(kind);
	if (!provider)
		throw new ProjectEnvironmentServiceError(`Environment service provider ${kind} not found`);
	return provider;
}

function assertValidProviderConfig(
	provider: EnvironmentServiceProvider,
	config: unknown,
	context: string
): void {
	const validation = provider.validateConfig(config);
	if (validation.errors.length > 0) {
		throw new ProjectEnvironmentServiceError(`${context}: ${validation.errors.join('; ')}`);
	}
}

async function notifyServiceChange(
	service: ServiceEventTarget,
	change: { kind: 'event'; seq: number } | { kind: 'service' }
): Promise<void> {
	try {
		await notifyProjectEnvironmentService({
			organizationId: service.organizationId,
			projectId: service.projectId,
			profileId: service.profileId,
			serviceId: service.id,
			...change
		});
	} catch {
		// Live notifications are best-effort; persisted DB state remains authoritative.
	}
}

async function appendServiceEvent(
	service: ServiceEventTarget,
	type: ProjectEnvironmentServiceEventType,
	payload: unknown
): Promise<number> {
	const aggregate = await prisma.projectEnvironmentServiceEvent.aggregate({
		where: { serviceId: service.id },
		_max: { seq: true }
	});
	const seq = (aggregate._max.seq ?? -1) + 1;
	await prisma.projectEnvironmentServiceEvent.create({
		data: {
			serviceId: service.id,
			projectId: service.projectId,
			organizationId: service.organizationId,
			seq,
			type,
			payload: asJson(payload)
		}
	});
	await notifyServiceChange(service, { kind: 'event', seq });
	return seq;
}

function encryptedOutputs(outputs: PlainServiceOutput[]): ServiceOutput[] {
	return outputs.map((output) => {
		const description = output.description === undefined ? {} : { description: output.description };
		if (output.sensitive) {
			return {
				key: output.key,
				valueEncrypted: encryptProjectSecretValue(output.value),
				sensitive: true,
				...description
			};
		}
		return {
			key: output.key,
			value: output.value,
			sensitive: false,
			...description
		};
	});
}

function outputSummary(outputs: PlainServiceOutput[]) {
	return outputs.map((output) => ({
		key: output.key,
		sensitive: output.sensitive
	}));
}

function buildRuntime(input: {
	provider: EnvironmentServiceProvider;
	providerInput: ProviderRuntimeInput;
	containerSpec: ReturnType<EnvironmentServiceProvider['container']>;
	volumeName: string;
}) {
	return {
		containerName: input.providerInput.containerName,
		volumeName: input.volumeName,
		networkAlias: input.providerInput.networkAlias,
		image: input.containerSpec.image,
		provider: {
			kind: input.provider.kind,
			version: input.provider.version
		},
		fingerprint: input.provider.fingerprint(input.providerInput)
	};
}

export async function listProjectEnvironmentServicesForOrg(
	organizationId: string,
	projectId: string,
	profileId: string
) {
	await requireProjectEnvironmentProfileForOrg(organizationId, projectId, profileId);
	return prisma.projectEnvironmentService.findMany({
		where: { organizationId, projectId, profileId },
		orderBy: { name: 'asc' }
	});
}

export async function createProjectEnvironmentServiceForOrg(
	organizationId: string,
	createdById: string,
	rawInput: ProjectEnvironmentServiceCreateRawInput
) {
	const input = projectEnvironmentServiceCreateSchema.parse(rawInput);
	await requireProjectEnvironmentProfileForOrg(organizationId, input.projectId, input.profileId);
	const provider = requireProvider(input.kind);
	const config = provider.defaultConfig({ projectId: input.projectId, name: input.name });
	assertValidProviderConfig(provider, config, `Default ${input.kind} service config is invalid`);

	const service = await prisma.projectEnvironmentService.create({
		data: {
			organizationId,
			projectId: input.projectId,
			profileId: input.profileId,
			kind: input.kind,
			name: input.name,
			enabled: true,
			status: 'configured',
			config: asJson(config),
			outputs: asJson([]),
			runtime: asJson({}),
			createdById
		}
	});
	await notifyServiceChange(service, { kind: 'service' });
	await appendServiceEvent(service, 'system', {
		text: `Configured ${input.kind} service ${input.name}`
	});
	return service;
}

export async function executeProjectEnvironmentServiceProvision(input: {
	serviceId: string;
}): Promise<void> {
	const service = await prisma.projectEnvironmentService.findFirst({
		where: { id: input.serviceId },
		select: {
			id: true,
			organizationId: true,
			projectId: true,
			profileId: true,
			kind: true,
			name: true,
			config: true
		}
	});
	if (!service) throw new ProjectEnvironmentServiceError('Project environment service not found');

	const target: ServiceRuntimeTarget = {
		...service,
		kind: service.kind as ProjectEnvironmentServiceKind
	};

	try {
		const provider = requireProvider(target.kind);
		assertValidProviderConfig(provider, target.config, `${target.kind} service config is invalid`);
		const config = asConfigRecord(target.config);
		const containerName = buildServiceContainerName(
			target.projectId,
			target.profileId,
			target.name
		);
		const volumeName = buildServiceVolumeName(target.projectId, target.profileId, target.name);
		const networkAlias = buildServiceNetworkAlias(target.projectId, target.profileId, target.name);
		const providerInput: ProviderRuntimeInput = {
			projectId: target.projectId,
			serviceId: target.id,
			name: target.name,
			containerName,
			networkAlias,
			config
		};
		const containerSpec = provider.container(providerInput);

		await prisma.projectEnvironmentService.updateMany({
			where: { id: target.id },
			data: { status: 'provisioning', lastError: null }
		});
		await notifyServiceChange(target, { kind: 'service' });
		await appendServiceEvent(target, 'system', {
			text: `Provisioning ${target.kind} service ${target.name}`
		});

		await runDockerCommand(['volume', 'create', volumeName]);
		try {
			await runDockerCommand(['rm', '-f', containerName]);
		} catch {
			// Removing a non-existing container should not fail provisioning.
		}
		await runDockerCommand(
			buildServiceRunArgs({
				image: containerSpec.image,
				containerName,
				network: RUNNER_NETWORK,
				networkAlias,
				volumeName,
				volumeTarget: containerSpec.volumeTarget,
				env: containerSpec.env,
				command: containerSpec.command
			})
		);
		await runDockerCommand(provider.healthcheck(providerInput));

		const outputs = provider.buildOutputs(providerInput);
		const runtime = buildRuntime({ provider, providerInput, containerSpec, volumeName });
		await prisma.projectEnvironmentService.updateMany({
			where: { id: target.id },
			data: {
				status: 'ready',
				lastError: null,
				runtime: asJson(runtime),
				outputs: asJson(encryptedOutputs(outputs)),
				lastReadyAt: new Date()
			}
		});
		await notifyServiceChange(target, { kind: 'service' });
		await appendServiceEvent(target, 'result', {
			status: 'succeeded',
			image: containerSpec.image,
			outputs: outputSummary(outputs)
		});
	} catch (error) {
		const serviceError =
			error instanceof ProjectEnvironmentServiceError
				? error
				: new ProjectEnvironmentServiceError(errorMessage(error));
		try {
			await appendServiceEvent(target, 'error', { message: serviceError.message });
		} catch {
			// Preserve the provisioning error as the reported failure.
		}
		await prisma.projectEnvironmentService.updateMany({
			where: { id: target.id },
			data: { status: 'failed', lastError: serviceError.message }
		});
		await notifyServiceChange(target, { kind: 'service' });
		throw serviceError;
	}
}

export async function setProjectEnvironmentServiceEnabledForOrg(
	organizationId: string,
	rawInput: ProjectEnvironmentServiceEnabledRawInput
) {
	const input = projectEnvironmentServiceEnabledSchema.parse(rawInput);
	const result = await prisma.projectEnvironmentService.updateMany({
		where: {
			id: input.serviceId,
			organizationId,
			projectId: input.projectId,
			profileId: input.profileId
		},
		data: {
			enabled: input.enabled,
			status: input.enabled ? 'configured' : 'disabled'
		}
	});
	if (result.count === 0) {
		throw new ProjectEnvironmentServiceError('Project environment service not found');
	}
	await notifyServiceChange(
		{
			id: input.serviceId,
			organizationId,
			projectId: input.projectId,
			profileId: input.profileId
		},
		{ kind: 'service' }
	);
}
