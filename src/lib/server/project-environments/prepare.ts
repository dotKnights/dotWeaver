import type { Prisma, ProjectEnvironmentProfile } from '@prisma/client';
import { writeFile } from 'node:fs/promises';
import { env as privateEnv } from '$env/dynamic/private';
import { buildRunArgs, runContainer } from '$lib/server/runtime/docker';
import { ensureDockerNetwork, resolveRunnerNetwork } from '$lib/server/runtime/docker-network';
import {
	authedCloneUrl,
	getGithubTokenForUser,
	makeGitAuth
} from '$lib/server/integrations/github/git-auth';
import { prisma } from '$lib/server/prisma';
import { decryptProjectSecretValue } from '$lib/server/project-agent-config-encryption';
import { materializeProjectEnvFile } from '$lib/server/project-agent-config-service';
import { buildProjectEnvironmentServiceOutputsForOrg } from '$lib/server/project-environment-services/service';
import { projectEnvironmentCacheMounts } from '$lib/server/project-environments/cache-paths';
import { needsProjectEnvironmentPrepare } from '$lib/server/project-environments/fingerprint';
import { notifyProjectEnvironmentPrepare } from '$lib/server/project-environments/notifications';
import { createEnvironmentTemplateCheckout, ensureMirror } from '$lib/server/workspace';
import { projectEnvironmentMetadataPath, workspaceRoot } from '$lib/server/workspace-paths';
import type { ProjectEnvironmentPrepareEventType } from '$lib/domain/project-environment';

const RUNNER_IMAGE = privateEnv.RUNNER_IMAGE ?? 'dotweaver-runner';
const DEFAULT_TIMEOUT_MS = Number(
	privateEnv.PROJECT_ENVIRONMENT_PREPARE_TIMEOUT_MS ?? 10 * 60 * 1000
);
const RUNNER_NETWORK = resolveRunnerNetwork(privateEnv.RUNNER_NETWORK);

export class ProjectEnvironmentPrepareError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectEnvironmentPrepareError';
	}
}

export interface ExecuteProjectEnvironmentPrepareInput {
	profileId: string;
	requestedById: string;
	force: boolean;
}

export type ProjectEnvironmentPrepareResult =
	| { status: 'prepared' }
	| { status: 'skipped_current' }
	| { status: 'already_running' };

type PrepareEventTarget = Pick<ProjectEnvironmentProfile, 'id' | 'projectId' | 'organizationId'>;

type PrepareProfileTarget = PrepareEventTarget &
	Partial<
		Pick<
			ProjectEnvironmentProfile,
			'status' | 'currentFingerprint' | 'lastPreparedFingerprint' | 'lastPrepareStatus'
		>
	>;

function asJson(value: unknown): Prisma.InputJsonValue {
	return value as Prisma.InputJsonValue;
}

function errorMessage(error: unknown): string {
	return String((error as Error)?.message ?? error);
}

function dotenvEscapedValue(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function jsonStringBody(value: string): string | null {
	try {
		return JSON.stringify(value).slice(1, -1);
	} catch {
		return null;
	}
}

function addSecretVariants(secrets: Set<string>, value: string): void {
	if (value.length === 0) return;
	secrets.add(value);
	secrets.add(dotenvEscapedValue(value));
	const jsonValue = jsonStringBody(value);
	if (jsonValue) secrets.add(jsonValue);
}

function createScrubber(values: string[]): (text: string) => string {
	const variants = new Set<string>();
	for (const value of values) {
		addSecretVariants(variants, value);
		for (const line of value.split(/\r\n|\n|\r/)) {
			addSecretVariants(variants, line);
		}
	}
	const secrets = [...variants].sort((a, b) => b.length - a.length);
	return (text: string) => {
		let scrubbed = text;
		for (const secret of secrets) {
			scrubbed = scrubbed.split(secret).join('[redacted]');
		}
		return scrubbed;
	};
}

function workspaceMountCheckedCommand(installCommand: string): string {
	return [
		'if ! test -e .git; then',
		'echo "dotWeaver workspace mount check failed: /workspace is empty or is not the project checkout. Set WORKSPACE_ROOT to an absolute host path shared with Docker/Colima, then restart the app and runner." >&2;',
		'exit 97;',
		'fi;',
		installCommand
	].join(' ');
}

function prepareStderrEventType(line: string): ProjectEnvironmentPrepareEventType {
	if (/^\[\d+(?:\.\d+)?(?:ms|s)\]\s+"\.env(?:\.[^"]+)?"$/.test(line.trim())) {
		return 'output';
	}
	return 'error';
}

