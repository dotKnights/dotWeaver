import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunContainerControl, RunContainerLineHandler } from '$lib/server/docker';
import type { SerializedAskUserQuestionResponse } from '$lib/schemas/run-interactions';

const mocks = vi.hoisted(() => ({
	runFindUnique: vi.fn(),
	runUpdateMany: vi.fn(),
	ensureMirror: vi.fn(),
	createRunCheckout: vi.fn(),
	getHeadSha: vi.fn(),
	buildRunArgs: vi.fn(),
	runContainer: vi.fn(),
	appendRunEvent: vi.fn(),
	authedCloneUrl: vi.fn(),
	getGithubTokenForUser: vi.fn(),
	makeGitAuth: vi.fn(),
	containerName: vi.fn(),
	createPendingRunInteraction: vi.fn(),
	waitForRunInteractionAnswer: vi.fn(),
	cancelPendingRunInteractions: vi.fn(),
	sendPokeQuestionNotification: vi.fn(),
	buildRunAgentConfig: vi.fn(),
	materializeRunAgentConfig: vi.fn(),
	buildRunEnvironmentConfig: vi.fn(),
	prepareRunEnvironmentIfNeeded: vi.fn(),
	hydrateRunFromPreparedEnvironment: vi.fn(),
	getNextEventSeq: vi.fn(),
	runWorktreePath: vi.fn(),
	workspaceRoot: vi.fn(),
	existsSync: vi.fn(),
	privateEnv: {} as Record<string, string>
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.privateEnv }));
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		run: {
			findUnique: mocks.runFindUnique,
			updateMany: mocks.runUpdateMany
		}
	}
}));
vi.mock('$lib/server/workspace', () => ({
	ensureMirror: mocks.ensureMirror,
	createRunCheckout: mocks.createRunCheckout,
	getHeadSha: mocks.getHeadSha
}));
vi.mock('$lib/server/docker', () => ({
	buildRunArgs: mocks.buildRunArgs,
	runContainer: mocks.runContainer
}));
vi.mock('$lib/server/run-events', () => ({
	appendRunEvent: mocks.appendRunEvent,
	getNextEventSeq: mocks.getNextEventSeq
}));
vi.mock('$lib/server/github-git', () => ({
	authedCloneUrl: mocks.authedCloneUrl,
	getGithubTokenForUser: mocks.getGithubTokenForUser,
	makeGitAuth: mocks.makeGitAuth
}));
vi.mock('$lib/server/workspace-paths', () => ({
	containerName: mocks.containerName,
	runWorktreePath: mocks.runWorktreePath,
	workspaceRoot: mocks.workspaceRoot
}));
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }));
vi.mock('$lib/server/run-interactions-service', () => ({
	createPendingRunInteraction: mocks.createPendingRunInteraction,
	waitForRunInteractionAnswer: mocks.waitForRunInteractionAnswer,
	cancelPendingRunInteractions: mocks.cancelPendingRunInteractions
}));
vi.mock('$lib/server/poke-service', () => ({
	sendPokeQuestionNotification: mocks.sendPokeQuestionNotification
}));
vi.mock('$lib/server/project-agent-config-service', () => ({
	buildRunAgentConfig: mocks.buildRunAgentConfig,
	materializeRunAgentConfig: mocks.materializeRunAgentConfig
}));
vi.mock('$lib/server/project-environments/service', () => ({
	buildRunEnvironmentConfig: mocks.buildRunEnvironmentConfig,
	prepareRunEnvironmentIfNeeded: mocks.prepareRunEnvironmentIfNeeded
}));
vi.mock('$lib/server/project-environments/hydrate', () => ({
	hydrateRunFromPreparedEnvironment: mocks.hydrateRunFromPreparedEnvironment
}));

import { executeRun } from '$lib/server/run-orchestrator';

