import { prisma } from '$lib/server/prisma';
import { ensureMirror, createRunCheckout, getHeadSha } from '$lib/server/workspace';
import { buildRunArgs, runContainer, type RunContainerControl } from '$lib/server/docker';
import { ensureDockerNetwork, resolveRunnerNetwork } from '$lib/server/docker-network';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendRunEvent, getNextEventSeq, type SdkMessage } from './events';
import { authedCloneUrl, getGithubTokenForUser, makeGitAuth } from '$lib/server/github-git';
import { containerName, runWorktreePath, workspaceRoot } from '$lib/server/workspace-paths';
import {
	cancelPendingRunInteractions,
	createPendingRunInteraction,
	waitForRunInteractionAnswer
} from './interactions-service';
import {
	buildRunAgentConfig,
	materializeRunAgentConfig
} from '$lib/server/project-agent-config-service';
import { buildRunEnvironmentConfig } from '$lib/server/project-environments/service';
import { buildProjectEnvironmentServiceOutputsForOrg } from '$lib/server/project-environment-services/service';
import { hydrateRunFromPreparedEnvironment } from '$lib/server/project-environments/hydrate';
import { projectEnvironmentCacheMounts } from '$lib/server/project-environments/cache-paths';
import { sendPokeQuestionNotification } from '$lib/server/integrations/poke/service';
import { RUN_STATUS } from '$lib/domain/run-status';
import { transitionRun } from './transitions';
import { env as privateEnv } from '$env/dynamic/private';
import type { RunAgent } from '$lib/schemas/runs';
import {
	PROJECT_ENVIRONMENT_PACKAGE_MANAGERS,
	PROJECT_ENVIRONMENT_RUNTIMES,
	type ProjectEnvironmentPackageManager,
	type ProjectEnvironmentRuntime
} from '$lib/domain/project-environment';

const RUNNER_IMAGE = privateEnv.RUNNER_IMAGE ?? 'dotweaver-runner';
const DEFAULT_TIMEOUT_MS = Number(privateEnv.RUN_TIMEOUT_MS ?? 30 * 60 * 1000);
// Les agents doivent partager un réseau user-defined avec les services projet
// pour résoudre leurs aliases DNS (`POSTGRES_HOST`, `REDIS_HOST`, etc.).
const RUNNER_NETWORK = resolveRunnerNetwork(privateEnv.RUNNER_NETWORK);
const CONTAINER_CODEX_AUTH_JSON = '/runner/codex-auth/auth.json';
const CONTAINER_CLAUDE_CONFIG_DIR = '/workspace/.dotweaver/claude-config';
const PROVIDER_CREDENTIAL_FORWARDING_FLAG = 'DOTWEAVER_ALLOW_UNTRUSTED_AGENT_PROVIDER_CREDENTIALS';

function runAgent(value: string | null | undefined): RunAgent {
	return value === 'codex' ? 'codex' : 'claude';
}

function localCodexAuthJsonPath(): string | null {
	const configured = privateEnv.CODEX_AUTH_JSON_PATH;
	if (configured && existsSync(configured)) return configured;
	const defaultPath = join(homedir(), '.codex', 'auth.json');
	return existsSync(defaultPath) ? defaultPath : null;
}

function providerCredentialForwardingAllowed(): boolean {
	return privateEnv[PROVIDER_CREDENTIAL_FORWARDING_FLAG] === 'true';
}

function sharedProviderCredentialSources(agent: RunAgent, codexAuthJson: string | null): string[] {
	if (agent === 'claude') {
		return privateEnv.CLAUDE_CODE_OAUTH_TOKEN ? ['CLAUDE_CODE_OAUTH_TOKEN'] : [];
	}

	const sources: string[] = [];
	if (privateEnv.CODEX_API_KEY) sources.push('CODEX_API_KEY');
	if (privateEnv.CODEX_ACCESS_TOKEN) sources.push('CODEX_ACCESS_TOKEN');
	if (!privateEnv.CODEX_API_KEY && !privateEnv.CODEX_ACCESS_TOKEN && codexAuthJson) {
		sources.push('Codex auth cache');
	}
	return sources;
}

function assertProviderCredentialForwardingAllowed(
	agent: RunAgent,
	codexAuthJson: string | null
): void {
	const sources = sharedProviderCredentialSources(agent, codexAuthJson);
	if (sources.length === 0 || providerCredentialForwardingAllowed()) return;
	throw new Error(
		`Agent provider credential forwarding is disabled by default; refusing to expose ${sources.join(
			', '
		)} to the repository-controlled ${agent} container. Set ${PROVIDER_CREDENTIAL_FORWARDING_FLAG}=true only for trusted repositories.`
	);
}

