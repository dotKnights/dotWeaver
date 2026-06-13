<script lang="ts">
	import { AlertCircle, Inbox, LoaderCircle, MailOpen, RefreshCw } from '@lucide/svelte';
	import { authClient } from '$lib/auth-client';
	import { Button } from '$lib/components/ui/button';
	import * as Alert from '$lib/components/ui/alert';
	import { GMAIL_READONLY_SCOPE } from '$lib/constants/mail';
	import { getMailThread, listMailThreads, syncNextMailPage } from '$lib/rfc/mail.remote';
	import { useIntersectionObserver } from 'runed';
	import type { Attachment } from 'svelte/attachments';

	type MailThreadRow = NonNullable<typeof threads.current>['threads'][number];

	const threads = listMailThreads();

	let scrollRoot = $state<HTMLElement | null>(null);
	let sentinel = $state<HTMLElement | null>(null);
	let selectedThreadId = $state<string | null>(null);
	let loadingMore = $state(false);
	let syncError = $state<string | null>(null);

	let selectedThreadQuery = $derived(
		selectedThreadId ? getMailThread({ gmailThreadId: selectedThreadId }) : null
	);
	let threadRows = $derived(threads.current?.threads ?? []);
	let selectedRow = $derived(
		selectedThreadId ? threadRows.find((thread) => thread.gmailThreadId === selectedThreadId) : null
	);
	let canSyncMore = $derived(
		Boolean(
			threads.current?.connected &&
			!threads.current.needsReconnect &&
			threads.current.hasMore &&
			!threads.current.syncing &&
			!loadingMore
		)
	);
	let hasSyncProblem = $derived(Boolean(syncError || threads.current?.error));
	let canRetrySync = $derived(canSyncMore && (hasSyncProblem || threadRows.length === 0));
	let canManualSync = $derived(canSyncMore);

	useIntersectionObserver(
		() => sentinel,
		(entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				void loadMoreThreads();
			}
		},
		{ root: () => scrollRoot, rootMargin: '320px 0px', threshold: 0 }
	);

	async function connectGoogle() {
		syncError = null;
		await authClient.linkSocial({
			provider: 'google',
			callbackURL: '/mail',
			scopes: [GMAIL_READONLY_SCOPE]
		});
	}

	async function retrySync() {
		await loadMoreThreads({ retry: true });
	}

	async function loadMoreThreads(options: { retry?: boolean } = {}) {
		if (!canSyncMore) return;
		if (options.retry && !hasSyncProblem && threadRows.length > 0) return;
		if (loadingMore) return;

		loadingMore = true;
		syncError = null;

		try {
			const result = await syncNextMailPage();
			if (!result.connected) {
				syncError = 'Connect Google to sync Gmail.';
				await threads.refresh();
			} else if (result.needsReconnect) {
				syncError = 'Reconnect Google to restore Gmail access.';
				await threads.refresh();
			}
		} catch (error) {
			syncError = errorMessage(error, 'Unable to sync mail right now.');
		} finally {
			loadingMore = false;
		}
	}

	const scrollRootAttachment: Attachment<HTMLElement> = (node) => {
		scrollRoot = node;
		return () => {
			if (scrollRoot === node) scrollRoot = null;
		};
	};

	const sentinelAttachment: Attachment<HTMLElement> = (node) => {
		sentinel = node;
		return () => {
			if (sentinel === node) sentinel = null;
		};
	};

	function selectThread(thread: MailThreadRow) {
		selectedThreadId = thread.gmailThreadId;
	}

	function senderLabel(thread: MailThreadRow) {
		return thread.fromName || thread.fromEmail || 'Unknown sender';
	}

	function initials(thread: MailThreadRow) {
		const label = senderLabel(thread).trim();
		return (label.match(/\b\w/g) ?? [label.at(0) ?? '?']).slice(0, 2).join('').toUpperCase();
	}

	function formatThreadDate(value: Date | string) {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return '';

		const now = new Date();
		const sameYear = date.getFullYear() === now.getFullYear();
		const sameDay = date.toDateString() === now.toDateString();

		if (sameDay) {
			return new Intl.DateTimeFormat(undefined, {
				hour: 'numeric',
				minute: '2-digit'
			}).format(date);
		}

		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			year: sameYear ? undefined : 'numeric'
		}).format(date);
	}

	function participantCount(thread: MailThreadRow) {
		return Array.isArray(thread.participants) ? thread.participants.length : 0;
	}

	function labelText(labels: unknown) {
		return Array.isArray(labels)
			? labels.filter((label) => typeof label === 'string').join(', ')
			: '';
	}

	function formatMessageDate(value: Date | string) {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return '';
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(date);
	}

	function messageBodyText(message: { text: string | null; snippet: string }) {
		return message.text || message.snippet || 'No preview text available.';
	}

	function errorMessage(error: unknown, fallback: string) {
		if (error instanceof Error && error.message) return error.message;
		if (typeof error === 'object' && error !== null && 'message' in error) {
			const message = (error as { message?: unknown }).message;
			if (typeof message === 'string' && message) return message;
		}
		return fallback;
	}
