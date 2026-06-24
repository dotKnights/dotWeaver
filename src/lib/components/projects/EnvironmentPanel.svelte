<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import type { ProjectEnvironmentProfileInput } from '$lib/schemas/project-environments';
	import { LoaderCircle, Play, RefreshCw, Settings2 } from '@lucide/svelte';
	import EnvironmentEditor from './EnvironmentEditor.svelte';

	type EnvironmentProfile = Record<string, unknown> & {
		id?: string | null;
		runtime?: string | null;
		packageManager?: string | null;
		status?: string | null;
		currentFingerprint?: string | null;
		lastPreparedFingerprint?: string | null;
		lastPrepareStatus?: string | null;
		lastPrepareError?: string | null;
		installCommand?: string | null;
		testCommand?: string | null;
		buildCommand?: string | null;
		devCommand?: string | null;
		warnings?: unknown;
	};

	type PrepareEvent = {
		id?: string | null;
		seq?: number | null;
		type?: string | null;
		payload?: unknown;
	};

	type BusyAction = 'detect' | 'prepare';

	type KeyedActionError = {
		key: string;
		message: string | null;
	};

	type KeyedQueuedPrepare = {
		key: string;
		queued: boolean;
	};

	type Props = {
		projectId: string;
		environment: EnvironmentProfile | null;
		prepareEvents?: PrepareEvent[];
		onDetect: (input: { projectId: string }) => Promise<unknown>;
		onSave: (input: ProjectEnvironmentProfileInput) => Promise<unknown>;
		onPrepare: (input: {
			projectId: string;
			profileId: string;
			force?: boolean;
		}) => Promise<unknown>;
	};

	let { projectId, environment, prepareEvents = [], onDetect, onSave, onPrepare }: Props = $props();

	let busyAction = $state<BusyAction | null>(null);
	let editing = $state(false);
	let actionErrorState = $state<KeyedActionError>({ key: '', message: null });
	let prepareQueue = $state<KeyedQueuedPrepare>({ key: '', queued: false });

	const status = $derived(environment?.status ?? 'unconfigured');
	const statusLabel = $derived(environment ? status : 'Not configured');
	const prepareStatus = $derived(environment?.lastPrepareStatus ?? 'never');
	const warnings = $derived.by(() => normalizeWarnings(environment?.warnings));
	const needsPrepare = $derived.by(() => computeNeedsPrepare(environment));
	const eventLines = $derived.by(() =>
		prepareEvents
			.map((event) => ({ ...event, label: eventLabel(event) }))
			.filter((event) => event.label.length > 0)
			.slice(-5)
	);
	const prepareStateKey = $derived(
		[
			projectId,
			environment?.id ?? '',
			environment?.lastPrepareStatus ?? '',
			environment?.lastPreparedFingerprint ?? '',
			environment?.currentFingerprint ?? ''
		].join(':')
	);
	const actionError = $derived(
		actionErrorState.key === prepareStateKey ? actionErrorState.message : null
	);
	const prepareQueued = $derived(prepareQueue.key === prepareStateKey && prepareQueue.queued);
	const preparePending = $derived(busyAction === 'prepare' || prepareStatus === 'running');
	const canPrepare = $derived(!!environment?.id && prepareStatus !== 'running' && !prepareQueued);

	async function runAction(kind: BusyAction, action: () => Promise<unknown>) {
		if (busyAction) return;
		setActionError(null);
		busyAction = kind;
		try {
			await action();
		} catch (e) {
			setActionError(e instanceof Error ? e.message : 'Environment action failed');
		} finally {
			busyAction = null;
		}
	}

	async function prepare() {
		if (!environment?.id || busyAction || prepareQueued) return;
		setActionError(null);
		busyAction = 'prepare';
		try {
			await onPrepare({ projectId, profileId: environment.id, force: false });
			prepareQueue = { key: prepareStateKey, queued: true };
		} catch (e) {
			setActionError(e instanceof Error ? e.message : 'Environment action failed');
		} finally {
			busyAction = null;
		}
	}

	function setActionError(message: string | null) {
		actionErrorState = { key: prepareStateKey, message };
	}

	function warningLabel(value: unknown): string {
		if (typeof value === 'string') return value;
		if (value === null || value === undefined) return '';
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}

	function normalizeWarnings(value: unknown): string[] {
		if (!Array.isArray(value)) return [];
		return value.map(warningLabel).filter(Boolean);
	}

	function computeNeedsPrepare(profile: EnvironmentProfile | null): boolean {
		if (!profile?.installCommand?.trim()) return false;
		if (profile.lastPrepareStatus !== 'succeeded') return true;
		return profile.currentFingerprint !== profile.lastPreparedFingerprint;
	}

	function eventLabel(event: PrepareEvent): string {
		const payload = event.payload;
		if (typeof payload === 'string') return payload;
		if (payload && typeof payload === 'object') {
			const record = payload as Record<string, unknown>;
			for (const key of ['text', 'message', 'error', 'reason', 'status']) {
				const value = record[key];
				if (typeof value === 'string' && value.length > 0) return value;
			}
		}
		return warningLabel(payload);
	}
