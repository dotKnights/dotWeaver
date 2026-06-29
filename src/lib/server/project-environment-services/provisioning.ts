import type { ProjectEnvironmentService } from '@prisma/client';
import { env as privateEnv } from '$env/dynamic/private';
import {
	asConfigRecord,
	collectConfigSecretValues,
	decryptStoredConfig,
	encryptedOutputs,
	errorMessage,
	redactSecrets
} from '$lib/server/project-environment-services/config';
import {
	buildServiceContainerName,
	buildServiceNetworkAlias,
	buildServiceRunArgs,
	buildServiceVolumeName,
	runDockerCommand
} from '$lib/server/project-environment-services/docker';
import { ProjectEnvironmentServiceError } from '$lib/server/project-environment-services/errors';
import {
	appendServiceEvent,
	markProfileNeedsPrepare,
	notifyServiceChange,
	type ServiceEventTarget
} from '$lib/server/project-environment-services/lifecycle';
import {
	assertValidProviderConfig,
	requireProvider
} from '$lib/server/project-environment-services/provider-utils';
import { asJson } from '$lib/server/project-environment-services/prisma-json';
import type {
	EnvironmentServiceProvider,
	PlainServiceOutput,
	ProviderRuntimeInput
} from '$lib/server/project-environment-services/types';
import { ensureDockerNetwork, resolveRunnerNetwork } from '$lib/server/runtime/docker-network';
import { prisma } from '$lib/server/prisma';

const RUNNER_NETWORK = resolveRunnerNetwork(privateEnv.RUNNER_NETWORK);
const HEALTHCHECK_ATTEMPTS = positiveInteger(
	privateEnv.PROJECT_ENVIRONMENT_SERVICE_HEALTHCHECK_ATTEMPTS,
	30
);
const HEALTHCHECK_INTERVAL_MS = nonNegativeInteger(
	privateEnv.PROJECT_ENVIRONMENT_SERVICE_HEALTHCHECK_INTERVAL_MS,
	1000
);

type ServiceRuntimeTarget = ServiceEventTarget &
	Pick<ProjectEnvironmentService, 'kind' | 'name' | 'config' | 'enabled' | 'status'>;

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, ms));
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

async function runHealthcheckWithRetry(args: string[]): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < HEALTHCHECK_ATTEMPTS; attempt += 1) {
		try {
			await runDockerCommand(args);
			return;
		} catch (error) {
			lastError = error;
			if (attempt < HEALTHCHECK_ATTEMPTS - 1) {
				await sleep(HEALTHCHECK_INTERVAL_MS);
			}
		}
	}
	throw lastError;
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
			config: true,
			enabled: true,
			status: true
		}
	});
	if (!service) throw new ProjectEnvironmentServiceError('Project environment service not found');

	const target: ServiceRuntimeTarget = {
		...service
	};
	if (!target.enabled || target.status === 'disabled') {
		throw new ProjectEnvironmentServiceError('Project environment service is disabled');
	}

	const provider = requireProvider(target.kind);
	const config = decryptStoredConfig(asConfigRecord(target.config));
	assertValidProviderConfig(provider, config, `${target.kind} service config is invalid`);
	const containerName = buildServiceContainerName(target.projectId, target.profileId, target.name);
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
	const claim = await prisma.projectEnvironmentService.updateMany({
		where: { id: target.id, enabled: true, status: { not: 'provisioning' } },
		data: { status: 'provisioning', lastError: null }
	});
	if (claim.count === 0) {
		throw new ProjectEnvironmentServiceError('Project environment service is already provisioning');
	}
	const scrub = (message: string) => redactSecrets(message, collectConfigSecretValues(config));

	try {
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
		await ensureDockerNetwork(RUNNER_NETWORK);
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
		await runHealthcheckWithRetry(provider.healthcheck(providerInput));

		const outputs = provider.buildOutputs(providerInput);
		const runtime = buildRuntime({ provider, providerInput, containerSpec, volumeName });
		const readyUpdate = await prisma.projectEnvironmentService.updateMany({
			where: { id: target.id, enabled: true, status: 'provisioning' },
			data: {
				status: 'ready',
				lastError: null,
				runtime: asJson(runtime),
				outputs: asJson(encryptedOutputs(outputs)),
				lastReadyAt: new Date()
			}
		});
		if (readyUpdate.count > 0) {
			await markProfileNeedsPrepare(target);
			await notifyServiceChange(target, { kind: 'service' });
			await appendServiceEvent(target, 'result', {
				status: 'succeeded',
				image: containerSpec.image,
				outputs: outputSummary(outputs)
			});
		}
	} catch (error) {
		const message = scrub(errorMessage(error));
		const serviceError =
			error instanceof ProjectEnvironmentServiceError
				? error
				: new ProjectEnvironmentServiceError(message);
		const failedUpdate = await prisma.projectEnvironmentService.updateMany({
			where: { id: target.id, enabled: true, status: 'provisioning' },
			data: { status: 'failed', lastError: scrub(serviceError.message) }
		});
		if (failedUpdate.count > 0) {
			try {
				await appendServiceEvent(target, 'error', { message: scrub(serviceError.message) });
			} catch {
				// Preserve the provisioning error as the reported failure.
			}
			await notifyServiceChange(target, { kind: 'service' });
		}
		throw serviceError;
	}
}
