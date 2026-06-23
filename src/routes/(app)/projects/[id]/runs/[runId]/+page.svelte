<script lang="ts">
	import { page } from '$app/state';
	import { SvelteMap } from 'svelte/reactivity';
	import {
		getRun,
		getRunDiff,
		approveRun,
		cancelRun,
		answerRunInteraction,
		replyToRun
	} from '$lib/rfc/runs.remote';
	import RunHeader from '$lib/components/runs/RunHeader.svelte';
	import RunReviewPanel from '$lib/components/runs/RunReviewPanel.svelte';
	import RunTimeline from '$lib/components/runs/RunTimeline.svelte';
	import AskUserQuestionCard from '$lib/components/runs/AskUserQuestionCard.svelte';
	import CurrentTodos from '$lib/components/runs/CurrentTodos.svelte';
	import {
		normalizeTimelineEntries,
		type DisplayTimelineEvent
	} from '$lib/components/runs/run-event-display';
	import { extractCurrentTodos } from '$lib/components/runs/todos';
	import { RUN_STATUS, isCancelableRunStatus, isStreamableRunStatus } from '$lib/domain/run-status';

	type ActiveInteraction = {
		id: string;
		request: {
			questions: Array<{
				question: string;
				header: string;
				options: Array<{ label: string; description: string; preview?: string }>;
				multiSelect: boolean;
			}>;
		};
	};
	type LiveRunEvent = { runId: string; seq: number; payload: unknown };
	type RunUiState = {
		busy: boolean;
		actionError: string | null;
		prUrl: string | null;
		canceling: boolean;
		answering: boolean;
		answerError: string | null;
		replying: boolean;
		replyError: string | null;
	};

	const defaultUiState: RunUiState = {
		busy: false,
		actionError: null,
		prUrl: null,
		canceling: false,
		answering: false,
		answerError: null,
		replying: false,
		replyError: null
	};

	const currentRunId = $derived(page.params.runId!);
	const run = $derived(getRun(currentRunId));
	const isReview = $derived(run.current?.status === RUN_STATUS.AWAITING_REVIEW);
	const shouldStreamRun = $derived.by(() => {
		const status = run.current?.status;
		return !!status && isStreamableRunStatus(status);
	});
	const diff = $derived(isReview ? getRunDiff(currentRunId) : undefined);

	let uiStates = $state<Record<string, RunUiState>>({});
	const ui = $derived(uiStates[currentRunId] ?? defaultUiState);
	let replyText = $state('');

	function setRunUiState(runId: string, patch: Partial<RunUiState>) {
		uiStates = {
			...uiStates,
			[runId]: {
				...(uiStates[runId] ?? defaultUiState),
				...patch
			}
		};
	}

	async function cancel() {
		const runId = currentRunId;
		setRunUiState(runId, { canceling: true });
		try {
			await cancelRun(runId);
		} catch {
			/* surfaced via run.error on refresh */
		} finally {
			setRunUiState(runId, { canceling: false });
		}
	}

	const liveEvents = new SvelteMap<string, LiveRunEvent>();

	function liveEventKey(runId: string, seq: number) {
		return `${runId}:${seq}`;
	}

	function clearLiveEventsForRun(runId: string) {
		for (const [key, event] of liveEvents) {
			if (event.runId === runId) liveEvents.delete(key);
		}
	}

	function isInteractionRequest(payload: unknown): payload is { type: 'interaction_request' } {
		return (
			!!payload &&
			typeof payload === 'object' &&
			'type' in payload &&
			payload.type === 'interaction_request'
		);
	}

	class RunEventSource {
		private readonly es: EventSource;
		private readonly runId: string;
		private readonly events: SvelteMap<string, LiveRunEvent>;

		constructor(runId: string, events: SvelteMap<string, LiveRunEvent>) {
			this.runId = runId;
			this.events = events;
			this.es = new EventSource(`/api/runs/${runId}/events`);
			this.es.onmessage = this.handleMessage;
			this.es.addEventListener('done', this.handleDone);
			this.es.onerror = this.handleError;
		}

		private handleMessage = (event: MessageEvent<string>) => {
			const seq = Number(event.lastEventId);
			const key = liveEventKey(this.runId, seq);
			if (this.events.has(key)) return;
			let payload: unknown = event.data;
			try {
				payload = JSON.parse(event.data);
			} catch {
				/* garde le texte brut */
			}
			if (isInteractionRequest(payload)) {
				getRun(this.runId).refresh();
			}
			this.events.set(key, { runId: this.runId, seq, payload });
		};

		private handleDone = () => {
			this.es.close();
			getRun(this.runId).refresh();
		};

		private handleError = () => {
			/* EventSource se reconnecte tout seul ; replay idempotent par seq */
		};

		readonly dispose = () => {
			this.es.close();
		};
	}

	$effect(() => {
		if (!shouldStreamRun) return;
		const eventSource = new RunEventSource(currentRunId, liveEvents);
		return eventSource.dispose;
	});

	async function act(action: 'push_pr' | 'push' | 'abandon') {
		const runId = currentRunId;
		setRunUiState(runId, { actionError: null, busy: true });
		try {
			const res = await approveRun({ runId, action });
			setRunUiState(runId, { prUrl: res.pullRequestUrl ?? null });
		} catch (e) {
			setRunUiState(runId, { actionError: e instanceof Error ? e.message : 'Action failed' });
		} finally {
			setRunUiState(runId, { busy: false });
		}
	}

	function scheduleResumeRefresh(runId: string) {
		for (const delay of [150, 400, 900, 1600]) {
			setTimeout(() => {
				if (currentRunId === runId) getRun(runId).refresh();
			}, delay);
		}
	}

	async function answerInteraction(
		interactionId: string,
		answers: Record<string, { selected: string[]; otherText?: string }>
	) {
		const runId = currentRunId;
		setRunUiState(runId, { answering: true, answerError: null });
		try {
			await answerRunInteraction({ interactionId, answers });
			clearLiveEventsForRun(runId);
			await getRun(runId).refresh();
			scheduleResumeRefresh(runId);
		} catch (e) {
			setRunUiState(runId, {
				answerError: e instanceof Error ? e.message : 'Could not answer the interaction'
			});
		} finally {
			setRunUiState(runId, { answering: false });
		}
	}

	async function sendReply() {
		const runId = currentRunId;
		const message = replyText.trim();
		if (!message) return;
		setRunUiState(runId, { replying: true, replyError: null });
		try {
			await replyToRun({ runId, message });
			replyText = '';
			clearLiveEventsForRun(runId);
			await getRun(runId).refresh();
			scheduleResumeRefresh(runId);
		} catch (e) {
			setRunUiState(runId, {
				replyError: e instanceof Error ? e.message : 'Could not send your reply'
			});
		} finally {
			setRunUiState(runId, { replying: false });
		}
	}

	const eventTimeline = $derived.by<Array<{ seq: number; payload: unknown }>>(() => {
		const eventsBySeq: Record<string, { seq: number; payload: unknown }> = {};
		for (const event of run.current?.events ?? []) {
			eventsBySeq[event.seq] = { seq: event.seq, payload: event.payload };
		}
		for (const event of liveEvents.values()) {
			if (event.runId !== currentRunId) continue;
			eventsBySeq[event.seq] = { seq: event.seq, payload: event.payload };
		}
		return Object.values(eventsBySeq)
			.sort((a, b) => a.seq - b.seq)
			.map((event) => ({ seq: event.seq, payload: event.payload }));
	});
	const currentTodos = $derived(extractCurrentTodos(eventTimeline));
	const activeInteraction = $derived(
		(run.current?.interactions?.[0] ?? null) as ActiveInteraction | null
	);

	const displayEvents = $derived.by<DisplayTimelineEvent[]>(() => {
		return normalizeTimelineEntries(
			eventTimeline.map((event) => ({ key: event.seq, payload: event.payload }))
		).filter((item) => item.event.kind !== 'hidden');
	});
