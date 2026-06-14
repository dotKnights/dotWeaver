<script lang="ts">
	import { page } from '$app/state';
	import { SvelteMap } from 'svelte/reactivity';
	import {
		getRun,
		getRunDiff,
		approveRun,
		cancelRun,
		answerRunInteraction
	} from '$lib/rfc/runs.remote';
	import { Button } from '$lib/components/ui/button';
	import RunEvent from '$lib/components/runs/RunEvent.svelte';
	import AskUserQuestionCard from '$lib/components/runs/AskUserQuestionCard.svelte';
	import CurrentTodos from '$lib/components/runs/CurrentTodos.svelte';
	import { normalizeEvent, type DisplayEvent } from '$lib/components/runs/run-event-display';
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
	};

	const defaultUiState: RunUiState = {
		busy: false,
		actionError: null,
		prUrl: null,
		canceling: false,
		answering: false,
		answerError: null
	};

	const currentRunId = $derived(page.params.runId!);
	const run = $derived(getRun(currentRunId));
	const isReview = $derived(run.current?.status === RUN_STATUS.AWAITING_REVIEW);
	const diff = $derived(isReview ? getRunDiff(currentRunId) : undefined);

	let uiStates = $state<Record<string, RunUiState>>({});
	const ui = $derived(uiStates[currentRunId] ?? defaultUiState);

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

	$effect(() => {
		const status = run.current?.status;
		if (!status || !isStreamableRunStatus(status)) return;
		const runId = currentRunId;
		const es = new EventSource(`/api/runs/${runId}/events`);
		es.onmessage = (e) => {
			const seq = Number(e.lastEventId);
			const key = liveEventKey(runId, seq);
			if (liveEvents.has(key)) return;
			let payload: unknown = e.data;
			try {
				payload = JSON.parse(e.data);
			} catch {
				/* garde le texte brut */
			}
			if (isInteractionRequest(payload) || run.current?.status === RUN_STATUS.AWAITING_INPUT) {
				getRun(runId).refresh();
			}
			liveEvents.set(key, { runId, seq, payload });
		};
		es.addEventListener('done', () => {
			es.close();
			getRun(runId).refresh();
		});
		es.onerror = () => {
			/* EventSource se reconnecte tout seul ; replay idempotent par seq */
		};
		return () => es.close();
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

	const eventTimeline = $derived.by<Array<{ payload: unknown }>>(() => {
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
			.map((event) => ({ payload: event.payload }));
	});
	const currentTodos = $derived(extractCurrentTodos(eventTimeline));
	const activeInteraction = $derived(
		(run.current?.interactions?.[0] ?? null) as ActiveInteraction | null
	);

	const displayEvents = $derived.by<DisplayEvent[]>(() => {
		const source = eventTimeline.map((event) => event.payload);
		return source.flatMap((p) => normalizeEvent(p)).filter((e) => e.kind !== 'hidden');
	});
</script>

<div class="mx-auto grid max-w-6xl gap-4 p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
	<main class="space-y-4">
		{#if run.error}
			<p class="text-sm text-red-500">{run.error.message}</p>
		{:else if run.current}
			<div class="flex items-center justify-between">
				<h1 class="text-xl font-semibold">Run</h1>
				<a href={`/projects/${page.params.id}`} class="text-sm hover:underline">← Project</a>
			</div>
			<dl class="grid grid-cols-2 gap-2 text-sm">
				<dt class="text-muted-foreground">Status</dt>
				<dd>{run.current.status}</dd>
				<dt class="text-muted-foreground">Model</dt>
				<dd>{run.current.model ?? 'default'}</dd>
				<dt class="text-muted-foreground">Base branch</dt>
				<dd>{run.current.baseBranch}</dd>
				<dt class="text-muted-foreground">Agent branch</dt>
				<dd>{run.current.agentBranch}</dd>
			</dl>
			{#if run.current.error}
				<p class="text-sm text-red-500">{run.current.error}</p>
			{/if}

			{#if isCancelableRunStatus(run.current.status)}
				<button
					onclick={cancel}
					disabled={ui.canceling}
					class="rounded-md border px-3 py-1 text-sm hover:bg-accent"
				>
					{ui.canceling ? 'Canceling…' : 'Cancel run'}
				</button>
			{/if}

			{#if ui.prUrl}
				<p class="text-sm">
					Pull request: <a href={ui.prUrl} target="_blank" rel="noreferrer" class="underline"
						>{ui.prUrl}</a
					>
				</p>
			{/if}

			{#if isReview}
				<section class="space-y-2">
					<h2 class="text-sm font-medium">Review changes</h2>
					{#if ui.actionError}
						<p class="text-sm text-red-500">{ui.actionError}</p>
					{/if}
					{#if diff?.error}
						<p class="text-sm text-red-500">Could not load the diff: {diff.error.message}</p>
					{:else if diff?.current}
						<ul class="text-xs">
							{#each diff.current.files as f (f.path)}
								<li class="flex justify-between border-b py-1">
									<span class="font-mono">{f.status} {f.path}</span>
									<span class="text-muted-foreground"
										>+{f.additions ?? '?'} -{f.deletions ?? '?'}</span
									>
								</li>
							{/each}
						</ul>
						{#if diff.current.files.length > 0}
							<pre class="max-h-96 overflow-auto rounded-md border bg-muted/30 p-2 text-xs">{diff
									.current.patch}{diff.current.truncated ? '\n… (diff tronqué)' : ''}</pre>
						{:else}
							<p class="text-sm text-muted-foreground">No changes in this run.</p>
						{/if}
						<div class="flex gap-2">
							{#if diff.current.files.length > 0}
								<Button onclick={() => act('push_pr')} disabled={ui.busy}>Push & PR</Button>
								<Button variant="outline" onclick={() => act('push')} disabled={ui.busy}
									>Push branch</Button
								>
							{/if}
							<Button variant="outline" onclick={() => act('abandon')} disabled={ui.busy}
								>Abandon</Button
							>
						</div>
					{:else}
						<p class="text-sm text-muted-foreground">Loading diff…</p>
					{/if}
				</section>
			{/if}

			<div>
				<h2 class="mb-1 text-sm font-medium">Prompt</h2>
				<pre class="rounded-md border p-2 text-xs whitespace-pre-wrap">{run.current.prompt}</pre>
			</div>
			<div>
				<h2 class="mb-1 text-sm font-medium">Events</h2>
				{#if displayEvents.length === 0}
					<p class="text-sm text-muted-foreground">No events yet.</p>
				{:else}
					<ul class="space-y-2">
						{#each displayEvents as event, i (i)}
							<li><RunEvent {event} /></li>
						{/each}
					</ul>
				{/if}
			</div>
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