async function appendPrepareEvent(
	profile: PrepareEventTarget,
	type: ProjectEnvironmentPrepareEventType,
	payload: unknown
): Promise<void> {
	const last = await prisma.projectEnvironmentPrepareEvent.findFirst({
		where: { profileId: profile.id },
		orderBy: { seq: 'desc' },
		select: { seq: true }
	});
	const seq = (last?.seq ?? -1) + 1;
	await prisma.projectEnvironmentPrepareEvent.create({
		data: {
			profileId: profile.id,
			projectId: profile.projectId,
			organizationId: profile.organizationId,
			seq,
			type,
			payload: asJson(payload)
		}
	});
	await notifyPrepareChange(profile, { kind: 'event', seq });
}

async function notifyPrepareChange(
	profile: PrepareEventTarget,
	change: { kind: 'event'; seq: number } | { kind: 'profile' }
) {
	try {
		await notifyProjectEnvironmentPrepare({
			organizationId: profile.organizationId,
			projectId: profile.projectId,
			profileId: profile.id,
			...change
		});
	} catch {
		// Live UI notifications are best-effort; DB state remains the source of truth.
	}
}

async function markCurrentDetectedProfileReady(profile: PrepareProfileTarget) {
	if (profile.status !== 'detected') return;
	const result = await prisma.projectEnvironmentProfile.updateMany({
		where: {
			id: profile.id,
			status: 'detected',
			currentFingerprint: profile.currentFingerprint,
			lastPreparedFingerprint: profile.lastPreparedFingerprint,
			lastPrepareStatus: 'succeeded'
		},
		data: { status: 'ready' }
	});
	if (result.count > 0) await notifyPrepareChange(profile, { kind: 'profile' });
}

export async function recoverOrphanedProjectEnvironmentPrepares(): Promise<number> {
	const result = await prisma.projectEnvironmentProfile.updateMany({
		where: { lastPrepareStatus: 'running' },
		data: {
			lastPrepareStatus: 'failed',
			lastPrepareError: 'Interrupted by a worker restart'
		}
	});
	return result.count;
}