function isInteractionRequest(message: SdkMessage): message is SdkMessage & {
	type: 'interaction_request';
	kind: 'ask_user_question';
	toolUseId: string;
	request: unknown;
} {
	return (
		message.type === 'interaction_request' &&
		message.kind === 'ask_user_question' &&
		typeof message.toolUseId === 'string' &&
		Object.prototype.hasOwnProperty.call(message, 'request')
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProjectEnvironmentRuntime(value: unknown): value is ProjectEnvironmentRuntime {
	return (
		typeof value === 'string' &&
		PROJECT_ENVIRONMENT_RUNTIMES.includes(value as ProjectEnvironmentRuntime)
	);
}

function isProjectEnvironmentPackageManager(
	value: unknown
): value is ProjectEnvironmentPackageManager {
	return (
		typeof value === 'string' &&
		PROJECT_ENVIRONMENT_PACKAGE_MANAGERS.includes(value as ProjectEnvironmentPackageManager)
	);
}

function resumeEnvironmentCacheMounts(input: { snapshot: unknown; projectId: string }) {
	if (!isRecord(input.snapshot)) return [];
	if (input.snapshot.enabled !== true) return [];
	if (!isProjectEnvironmentRuntime(input.snapshot.runtime)) return [];
	if (!isProjectEnvironmentPackageManager(input.snapshot.packageManager)) return [];
	return projectEnvironmentCacheMounts({
		root: workspaceRoot(),
		projectId: input.projectId,
		profileName: 'default',
		runtime: input.snapshot.runtime,
		packageManager: input.snapshot.packageManager
	});
}

function resumeEnvironmentProfileId(snapshot: unknown): string | null {
	if (!isRecord(snapshot)) return null;
	if (snapshot.enabled !== true) return null;
	return typeof snapshot.profileId === 'string' && snapshot.profileId.length > 0
		? snapshot.profileId
		: null;
}

async function buildResumeEnvironmentConfig(input: {
	organizationId: string;
	projectId: string;
	snapshot: unknown;
}) {
	const snapshot = input.snapshot ?? { enabled: false, resume: true };
	const profileId = resumeEnvironmentProfileId(snapshot);
	const serviceOutputs = profileId
		? await buildProjectEnvironmentServiceOutputsForOrg(
				input.organizationId,
				input.projectId,
				profileId
			)
		: { env: [] };

	return {
		snapshot,
		cacheMounts: resumeEnvironmentCacheMounts({
			snapshot,
			projectId: input.projectId
		}),
		...(serviceOutputs.env.length > 0 ? { containerEnv: serviceOutputs.env } : {})
	};
}

function envEntriesToRecord(
	entries: Array<{ key: string; value: string }> = []
): Record<string, string> {
	return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
}

function containerEnvEntries(input: unknown): Array<{ key: string; value: string }> {
	if (!isRecord(input)) return [];
	const entries = input.containerEnv;
	if (!Array.isArray(entries)) return [];
	return entries.filter(
		(entry): entry is { key: string; value: string } =>
			isRecord(entry) && typeof entry.key === 'string' && typeof entry.value === 'string'
	);
}

/**
 * Exécute un run de bout en bout : mirror → checkout → conteneur agent → events →
 * `awaiting_review`. Transitions conditionnelles : une annulation/timeout concurrente
 * n'est jamais écrasée. Le checkout est CONSERVÉ (Phase 4).
 */
export async function executeRun(runId: string): Promise<void> {
	const run = await prisma.run.findUnique({ where: { id: runId }, include: { project: true } });
	if (!run) throw new Error(`Run ${runId} not found`);
	const project = run.project;
	const agent = runAgent(run.agent);
	const isResume = Boolean(run.sessionId && run.pendingPrompt);
	const pending: Promise<void>[] = [];
	const interactionAbort = new AbortController();
	const interactionSetupTasks = new Set<Promise<unknown>>();
	const interactionAnswerTasks = new Set<Promise<unknown>>();

	function trackInteractionTask<T>(tasks: Set<Promise<unknown>>, task: Promise<T>): Promise<T> {
		const tracked = task.finally(() => {
			tasks.delete(tracked);
		});
		tasks.add(tracked);
		void tracked.catch(() => {});
		return task;
	}

	async function waitForInteractionTasks(propagateErrors: boolean): Promise<void> {
		while (interactionSetupTasks.size > 0 || interactionAnswerTasks.size > 0) {
			const tasks = [...interactionSetupTasks, ...interactionAnswerTasks];
			if (propagateErrors) {
				await Promise.all(tasks);
			} else {
				await Promise.allSettled(tasks);
			}
		}
	}

	async function abortAndSettleInteractionTasks(): Promise<void> {
		interactionAbort.abort();
		await waitForInteractionTasks(false);
	}

	// Réclame le job avec la bonne transition initiale.
	if (isResume) {
		if (
			!(await transitionRun(runId, RUN_STATUS.QUEUED, RUN_STATUS.RUNNING, { pendingPrompt: null }))
		) {
			return;
		}
	} else {
		if (
			!(await transitionRun(runId, RUN_STATUS.QUEUED, RUN_STATUS.PREPARING, {
				startedAt: new Date()
			}))
		) {
			return;
		}
	}

	try {
		// La reprise n'a besoin ni de mirror ni de clone : le checkout est déjà sur l'hôte.
		const token = isResume ? null : await getGithubTokenForUser(run.createdById);
		const auth = token ? await makeGitAuth(token) : null;
		try {
			let checkoutPath: string;
			let baseSha: string | undefined;

			if (isResume) {
				checkoutPath = runWorktreePath(workspaceRoot(), project.id, runId);
				if (!existsSync(checkoutPath)) {
					await transitionRun(runId, RUN_STATUS.RUNNING, RUN_STATUS.FAILED, {
						error: 'Run workspace is no longer available for resume',
						finishedAt: new Date()
					});
					return;
				}
			} else {
				const cloneUrl = token ? authedCloneUrl(project.cloneUrl) : project.cloneUrl;
				await ensureMirror(project.id, cloneUrl, auth?.env);
				const checkout = await createRunCheckout(project.id, runId, run.baseBranch, auth?.env);
				checkoutPath = checkout.checkoutPath;
				baseSha = checkout.baseSha;
			}

			const codexAuthJson = agent === 'codex' ? localCodexAuthJsonPath() : null;
			assertProviderCredentialForwardingAllowed(agent, codexAuthJson);

			const agentConfig = await buildRunAgentConfig(run.organizationId, project.id, {
				useProjectAgentConfig: run.useProjectAgentConfig
			});

			const environmentConfig = isResume
				? await buildResumeEnvironmentConfig({
						organizationId: run.organizationId,
						projectId: project.id,
						snapshot: run.environmentSnapshot
					})
				: await buildRunEnvironmentConfig(run.organizationId, project.id);

			if (!isResume) {
				if (!isRecord(environmentConfig.snapshot)) {
					throw new Error('Invalid project environment snapshot');
				}
				const snapshot = environmentConfig.snapshot;
				if (snapshot.enabled === true) {
					if (
						typeof snapshot.templatePath !== 'string' ||
						snapshot.templatePath.length === 0 ||
						!isProjectEnvironmentRuntime(snapshot.runtime) ||
						!isProjectEnvironmentPackageManager(snapshot.packageManager)
					) {
						throw new Error('Prepared project environment snapshot is incomplete');
					}
					await hydrateRunFromPreparedEnvironment({
						templatePath: snapshot.templatePath,
						checkoutPath,
						runtime: snapshot.runtime,
						packageManager: snapshot.packageManager
					});
				}
			}

			if (run.useProjectAgentConfig) {
				await materializeRunAgentConfig(checkoutPath, agentConfig);
			}

			if (!isResume) {
				if (
					!(await transitionRun(runId, RUN_STATUS.PREPARING, RUN_STATUS.RUNNING, {
						baseCommitSha: baseSha,
						agentConfigSnapshot: agentConfig.snapshot,
						environmentSnapshot: environmentConfig.snapshot
					}))
				) {
					return;
				}
			}

			let seq = await getNextEventSeq(runId);
			let sessionId: string | undefined = run.sessionId ?? undefined;
			const mounts: Array<{ source: string; target: string; readOnly?: boolean }> = [];
			const projectRuntimeEnv = envEntriesToRecord([
				...containerEnvEntries(environmentConfig),
				...(agentConfig.envFile ?? [])
			]);
			const env: Record<string, string> = {
				...projectRuntimeEnv,
				...(agentConfig.secretEnv ?? {}),
				RUN_PROMPT: isResume ? run.pendingPrompt! : run.prompt,
				RUN_AGENT: agent
			};
			const forwardProviderCredentials = providerCredentialForwardingAllowed();
			if (agent === 'claude') {
				if (forwardProviderCredentials && privateEnv.CLAUDE_CODE_OAUTH_TOKEN) {
					env.CLAUDE_CODE_OAUTH_TOKEN = privateEnv.CLAUDE_CODE_OAUTH_TOKEN;
				}
				env.CLAUDE_CONFIG_DIR = CONTAINER_CLAUDE_CONFIG_DIR;
			} else if (forwardProviderCredentials) {
				if (privateEnv.CODEX_API_KEY) env.CODEX_API_KEY = privateEnv.CODEX_API_KEY;
				if (privateEnv.CODEX_ACCESS_TOKEN) env.CODEX_ACCESS_TOKEN = privateEnv.CODEX_ACCESS_TOKEN;
				if (!env.CODEX_API_KEY && !env.CODEX_ACCESS_TOKEN) {
					if (codexAuthJson) {
						env.CODEX_AUTH_JSON_SOURCE = CONTAINER_CODEX_AUTH_JSON;
						mounts.push({
							source: codexAuthJson,
							target: CONTAINER_CODEX_AUTH_JSON,
							readOnly: true
						});
					}
				}
			}
			if (run.model) env.RUN_MODEL = run.model;
			// Seul un run repris possède un sessionId ; un run frais n'en a jamais.
			if (run.sessionId) env.RUN_RESUME_SESSION = run.sessionId;

			const timeoutMs = run.timeoutAt
				? Math.max(1000, run.timeoutAt.getTime() - Date.now())
				: DEFAULT_TIMEOUT_MS;
			await ensureDockerNetwork(RUNNER_NETWORK);
			const args = buildRunArgs({
				image: RUNNER_IMAGE,
				name: containerName(runId),
				workspacePath: checkoutPath,
				mounts: [...(environmentConfig.cacheMounts ?? []), ...mounts],
				env,
				network: RUNNER_NETWORK
			});

			const containerResult = await runContainer(
				args,
				async (line, control: RunContainerControl) => {
					let msg: SdkMessage;
					try {
						msg = JSON.parse(line);
					} catch {
						return;
					}
					if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
						sessionId = (msg as { session_id?: string }).session_id;
					}
					if (isInteractionRequest(msg)) {
						const setupTask = (async () => {
							const interaction = await createPendingRunInteraction({
								runId,
								toolUseId: msg.toolUseId,
								request: msg.request
							});
							pending.push(
								sendPokeQuestionNotification({
									userId: run.createdById,
									runId,
									interactionId: interaction.id,
									projectLabel: `${project.owner}/${project.name}`,
									request: msg.request
								}).then(
									() => {},
									() => {}
								)
							);
							pending.push(
								appendRunEvent(runId, seq++, {
									...msg,
									interactionId: interaction.id
								}).catch(() => {})
							);
							await transitionRun(runId, RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_INPUT);
							const answerTask = (async () => {
								const response = await waitForRunInteractionAnswer(interaction.id, {
									signal: interactionAbort.signal
								});
								if (interactionAbort.signal.aborted) return;
								await control.sendControlMessage({
									type: 'interaction_response',
									toolUseId: msg.toolUseId,
									response
								});
								if (interactionAbort.signal.aborted) return;
								await transitionRun(runId, RUN_STATUS.AWAITING_INPUT, RUN_STATUS.RUNNING);
							})().catch((error: unknown) => {
								if (interactionAbort.signal.aborted) return;
								throw error;
							});
							trackInteractionTask(interactionAnswerTasks, answerTask);
						})();
						await trackInteractionTask(interactionSetupTasks, setupTask);
						return;
					}
					pending.push(appendRunEvent(runId, seq++, msg).catch(() => {}));
				},
				{ timeoutMs, name: containerName(runId) }
			);
			const { exitCode, timedOut } = containerResult;

			if (timedOut) {
				await abortAndSettleInteractionTasks();
				await Promise.all(pending);
				await cancelPendingRunInteractions(runId);
				await transitionRun(
					runId,
					[RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_INPUT],
					RUN_STATUS.TIMED_OUT,
					{
						error: 'Run exceeded the time limit',
						finishedAt: new Date()
					}
				);
			} else if (exitCode === 0) {
				await waitForInteractionTasks(true);
				await Promise.all(pending);
				const head = await getHeadSha(checkoutPath, auth?.env);
				await transitionRun(runId, RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_REVIEW, {
					headCommitSha: head,
					sessionId: sessionId ?? null,
					finishedAt: new Date()
				});
			} else {
				await abortAndSettleInteractionTasks();
				await Promise.all(pending);
				await cancelPendingRunInteractions(runId);
				await transitionRun(
					runId,
					[RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_INPUT],
					RUN_STATUS.FAILED,
					{
						error: `Container exited with code ${exitCode}`,
						finishedAt: new Date()
					}
				);
			}
		} finally {
			await auth?.cleanup();
		}
	} catch (err) {
		await abortAndSettleInteractionTasks();
		await Promise.allSettled(pending);
		await cancelPendingRunInteractions(runId);
		await transitionRun(
			runId,
			[RUN_STATUS.QUEUED, RUN_STATUS.PREPARING, RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_INPUT],
			RUN_STATUS.FAILED,
			{
				error: String((err as Error)?.message ?? err),
				finishedAt: new Date()
			}
		);
	}
}