</script>

<svelte:head>
	<title>Mail | dotWeaver</title>
</svelte:head>

<div class="flex h-[calc(100vh-57px)] min-h-[620px] flex-col bg-background text-foreground">
	{#if threads.error}
		<div class="flex flex-1 items-center justify-center p-6">
			<Alert.Root variant="destructive" class="max-w-lg">
				<AlertCircle class="size-4" />
				<Alert.Title>Mail could not load</Alert.Title>
				<Alert.Description>{errorMessage(threads.error, 'Unable to load mail.')}</Alert.Description>
			</Alert.Root>
		</div>
	{:else if !threads.current}
		<div class="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
			<LoaderCircle class="size-4 animate-spin" />
			Loading mail
		</div>
	{:else if !threads.current.connected || threads.current.needsReconnect}
		<div class="flex flex-1 items-center justify-center p-6">
			<div class="w-full max-w-md border bg-background p-5 shadow-sm">
				<div class="mb-4 flex items-center gap-3">
					<div class="flex size-9 items-center justify-center border bg-muted">
						<Inbox class="size-4" />
					</div>
					<div>
						<h1 class="text-base font-semibold">
							{threads.current.needsReconnect ? 'Reconnect Gmail' : 'Connect Gmail'}
						</h1>
						<p class="text-sm text-muted-foreground">
							{threads.current.needsReconnect
								? 'Google access needs to be refreshed before mail can sync.'
								: 'Connect Google with read-only Gmail access to review your threads.'}
						</p>
					</div>
				</div>
				<Button onclick={connectGoogle} class="w-full">
					{threads.current.needsReconnect ? 'Reconnect Google' : 'Connect Google'}
				</Button>
			</div>
		</div>
	{:else}
		<div class="flex min-h-0 flex-1 flex-col lg:flex-row">
			<section class="flex min-h-[320px] flex-1 flex-col border-r lg:max-w-[46rem]">
				<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3">
					<div class="min-w-0">
						<h1 class="truncate text-sm font-semibold">Mail</h1>
						<p class="truncate text-xs text-muted-foreground">
							{threadRows.length} synced thread{threadRows.length === 1 ? '' : 's'}
						</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						onclick={() => void loadMoreThreads()}
						disabled={!canManualSync}
						aria-label="Sync Gmail"
					>
						<RefreshCw class={loadingMore || threads.current.syncing ? 'animate-spin' : ''} />
						Sync
					</Button>
				</div>

				{#if syncError || threads.current.error}
					<div class="border-b bg-destructive/5 px-3 py-2 text-sm text-destructive">
						<div class="flex items-center justify-between gap-3">
							<span class="min-w-0 truncate">{syncError ?? threads.current.error}</span>
							<Button variant="ghost" size="xs" onclick={retrySync} disabled={!canRetrySync}
								>Retry</Button
							>
						</div>
					</div>
				{/if}

				<div
					{@attach scrollRootAttachment}
					class="min-h-0 flex-1 overflow-y-auto"
					aria-label="Mail threads"
				>
					{#each threadRows as thread (thread.gmailThreadId)}
						<button
							type="button"
							class="grid w-full grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 border-b px-3 py-2 text-left transition-colors hover:bg-muted/70 focus-visible:bg-muted focus-visible:outline-none {thread.unread
								? 'bg-background font-semibold'
								: 'bg-muted/20 text-muted-foreground'} {selectedThreadId === thread.gmailThreadId
								? 'bg-primary/10 text-foreground shadow-[inset_3px_0_0_hsl(var(--primary))]'
								: ''}"
							aria-current={selectedThreadId === thread.gmailThreadId ? 'true' : undefined}
							onclick={() => selectThread(thread)}
						>
							<span
								class="flex size-8 items-center justify-center border bg-background text-[11px] font-semibold text-muted-foreground"
								aria-hidden="true"
							>
								{initials(thread)}
							</span>
							<span class="min-w-0">
								<span class="flex items-center gap-2">
									<span class="truncate text-sm text-foreground">{senderLabel(thread)}</span>
									{#if thread.messageCount > 1}
										<span class="text-xs text-muted-foreground">({thread.messageCount})</span>
									{/if}
									{#if thread.starred}
										<span class="text-xs text-amber-600" aria-label="Starred">Starred</span>
									{/if}
								</span>
								<span class="flex min-w-0 gap-1 text-sm">
									<span class="truncate text-foreground">{thread.subject || '(no subject)'}</span>
									<span class="hidden shrink-0 text-muted-foreground sm:inline">-</span>
									<span class="hidden min-w-0 truncate text-muted-foreground sm:inline">
										{thread.snippet}
									</span>
								</span>
							</span>
							<span class="self-start pt-1 text-xs whitespace-nowrap text-muted-foreground">
								{formatThreadDate(thread.lastMessageAt)}
							</span>
						</button>
					{:else}
						<div class="flex h-full min-h-72 items-center justify-center p-6 text-center">
							<div>
								<MailOpen class="mx-auto mb-3 size-8 text-muted-foreground" />
								<p class="text-sm font-medium">No synced threads yet</p>
								<p class="mt-1 text-sm text-muted-foreground">
									Run the first sync to pull recent Gmail threads.
								</p>
								<Button class="mt-4" onclick={retrySync} disabled={!canManualSync}
									>Sync Gmail</Button
								>
							</div>
						</div>
					{/each}

					<div
						{@attach sentinelAttachment}
						class="px-3 py-4 text-center text-xs text-muted-foreground"
					>
						{#if loadingMore || threads.current.syncing}
							<span class="inline-flex items-center gap-2">
								<LoaderCircle class="size-3 animate-spin" />
								Loading more threads
							</span>
						{:else if syncError}
							<Button variant="ghost" size="xs" onclick={retrySync} disabled={!canRetrySync}
								>Retry loading mail</Button
							>
						{:else if threads.current.hasMore}
							Scroll for more
						{:else if threadRows.length > 0}
							End of synced mail
						{/if}
					</div>
				</div>
			</section>

			<aside class="flex min-h-[360px] flex-1 flex-col bg-background">
				{#if selectedRow}
					<div class="border-b px-4 py-3">
						<p class="truncate text-xs text-muted-foreground">{senderLabel(selectedRow)}</p>
						<h2 class="mt-1 truncate text-base font-semibold">
							{selectedRow.subject || '(no subject)'}
						</h2>
						<p class="mt-1 line-clamp-2 text-sm text-muted-foreground">{selectedRow.snippet}</p>
						<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
							<span>{formatThreadDate(selectedRow.lastMessageAt)}</span>
							<span
								>{selectedRow.messageCount} message{selectedRow.messageCount === 1 ? '' : 's'}</span
							>
							<span
								>{participantCount(selectedRow)} participant{participantCount(selectedRow) === 1
									? ''
									: 's'}</span
							>
							{#if labelText(selectedRow.labelIds)}
								<span class="truncate">Labels: {labelText(selectedRow.labelIds)}</span>
							{/if}
						</div>
					</div>

					<div class="min-h-0 flex-1 overflow-auto p-4">
						{#if selectedThreadQuery?.error}
							<Alert.Root variant="destructive">
								<AlertCircle class="size-4" />
								<Alert.Title>Thread could not load</Alert.Title>
								<Alert.Description>
									{errorMessage(selectedThreadQuery.error, 'Unable to load this thread.')}
								</Alert.Description>
							</Alert.Root>
						{:else if !selectedThreadQuery?.current}
							<div
								class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
							>
								<LoaderCircle class="size-4 animate-spin" />
								Loading conversation
							</div>
						{:else}
							<div class="space-y-3">
								<h2 class="text-xl font-semibold">{selectedThreadQuery.current.subject}</h2>
								{#each selectedThreadQuery.current.messages as message (message.gmailMessageId)}
									<article class="border bg-background p-4">
										<div
											class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 text-sm"
										>
											<div class="min-w-0">
												<p class="truncate font-medium">
													{message.fromName ?? message.fromEmail ?? 'Unknown sender'}
												</p>
												<p class="mt-0.5 truncate text-xs text-muted-foreground">
													{message.toEmails.length
														? `to ${message.toEmails.join(', ')}`
														: 'No recipients'}
												</p>
											</div>
											<time class="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
												{formatMessageDate(message.date)}
											</time>
										</div>
										<p class="mt-3 text-sm leading-6 whitespace-pre-wrap text-foreground">
											{messageBodyText(message)}
										</p>
									</article>
								{/each}
							</div>
						{/if}
					</div>
				{:else}
					<div class="flex flex-1 items-center justify-center p-6 text-center">
						<div>
							<MailOpen class="mx-auto mb-3 size-8 text-muted-foreground" />
							<p class="text-sm font-medium">Select a thread</p>
							<p class="mt-1 max-w-sm text-sm text-muted-foreground">
								Choose a synced Gmail conversation to read its messages.
							</p>
						</div>
					</div>
				{/if}
			</aside>
		</div>
	{/if}
</div>
