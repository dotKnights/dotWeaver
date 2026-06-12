import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunContainerControl, RunContainerLineHandler } from './docker';
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
	cancelPendingRunInteractions: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
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
	appendRunEvent: mocks.appendRunEvent
}));
vi.mock('$lib/server/github-git', () => ({
	authedCloneUrl: mocks.authedCloneUrl,
	getGithubTokenForUser: mocks.getGithubTokenForUser,
	makeGitAuth: mocks.makeGitAuth
}));
vi.mock('$lib/server/workspace-paths', () => ({
	containerName: mocks.containerName
}));
vi.mock('$lib/server/run-interactions-service', () => ({
	createPendingRunInteraction: mocks.createPendingRunInteraction,
	waitForRunInteractionAnswer: mocks.waitForRunInteractionAnswer,
	cancelPendingRunInteractions: mocks.cancelPendingRunInteractions
}));

import { executeRun } from './run-orchestrator';

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

function setupRun() {
	mocks.runFindUnique.mockResolvedValue({
		id: runId,
		projectId: 'p1',
		createdById: 'u1',
		prompt: 'do it',
		model: null,
		sessionId: null,
		timeoutAt: new Date(Date.now() + 60_000),
		project: {
			id: 'p1',
			cloneUrl: 'https://github.com/acme/repo.git',
			defaultBranch: 'main'
		}
	});
	mocks.runUpdateMany.mockResolvedValue({ count: 1 });
	mocks.getGithubTokenForUser.mockResolvedValue(null);
	mocks.ensureMirror.mockResolvedValue(undefined);
	mocks.createRunCheckout.mockResolvedValue({ checkoutPath: '/checkout', baseSha: 'base' });
	mocks.getHeadSha.mockResolvedValue('head');
	mocks.appendRunEvent.mockResolvedValue(undefined);
	mocks.cancelPendingRunInteractions.mockResolvedValue({ count: 1 });
}

function expectTransition(callIndex: number, from: string[], status: string) {
	expect(mocks.runUpdateMany.mock.calls[callIndex]?.[0]).toMatchObject({
		where: { id: runId, status: { in: from } },
		data: { status }
	});
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
		mocks.buildRunArgs.mockReturnValue(['run', 'img']);
		mocks.authedCloneUrl.mockImplementation((url: string) => url);
		mocks.containerName.mockImplementation((id: string) => `dwrun-${id}`);
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
		const sendControlMessage = vi.fn<RunContainerControl['sendControlMessage']>(
			() => send.promise
		);

		mocks.runContainer.mockImplementation(
			async (_args: string[], onLine: RunContainerLineHandler) => {
				const lineHandled = Promise.resolve(
					onLine(JSON.stringify(interactionRequest), { sendControlMessage })
				);

				await vi.waitFor(() =>
					expect(mocks.waitForRunInteractionAnswer).toHaveBeenCalledWith(
						'i1',
						expect.objectContaining({ signal: expect.any(AbortSignal) })
					)
				);
				expect(sendControlMessage).not.toHaveBeenCalled();
				expectTransition(2, ['running'], 'awaiting_input');

				answer.resolve(response);
				await vi.waitFor(() =>
					expect(sendControlMessage).toHaveBeenCalledWith({
						type: 'interaction_response',
						toolUseId: 'toolu_1',
						response
					})
				);
				expectNoAwaitingInputResume();

				send.resolve();
				await lineHandled;
				expectTransition(3, ['awaiting_input'], 'running');

				return { exitCode: 0, timedOut: false };
			}
		);

		await executeRun(runId);

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
		expectTransition(4, ['running'], 'awaiting_review');
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
		expectTransition(3, ['running', 'awaiting_input'], 'timed_out');
	});

	it('cancels pending interactions when the container exits non-zero', async () => {
		setupRun();
		mocks.runContainer.mockResolvedValue({ exitCode: 2, timedOut: false });

		await executeRun(runId);

		expect(mocks.cancelPendingRunInteractions).toHaveBeenCalledWith(runId);
		expectTransition(2, ['running', 'awaiting_input'], 'failed');
		expect(mocks.runUpdateMany.mock.calls[2]?.[0]).toMatchObject({
			data: { error: 'Container exited with code 2' }
		});
	});

	it('can fail an awaiting_input run when the container handler throws', async () => {
		setupRun();
		mocks.runContainer.mockRejectedValue(new Error('handler failed'));

		await executeRun(runId);

		expectTransition(2, ['queued', 'preparing', 'running', 'awaiting_input'], 'failed');
		expect(mocks.runUpdateMany.mock.calls[2]?.[0]).toMatchObject({
			data: { error: 'handler failed' }
		});
	});
});