const runId = 'r1';
const request = {
	questions: [
		{
			question: 'Which layout?',
			header: 'Layout',
			multiSelect: false,
			options: [
				{ label: 'Compact', description: 'Dense inspector' },
				{ label: 'Split', description: 'Events and side panel' }
			]
		}
	]
};
const interactionRequest = {
	type: 'interaction_request',
	kind: 'ask_user_question',
	toolUseId: 'toolu_1',
	request
};

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function hasSettled(promise: Promise<unknown>) {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		}
	);
	await Promise.resolve();
	await Promise.resolve();
	return settled;
}

function emptyRuntimeAgentConfig(enabled = true) {
	return {
		mcpJson: { mcpServers: {} },
		settings: { enabledMcpjsonServers: [] },
		skills: [],
		secretEnv: {},
		envFile: [],
		snapshot: { enabled, mcpServers: [], skills: [], envVars: [] }
	};
}

function setupRun(overrides = {}) {
	mocks.runFindUnique.mockResolvedValue({
		id: runId,
		organizationId: 'org1',
		projectId: 'p1',
		createdById: 'u1',
		prompt: 'do it',
		agent: 'claude',
		model: null,
		baseBranch: 'feature/login',
		sessionId: null,
		timeoutAt: new Date(Date.now() + 60_000),
		useProjectAgentConfig: true,
		agentConfigSnapshot: null,
		project: {
			id: 'p1',
			owner: 'acme',
			name: 'repo',
			cloneUrl: 'https://github.com/acme/repo.git',
			defaultBranch: 'main'
		},
		...overrides
	});
	mocks.runUpdateMany.mockResolvedValue({ count: 1 });
	mocks.getGithubTokenForUser.mockResolvedValue(null);
	mocks.ensureMirror.mockResolvedValue(undefined);
	mocks.createRunCheckout.mockResolvedValue({ checkoutPath: '/checkout', baseSha: 'base' });
	mocks.getHeadSha.mockResolvedValue('head');
	mocks.appendRunEvent.mockResolvedValue(undefined);
	mocks.cancelPendingRunInteractions.mockResolvedValue({ count: 1 });
}

function expectTransition(from: string[], status: string) {
	expect(mocks.runUpdateMany).toHaveBeenCalledWith(
		expect.objectContaining({
			where: { id: runId, status: { in: from } },
			data: expect.objectContaining({ status })
		})
	);
}

function expectNoTransition(from: string[], status: string) {
	expect(mocks.runUpdateMany).not.toHaveBeenCalledWith(
		expect.objectContaining({
			where: { id: runId, status: { in: from } },
			data: expect.objectContaining({ status })
		})
	);
}

function expectNoAwaitingInputResume() {
	expect(mocks.runUpdateMany).not.toHaveBeenCalledWith(
		expect.objectContaining({
			where: expect.objectContaining({ status: { in: ['awaiting_input'] } }),
			data: expect.objectContaining({ status: 'running' })
		})
	);
}