export async function executeProjectEnvironmentPrepare(
	input: ExecuteProjectEnvironmentPrepareInput
): Promise<ProjectEnvironmentPrepareResult> {
	const profile = await prisma.projectEnvironmentProfile.findFirst({
		where: { id: input.profileId },
		include: { project: true }
	});
	if (!profile) {
		throw new ProjectEnvironmentPrepareError('Project environment profile not found');
	}

	const installCommand = profile.installCommand.trim();
	if (
		installCommand.length > 0 &&
		!input.force &&
		!needsProjectEnvironmentPrepare({
			currentFingerprint: profile.currentFingerprint,
			lastPreparedFingerprint: profile.lastPreparedFingerprint,
			lastPrepareStatus: profile.lastPrepareStatus,
			installCommand
		})
	) {
		await markCurrentDetectedProfileReady(profile);
		return { status: 'skipped_current' };
	}

	const claim = await prisma.projectEnvironmentProfile.updateMany({
		where: { id: profile.id, lastPrepareStatus: { not: 'running' } },
		data: { lastPrepareStatus: 'running', lastPrepareError: null }
	});
	if (claim.count === 0) return { status: 'already_running' };
	await notifyPrepareChange(profile, { kind: 'profile' });

	let auth: Awaited<ReturnType<typeof makeGitAuth>> | null = null;
	let eventError: unknown;
	let eventQueue: Promise<void> = Promise.resolve();
	const appendQueuedEvent = (type: ProjectEnvironmentPrepareEventType, payload: unknown) => {
		eventQueue = eventQueue
			.then(() => appendPrepareEvent(profile, type, payload))
			.catch((error: unknown) => {
				eventError ??= error;
			});
		return eventQueue;
	};
	const flushQueuedEvents = async () => {
		await eventQueue;
		if (eventError) throw eventError;
	};

	try {
		appendQueuedEvent('system', { text: 'Preparing project environment' });
		await flushQueuedEvents();

		const token = await getGithubTokenForUser(input.requestedById);
		auth = token ? await makeGitAuth(token) : null;
		const cloneUrl = token ? authedCloneUrl(profile.project.cloneUrl) : profile.project.cloneUrl;
		await ensureMirror(profile.projectId, cloneUrl, auth?.env);
		const { checkoutPath, baseSha } = await createEnvironmentTemplateCheckout(
			profile.projectId,
			profile.name,
			profile.project.defaultBranch,
			auth?.env
		);

		const envVars = await prisma.projectEnvVar.findMany({
			where: {
				organizationId: profile.organizationId,
				projectId: profile.projectId,
				enabled: true
			},
			orderBy: { key: 'asc' },
			select: { key: true, valueEncrypted: true }
		});
		const envFile = envVars.map((envVar) => ({
			key: envVar.key,
			value: decryptProjectSecretValue(envVar.valueEncrypted)
		}));
		const serviceOutputs = await buildProjectEnvironmentServiceOutputsForOrg(
			profile.organizationId,
			profile.projectId,
			profile.id
		);
		await materializeProjectEnvFile(checkoutPath, envFile, [], serviceOutputs.env);

		const writePrepareMetadata = () =>
			writeFile(
				projectEnvironmentMetadataPath(workspaceRoot(), profile.projectId, profile.name),
				`${JSON.stringify(
					{
						projectId: profile.projectId,
						profileId: profile.id,
						profileName: profile.name,
						runtime: profile.runtime,
						packageManager: profile.packageManager,
						installCommand: profile.installCommand,
						fingerprint: profile.currentFingerprint,
						baseSha,
						preparedAt: new Date().toISOString()
					},
					null,
					2
				)}\n`
			);

		if (installCommand.length === 0) {
			await writePrepareMetadata();
			appendQueuedEvent('result', {
				status: 'succeeded',
				skipped: true,
				reason: 'no_install_command'
			});
			await flushQueuedEvents();
			const update = await prisma.projectEnvironmentProfile.updateMany({
				where: { id: profile.id, lastPrepareStatus: 'running' },
				data: {
					status: 'ready',
					lastPrepareStatus: 'succeeded',
					lastPreparedAt: new Date(),
					lastPreparedFingerprint: profile.currentFingerprint,
					lastPrepareError: null
				}
			});
			if (update.count > 0) await notifyPrepareChange(profile, { kind: 'profile' });
			return { status: 'prepared' };
		}

		const scrub = createScrubber([
			...envFile.map((envVar) => envVar.value),
			...serviceOutputs.env.map((envVar) => envVar.value)
		]);
		const name = `dwenv-${profile.id}`;
		await ensureDockerNetwork(RUNNER_NETWORK);
		const args = buildRunArgs({
			image: RUNNER_IMAGE,
			name,
			workspacePath: checkoutPath,
			entrypoint: '/bin/sh',
			command: ['-c', workspaceMountCheckedCommand(installCommand)],
			mounts: projectEnvironmentCacheMounts({
				root: workspaceRoot(),
				projectId: profile.projectId,
				profileName: profile.name,
				runtime: profile.runtime,
				packageManager: profile.packageManager
			}),
			env: {},
			network: RUNNER_NETWORK
		});

		const result = await runContainer(
			args,
			(line) => appendQueuedEvent('output', { text: scrub(line) }),
			{ timeoutMs: DEFAULT_TIMEOUT_MS, name },
			(line) => {
				void appendQueuedEvent(prepareStderrEventType(line), { text: scrub(line) });
			}
		);
		await flushQueuedEvents();

		if (result.timedOut) {
			throw new ProjectEnvironmentPrepareError('Install command timed out');
		}
		if (result.exitCode !== 0) {
			throw new ProjectEnvironmentPrepareError(
				`Install command failed with exit code ${result.exitCode}`
			);
		}

		await writePrepareMetadata();
		appendQueuedEvent('result', { status: 'succeeded', exitCode: result.exitCode });
		await flushQueuedEvents();
		const update = await prisma.projectEnvironmentProfile.updateMany({
			where: { id: profile.id, lastPrepareStatus: 'running' },
			data: {
				status: 'ready',
				lastPrepareStatus: 'succeeded',
				lastPreparedAt: new Date(),
				lastPreparedFingerprint: profile.currentFingerprint,
				lastPrepareError: null
			}
		});
		if (update.count > 0) await notifyPrepareChange(profile, { kind: 'profile' });
		return { status: 'prepared' };
	} catch (error) {
		const prepareError =
			error instanceof ProjectEnvironmentPrepareError
				? error
				: new ProjectEnvironmentPrepareError(errorMessage(error));
		try {
			appendQueuedEvent('error', { message: prepareError.message });
			await eventQueue;
		} catch {
			// Preserve the prepare failure as the error reported to the queue worker.
		}
		const update = await prisma.projectEnvironmentProfile.updateMany({
			where: { id: profile.id, lastPrepareStatus: 'running' },
			data: {
				lastPrepareStatus: 'failed',
				lastPrepareError: prepareError.message
			}
		});
		if (update.count > 0) await notifyPrepareChange(profile, { kind: 'profile' });
		throw prepareError;
	} finally {
		await auth?.cleanup();
	}
}