</script>

<svelte:head>
	<title>Run | dotWeaver</title>
</svelte:head>

<div class="mx-auto max-w-7xl p-4 sm:p-6">
	<div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
		<main class="min-w-0 space-y-4">
			{#if run.error}
				<p class="text-sm text-destructive">{run.error.message}</p>
			{:else if run.current}
				<div class="flex items-center justify-between gap-3">
					<a
						href={`/projects/${page.params.id}`}
						class="text-sm text-muted-foreground hover:text-foreground"
					>
						<span aria-hidden="true">&larr;</span> Project
					</a>
				</div>

				<RunHeader
					run={run.current}
					cancelable={isCancelableRunStatus(run.current.status)}
					canceling={ui.canceling}
					oncancel={cancel}
				/>

				{#if run.current.error}
					<p
						class="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
					>
						{run.current.error}
					</p>
				{/if}

				{#if ui.prUrl}
					<p class="rounded-lg border bg-card p-3 text-sm">
						Pull request: <a href={ui.prUrl} target="_blank" rel="noreferrer" class="underline"
							>{ui.prUrl}</a
						>
					</p>
				{/if}

				{#if isReview}
					<RunReviewPanel
						files={diff?.current?.files ?? null}
						patch={diff?.current?.patch ?? null}
						truncated={diff?.current?.truncated ?? false}
						diffError={diff?.error?.message ?? null}
						loading={!diff?.current && !diff?.error}
						actionError={ui.actionError}
						busy={ui.busy}
						bind:replyText
						replying={ui.replying}
						replyError={ui.replyError}
						canReply={!!run.current.sessionId}
						onact={act}
						onsendreply={sendReply}
					/>
				{/if}

				<section class="rounded-xl border bg-card shadow-sm">
					<div class="border-b px-4 py-3">
						<h2 class="text-sm font-semibold">Prompt</h2>
					</div>
					<pre class="p-4 text-xs whitespace-pre-wrap text-muted-foreground">{run.current
							.prompt}</pre>
				</section>

				<RunTimeline events={displayEvents} />
			{:else}
				<p class="text-sm text-muted-foreground">Loading run…</p>
			{/if}
		</main>

		{#if run.current}
			<aside class="space-y-4 lg:sticky lg:top-4 lg:self-start">
				{#if activeInteraction}
					<AskUserQuestionCard
						interaction={activeInteraction}
						busy={ui.answering}
						error={ui.answerError}
						onsubmit={(answers) => answerInteraction(activeInteraction.id, answers)}
					/>
				{/if}
				<CurrentTodos todos={currentTodos} />
			</aside>
		{/if}
	</div>
</div>