describe('executeRun interactions', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		for (const key of Object.keys(mocks.privateEnv)) delete mocks.privateEnv[key];
		mocks.buildRunArgs.mockReturnValue(['run', 'img']);
		mocks.buildRunAgentConfig.mockResolvedValue(emptyRuntimeAgentConfig(true));
		mocks.materializeRunAgentConfig.mockResolvedValue(undefined);
		mocks.buildRunEnvironmentConfig.mockResolvedValue({
			snapshot: {
				enabled: true,
				profileId: 'env1',
				profileName: 'default',
				runtime: 'node',
				packageManager: 'bun',
				installCommand: 'bun install',
				currentFingerprint: 'fp1',
				lastPreparedFingerprint: 'fp1',
				lastPrepareStatus: 'succeeded',
				needsPrepare: false,
				prepared: true,
				templatePath: '/template'
			},
			cacheMounts: []
		});
		mocks.prepareRunEnvironmentIfNeeded.mockResolvedValue(undefined);
		mocks.hydrateRunFromPreparedEnvironment.mockResolvedValue({
			copied: ['node_modules'],
			skipped: []
		});
		mocks.authedCloneUrl.mockImplementation((url: string) => url);
		mocks.containerName.mockImplementation((id: string) => `dwrun-${id}`);
		mocks.getNextEventSeq.mockResolvedValue(0);
		mocks.sendPokeQuestionNotification.mockResolvedValue({ sent: true });
	});

	it('materializes project agent config before Docker, injects secret env, and stores the snapshot', async () => {
		setupRun();
		const snapshot = {
			enabled: true,
			mcpServers: [{ id: 'mcp1', name: 'linear', transport: 'http' }],
			skills: [{ id: 'skill1', name: 'reviewer' }],
			envVars: []
		};
		mocks.buildRunAgentConfig.mockResolvedValue({
			...emptyRuntimeAgentConfig(true),
			secretEnv: { DOTWEAVER_MCP_LINEAR_TOKEN: 'secret-token' },
			snapshot
		});
		mocks.runContainer.mockResolvedValue({ exitCode: 0, timedOut: false });

		await executeRun(runId);

		expect(mocks.buildRunAgentConfig).toHaveBeenCalledWith('org1', 'p1', {
			useProjectAgentConfig: true
		});
		expect(mocks.materializeRunAgentConfig).toHaveBeenCalledWith(
			'/checkout',
			expect.objectContaining({ secretEnv: { DOTWEAVER_MCP_LINEAR_TOKEN: 'secret-token' } })
		);
		expect(mocks.materializeRunAgentConfig.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.runContainer.mock.invocationCallOrder[0]
		);
		expect(mocks.buildRunArgs).toHaveBeenCalledWith(
			expect.objectContaining({
				env: expect.objectContaining({
					RUN_PROMPT: 'do it',
					RUN_AGENT: 'claude',
					CLAUDE_CODE_OAUTH_TOKEN: '',
					DOTWEAVER_MCP_LINEAR_TOKEN: 'secret-token'
				})
			})
		);
		expect(mocks.runUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: runId, status: { in: ['preparing'] } },
				data: expect.objectContaining({
					status: 'running',
					baseCommitSha: 'base',
					agentConfigSnapshot: snapshot
				})
			})
		);
	});

	it('hydrates the run checkout from a prepared environment before agent config and Docker', async () => {
		setupRun();
		mocks.runContainer.mockResolvedValue({ exitCode: 0, timedOut: false });

		await executeRun(runId);

		expect(mocks.hydrateRunFromPreparedEnvironment).toHaveBeenCalledWith({
			templatePath: '/template',
			checkoutPath: '/checkout',
			runtime: 'node',
			packageManager: 'bun'
		});
		expect(mocks.hydrateRunFromPreparedEnvironment.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.materializeRunAgentConfig.mock.invocationCallOrder[0]
		);
		expect(mocks.materializeRunAgentConfig.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.runContainer.mock.invocationCallOrder[0]
		);
		expect(mocks.prepareRunEnvironmentIfNeeded).not.toHaveBeenCalled();
	});

	it('fails before Docker when prepared environment hydration fails', async () => {
		setupRun();
		mocks.hydrateRunFromPreparedEnvironment.mockRejectedValue(new Error('node_modules missing'));

		await executeRun(runId);

		expect(mocks.runContainer).not.toHaveBeenCalled();
		expectTransition(['queued', 'preparing', 'running', 'awaiting_input'], 'failed');
		expect(mocks.runUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ error: 'node_modules missing' })
			})
		);
	});

	it('stores Claude session transcripts in the persisted workspace state', async () => {
		setupRun();
		mocks.runContainer.mockResolvedValue({ exitCode: 0, timedOut: false });

		await executeRun(runId);

		expect(mocks.buildRunArgs).toHaveBeenCalledWith(
			expect.objectContaining({
				env: expect.objectContaining({
					RUN_AGENT: 'claude',
					CLAUDE_CONFIG_DIR: '/workspace/.dotweaver/claude-config'
				})
			})
		);
	});

	it('starts Codex runs with Codex credentials and without Claude credentials', async () => {
		setupRun({ agent: 'codex', model: 'gpt-5.5' });
		mocks.privateEnv.CODEX_API_KEY = 'codex-key';
		mocks.runContainer.mockResolvedValue({ exitCode: 0, timedOut: false });

		await executeRun(runId);

		expect(mocks.buildRunArgs).toHaveBeenCalledWith(
			expect.objectContaining({
				env: expect.objectContaining({
					RUN_PROMPT: 'do it',
					RUN_AGENT: 'codex',
					RUN_MODEL: 'gpt-5.5',
					CODEX_API_KEY: 'codex-key'
				})
			})
		);
		expect(mocks.buildRunArgs).toHaveBeenCalledWith(
			expect.objectContaining({
				env: expect.not.objectContaining({
					CLAUDE_CODE_OAUTH_TOKEN: expect.any(String)
				})
			})
		);
	});

	it('uses the local Codex auth cache for Codex runs when no explicit credential is set', async () => {
		setupRun({ agent: 'codex', model: 'gpt-5.5' });
		mocks.privateEnv.CODEX_AUTH_JSON_PATH = '/home/me/.codex/auth.json';
		mocks.existsSync.mockImplementation((path: string) => path === '/home/me/.codex/auth.json');
		mocks.runContainer.mockResolvedValue({ exitCode: 0, timedOut: false });

		await executeRun(runId);

		expect(mocks.buildRunArgs).toHaveBeenCalledWith(
			expect.objectContaining({
				mounts: [
					{
						source: '/home/me/.codex/auth.json',
						target: '/runner/codex-auth/auth.json',
						readOnly: true
					}
				],
				env: expect.objectContaining({
					RUN_AGENT: 'codex',
					CODEX_AUTH_JSON_SOURCE: '/runner/codex-auth/auth.json'
				})
			})
		);
		expect(mocks.buildRunArgs).toHaveBeenCalledWith(
			expect.objectContaining({
				env: expect.not.objectContaining({
					CODEX_API_KEY: expect.any(String),
					CODEX_ACCESS_TOKEN: expect.any(String),
					CLAUDE_CODE_OAUTH_TOKEN: expect.any(String)
				})
			})
		);
	});

	it('skips materialization when project agent config is disabled but stores the disabled snapshot', async () => {
		setupRun({ useProjectAgentConfig: false });
		const disabledConfig = emptyRuntimeAgentConfig(false);
		mocks.buildRunAgentConfig.mockResolvedValue(disabledConfig);
		mocks.runContainer.mockResolvedValue({ exitCode: 0, timedOut: false });

		await executeRun(runId);

		expect(mocks.buildRunAgentConfig).toHaveBeenCalledWith('org1', 'p1', {
			useProjectAgentConfig: false
		});
		expect(mocks.materializeRunAgentConfig).not.toHaveBeenCalled();
		expect(mocks.buildRunArgs).toHaveBeenCalledWith(
			expect.objectContaining({
				env: expect.not.objectContaining({
					DOTWEAVER_MCP_LINEAR_TOKEN: expect.any(String)
				})
			})
		);
		expect(mocks.runContainer).toHaveBeenCalled();
		expect(mocks.runUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: runId, status: { in: ['preparing'] } },
				data: expect.objectContaining({
					status: 'running',
					baseCommitSha: 'base',
					agentConfigSnapshot: disabledConfig.snapshot
				})
			})
		);
	});

	it('fails without starting Docker when building project agent config fails', async () => {
		setupRun();
		mocks.buildRunAgentConfig.mockRejectedValue(new Error('missing secret'));

		await executeRun(runId);

		expect(mocks.runContainer).not.toHaveBeenCalled();
		expectTransition(['queued', 'preparing', 'running', 'awaiting_input'], 'failed');
		expect(mocks.runUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ error: 'missing secret' })
			})
		);
	});

	it('creates the run checkout from the captured base branch', async () => {
		setupRun();
		mocks.runContainer.mockResolvedValue({ exitCode: 0, timedOut: false });

		await executeRun(runId);

		expect(mocks.createRunCheckout).toHaveBeenCalledWith('p1', runId, 'feature/login', undefined);
	});

	it('pauses on interaction_request, appends interactionId, sends the answered response, and resumes', async () => {
		setupRun();
		mocks.createPendingRunInteraction.mockResolvedValue({ id: 'i1' });
		const response: SerializedAskUserQuestionResponse = {
			answers: { 'Which layout?': 'Compact' },
			response: 'Use compact mode'
		};
		const answer = deferred<SerializedAskUserQuestionResponse>();
		mocks.waitForRunInteractionAnswer.mockReturnValue(answer.promise);
		const send = deferred();
		const sendControlMessage = vi.fn<RunContainerControl['sendControlMessage']>(() => send.promise);

		mocks.runContainer.mockImplementation(
			async (_args: string[], onLine: RunContainerLineHandler) => {
				const lineHandled = Promise.resolve(
					onLine(JSON.stringify(interactionRequest), { sendControlMessage })
				).catch(() => {});

				await vi.waitFor(() =>
					expect(mocks.waitForRunInteractionAnswer).toHaveBeenCalledWith(
						'i1',
						expect.objectContaining({ signal: expect.any(AbortSignal) })
					)
				);
				expectTransition(['running'], 'awaiting_input');
				void lineHandled;

				return { exitCode: 0, timedOut: false };
			}
		);

		const executing = executeRun(runId);

		await vi.waitFor(() =>
			expect(mocks.waitForRunInteractionAnswer).toHaveBeenCalledWith(
				'i1',
				expect.objectContaining({ signal: expect.any(AbortSignal) })
			)
		);
		expect(sendControlMessage).not.toHaveBeenCalled();
		expect(await hasSettled(executing)).toBe(false);
		expect(mocks.getHeadSha).not.toHaveBeenCalled();
		expectNoTransition(['running'], 'awaiting_review');

		answer.resolve(response);
		await vi.waitFor(() =>
			expect(sendControlMessage).toHaveBeenCalledWith({
				type: 'interaction_response',
				toolUseId: 'toolu_1',
				response
			})
		);
		expect(await hasSettled(executing)).toBe(false);
		expect(mocks.getHeadSha).not.toHaveBeenCalled();
		expectNoTransition(['running'], 'awaiting_review');
		expectNoAwaitingInputResume();

		send.resolve();
		await executing;

		expect(mocks.createPendingRunInteraction).toHaveBeenCalledWith({
			runId,
			toolUseId: 'toolu_1',
			request
		});
		expect(mocks.appendRunEvent).toHaveBeenCalledWith(
			runId,
			0,
			expect.objectContaining({
				type: 'interaction_request',
				toolUseId: 'toolu_1',
				interactionId: 'i1'
			})
		);
		expectTransition(['awaiting_input'], 'running');
		expectTransition(['running'], 'awaiting_review');
	});

	it('sends a best-effort Poke notification after creating a pending interaction', async () => {
		setupRun();
		mocks.createPendingRunInteraction.mockResolvedValue({ id: 'i1' });
		const answer = deferred<SerializedAskUserQuestionResponse>();
		mocks.waitForRunInteractionAnswer.mockReturnValue(answer.promise);
		const sendControlMessage = vi.fn<RunContainerControl['sendControlMessage']>();
		sendControlMessage.mockResolvedValue(undefined);

		mocks.runContainer.mockImplementation(
			async (_args: string[], onLine: RunContainerLineHandler) => {
				await onLine(JSON.stringify(interactionRequest), { sendControlMessage });
				answer.resolve({ answers: { 'Which layout?': 'Compact' } });
				return { exitCode: 0, timedOut: false };
			}
		);

		await executeRun(runId);

		expect(mocks.sendPokeQuestionNotification).toHaveBeenCalledWith({
			userId: 'u1',
			runId,
			interactionId: 'i1',
			projectLabel: 'acme/repo',
			request
		});
	});

	it('does not fail the run when Poke notification fails', async () => {
		setupRun();
		mocks.createPendingRunInteraction.mockResolvedValue({ id: 'i1' });
		mocks.sendPokeQuestionNotification.mockRejectedValue(new Error('poke down'));
		mocks.waitForRunInteractionAnswer.mockResolvedValue({
			answers: { 'Which layout?': 'Compact' }
		});
		const sendControlMessage = vi.fn<RunContainerControl['sendControlMessage']>();
		sendControlMessage.mockResolvedValue(undefined);

		mocks.runContainer.mockImplementation(
			async (_args: string[], onLine: RunContainerLineHandler) => {
				await onLine(JSON.stringify(interactionRequest), { sendControlMessage });
				return { exitCode: 0, timedOut: false };
			}
		);

		await executeRun(runId);

		expectTransition(['running'], 'awaiting_review');
		expect(mocks.runUpdateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ error: 'poke down' }) })
		);
	});

	it('aborts outstanding interaction waits and cancels pending interactions when the container times out', async () => {
		setupRun();
		mocks.createPendingRunInteraction.mockResolvedValue({ id: 'i1' });
		let waitSignal: AbortSignal | undefined;
		mocks.waitForRunInteractionAnswer.mockImplementation(
			(_interactionId: string, opts: { signal?: AbortSignal }) => {
				waitSignal = opts.signal;
				return new Promise<SerializedAskUserQuestionResponse>((_resolve, reject) => {
					opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
						once: true
					});
				});
			}
		);
		const sendControlMessage = vi.fn<RunContainerControl['sendControlMessage']>();
		sendControlMessage.mockResolvedValue(undefined);

		mocks.runContainer.mockImplementation(
			async (_args: string[], onLine: RunContainerLineHandler) => {
				const lineHandled = Promise.resolve(
					onLine(JSON.stringify(interactionRequest), { sendControlMessage })
				).catch(() => {});

				await vi.waitFor(() => expect(mocks.waitForRunInteractionAnswer).toHaveBeenCalled());
				void lineHandled;

				return { exitCode: 137, timedOut: true };
			}
		);

		await executeRun(runId);

		expect(waitSignal?.aborted).toBe(true);
		expect(mocks.cancelPendingRunInteractions).toHaveBeenCalledWith(runId);
		expectTransition(['running', 'awaiting_input'], 'timed_out');
	});

	it('does not let a pending answer wait block non-zero cleanup after interaction_request', async () => {
		setupRun();
		mocks.createPendingRunInteraction.mockResolvedValue({ id: 'i1' });
		let lineHandlerSettledBeforeExit = false;
		let waitSignal: AbortSignal | undefined;
		mocks.waitForRunInteractionAnswer.mockImplementation(
			(_interactionId: string, opts: { signal?: AbortSignal }) => {
				waitSignal = opts.signal;
				return new Promise<SerializedAskUserQuestionResponse>((_resolve, reject) => {
					opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
						once: true
					});
				});
			}
		);
		const sendControlMessage = vi.fn<RunContainerControl['sendControlMessage']>();
		sendControlMessage.mockResolvedValue(undefined);

		mocks.runContainer.mockImplementation(
			async (_args: string[], onLine: RunContainerLineHandler) => {
				const lineHandled = Promise.resolve(
					onLine(JSON.stringify(interactionRequest), { sendControlMessage })
				).catch(() => {});

				await vi.waitFor(() => expect(mocks.waitForRunInteractionAnswer).toHaveBeenCalled());
				lineHandlerSettledBeforeExit = await hasSettled(lineHandled);

				return { exitCode: 2, timedOut: false };
			}
		);

		await executeRun(runId);

		expect(lineHandlerSettledBeforeExit).toBe(true);
		expect(waitSignal?.aborted).toBe(true);
		expect(mocks.cancelPendingRunInteractions).toHaveBeenCalledWith(runId);
		expectTransition(['running', 'awaiting_input'], 'failed');
		expect(mocks.runUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ error: 'Container exited with code 2' })
			})
		);
	});

	it('cancels pending interactions when the container exits non-zero', async () => {
		setupRun();
		mocks.runContainer.mockResolvedValue({ exitCode: 2, timedOut: false });

		await executeRun(runId);

		expect(mocks.cancelPendingRunInteractions).toHaveBeenCalledWith(runId);
		expectTransition(['running', 'awaiting_input'], 'failed');
		expect(mocks.runUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ error: 'Container exited with code 2' })
			})
		);
	});

	it('cancels pending interactions when runContainer rejects after creating an interaction', async () => {
		setupRun();
		mocks.createPendingRunInteraction.mockResolvedValue({ id: 'i1' });
		mocks.waitForRunInteractionAnswer.mockImplementation(
			(_interactionId: string, opts: { signal?: AbortSignal }) =>
				new Promise<SerializedAskUserQuestionResponse>((_resolve, reject) => {
					opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
						once: true
					});
				})
		);
		const sendControlMessage = vi.fn<RunContainerControl['sendControlMessage']>();
		sendControlMessage.mockResolvedValue(undefined);

		mocks.runContainer.mockImplementation(
			async (_args: string[], onLine: RunContainerLineHandler) => {
				const lineHandled = Promise.resolve(
					onLine(JSON.stringify(interactionRequest), { sendControlMessage })
				).catch(() => {});

				await vi.waitFor(() => expect(mocks.waitForRunInteractionAnswer).toHaveBeenCalled());
				void lineHandled;
				throw new Error('container failed');
			}
		);

		await executeRun(runId);

		expect(mocks.cancelPendingRunInteractions).toHaveBeenCalledWith(runId);
		expectTransition(['queued', 'preparing', 'running', 'awaiting_input'], 'failed');
		expect(mocks.runUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ error: 'container failed' })
			})
		);
	});

	it('cancels timed-out interactions after delayed interaction creation resolves', async () => {
		setupRun();
		const create = deferred<{ id: string }>();
		let createResolved = false;
		let cancelRanAfterCreate = false;
		mocks.createPendingRunInteraction.mockReturnValue(create.promise);
		mocks.waitForRunInteractionAnswer.mockImplementation(
			(_interactionId: string, opts: { signal?: AbortSignal }) => {
				if (opts.signal?.aborted) return Promise.reject(new Error('aborted'));
				return new Promise<SerializedAskUserQuestionResponse>((_resolve, reject) => {
					opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
						once: true
					});
				});
			}
		);
		mocks.cancelPendingRunInteractions.mockImplementation(async () => {
			cancelRanAfterCreate = createResolved;
			return { count: 1 };
		});
		const sendControlMessage = vi.fn<RunContainerControl['sendControlMessage']>();
		sendControlMessage.mockResolvedValue(undefined);

		mocks.runContainer.mockImplementation(
			async (_args: string[], onLine: RunContainerLineHandler) => {
				const lineHandled = Promise.resolve(
					onLine(JSON.stringify(interactionRequest), { sendControlMessage })
				).catch(() => {});

				await vi.waitFor(() => expect(mocks.createPendingRunInteraction).toHaveBeenCalled());
				void lineHandled;

				return { exitCode: 137, timedOut: true };
			}
		);

		const executing = executeRun(runId);

		await vi.waitFor(() => expect(mocks.createPendingRunInteraction).toHaveBeenCalled());
		await Promise.resolve();
		await Promise.resolve();
		expect(mocks.cancelPendingRunInteractions).not.toHaveBeenCalled();

		createResolved = true;
		create.resolve({ id: 'i1' });
		await executing;

		expect(cancelRanAfterCreate).toBe(true);
		expect(mocks.cancelPendingRunInteractions).toHaveBeenCalledWith(runId);
		expectTransition(['running', 'awaiting_input'], 'timed_out');
	});

	it('resumes an awaiting_review run from the existing checkout without re-cloning', async () => {
		mocks.runFindUnique.mockResolvedValue({
			id: runId,
			createdById: 'u1',
			organizationId: 'org1',
			prompt: 'initial prompt',
			agent: 'claude',
			pendingPrompt: 'please continue',
			sessionId: 'sess-1',
			baseBranch: 'main',
			baseCommitSha: 'base-sha',
			model: null,
			useProjectAgentConfig: false,
			environmentSnapshot: {
				enabled: true,
				profileId: 'env1',
				runtime: 'node',
				packageManager: 'bun',
				installCommand: 'bun install',
				currentFingerprint: 'fp1',
				needsPrepare: false
			},
			timeoutAt: null,
			project: { id: 'p1', cloneUrl: 'https://example.com/repo.git' }
		});
		mocks.runUpdateMany.mockResolvedValue({ count: 1 });
		mocks.getNextEventSeq.mockResolvedValue(9);
		mocks.workspaceRoot.mockReturnValue('/workspace-root');
		mocks.runWorktreePath.mockReturnValue('/workspace-root/p1/r1');
		mocks.existsSync.mockReturnValue(true);
		mocks.buildRunAgentConfig.mockResolvedValue({ secretEnv: {}, snapshot: {} });
		mocks.buildRunEnvironmentConfig.mockRejectedValue(
			new Error('Environment profile default is invalid')
		);
		mocks.buildRunArgs.mockReturnValue(['arg']);
		mocks.containerName.mockReturnValue('dotweaver-run-r1');
		mocks.getHeadSha.mockResolvedValue('new-head');
		mocks.appendRunEvent.mockResolvedValue(undefined);
		mocks.cancelPendingRunInteractions.mockResolvedValue({ count: 0 });
		mocks.runContainer.mockImplementation(
			async (_args: string[], onLine: RunContainerLineHandler) => {
				await onLine(JSON.stringify({ type: 'assistant', message: { content: [] } }), {
					sendControlMessage: vi.fn()
				});
				return { exitCode: 0, timedOut: false };
			}
		);

		await executeRun(runId);

		expect(mocks.appendRunEvent).toHaveBeenCalledWith(
			runId,
			9,
			expect.objectContaining({ type: 'assistant' })
		);
		// Pas de clone/mirror en resume.
		expect(mocks.ensureMirror).not.toHaveBeenCalled();
		expect(mocks.createRunCheckout).not.toHaveBeenCalled();
		expect(mocks.buildRunEnvironmentConfig).not.toHaveBeenCalled();
		expect(mocks.prepareRunEnvironmentIfNeeded).not.toHaveBeenCalled();
		// Le container tourne sur le checkout conservé avec le bon prompt/session.
		expect(mocks.buildRunArgs).toHaveBeenCalledWith(
			expect.objectContaining({
				workspacePath: '/workspace-root/p1/r1',
				mounts: expect.arrayContaining([
					{
						source: '/workspace-root/p1/cache/default/node/bun/install',
						target: '/root/.bun/install/cache'
					}
				]),
				env: expect.objectContaining({
					RUN_PROMPT: 'please continue',
					RUN_RESUME_SESSION: 'sess-1',
					CLAUDE_CONFIG_DIR: '/workspace/.dotweaver/claude-config'
				})
			})
		);
		// Transition queued -> running avec effacement du pendingPrompt.
		expect(mocks.runUpdateMany).toHaveBeenCalledWith({
			where: { id: runId, status: { in: ['queued'] } },
			data: { pendingPrompt: null, status: 'running' }
		});
		// Retour en awaiting_review en fin de tour.
		expect(mocks.runUpdateMany).toHaveBeenCalledWith({
			where: { id: runId, status: { in: ['running'] } },
			data: expect.objectContaining({ status: 'awaiting_review', headCommitSha: 'new-head' })
		});
	});

	it('can fail an awaiting_input run when the container handler throws', async () => {
		setupRun();
		mocks.runContainer.mockRejectedValue(new Error('handler failed'));

		await executeRun(runId);

		expect(mocks.cancelPendingRunInteractions).toHaveBeenCalledWith(runId);
		expectTransition(['queued', 'preparing', 'running', 'awaiting_input'], 'failed');
		expect(mocks.runUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ error: 'handler failed' })
			})
		);
	});
});