</script>

<section class="space-y-3">
	<Card.Root size="sm">
		<Card.Header class="border-b border-border">
			<div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
				<div class="min-w-0 space-y-1">
					<Card.Title>Environment</Card.Title>
					<div class="flex flex-wrap items-center gap-2">
						<Badge variant={environment ? 'outline' : 'destructive'}>{statusLabel}</Badge>
						{#if needsPrepare}
							<Badge variant="secondary">Needs prepare</Badge>
						{/if}
						{#if environment?.lastPrepareError}
							<span class="truncate text-xs text-destructive">{environment.lastPrepareError}</span>
						{/if}
					</div>
				</div>
				<div class="flex flex-wrap gap-2">
					<Button
						variant="outline"
						size="sm"
						disabled={!!busyAction}
						onclick={() => void runAction('detect', () => onDetect({ projectId }))}
					>
						{#if busyAction === 'detect'}
							<LoaderCircle class="animate-spin" />
							Detecting
						{:else}
							<RefreshCw />
							Detect
						{/if}
					</Button>
					<Button
						variant="outline"
						size="sm"
						aria-pressed={editing}
						onclick={() => (editing = !editing)}
					>
						<Settings2 />
						Configure
					</Button>
					<Button size="sm" disabled={!canPrepare || !!busyAction} onclick={() => void prepare()}>
						{#if preparePending}
							<LoaderCircle class="animate-spin" />
							Preparing
						{:else if prepareQueued}
							<LoaderCircle class="animate-spin" />
							Queued
						{:else}
							<Play />
							Prepare
						{/if}
					</Button>
				</div>
			</div>
		</Card.Header>

		<Card.Content class="space-y-3">
			{#if actionError}
				<p class="text-sm break-words text-destructive" role="alert">{actionError}</p>
			{/if}

			<div class="grid gap-2 text-sm md:grid-cols-4">
				<div class="min-w-0">
					<p class="text-xs text-muted-foreground">Status</p>
					<p class="truncate font-medium">{status}</p>
				</div>
				<div class="min-w-0">
					<p class="text-xs text-muted-foreground">Runtime</p>
					<p class="truncate font-medium">{environment?.runtime ?? 'unknown'}</p>
				</div>
				<div class="min-w-0">
					<p class="text-xs text-muted-foreground">Package manager</p>
					<p class="truncate font-medium">{environment?.packageManager ?? 'unknown'}</p>
				</div>
				<div class="min-w-0">
					<p class="text-xs text-muted-foreground">Prepare</p>
					<p class="truncate font-medium">{prepareStatus}</p>
				</div>
			</div>

			{#if eventLines.length > 0}
				<div class="space-y-1 border-t border-border pt-3">
					<p class="text-xs text-muted-foreground">Prepare log</p>
					<ul class="space-y-1 text-xs text-muted-foreground">
						{#each eventLines as event, index (`${event.id ?? event.seq ?? index}-${event.label}`)}
							<li class="grid grid-cols-[auto_1fr] gap-2">
								<span class="uppercase">{event.type ?? 'event'}</span>
								<span class="break-words">{event.label}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if warnings.length > 0}
				<ul class="space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
					{#each warnings as warning, index (`${index}-${warning}`)}
						<li class="break-words">- {warning}</li>
					{/each}
				</ul>
			{/if}

			{#if editing}
				<EnvironmentEditor {projectId} {environment} {onSave} />
			{/if}
		</Card.Content>
	</Card.Root>
</section>
