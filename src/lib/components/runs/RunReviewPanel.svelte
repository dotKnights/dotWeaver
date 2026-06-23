<script lang="ts">
	import {
		Ban,
		FileDiff,
		Files,
		GitPullRequest,
		MessageSquare,
		Send,
		Upload
	} from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';

	export type ReviewAction = 'push_pr' | 'push' | 'abandon';

	interface ReviewFile {
		path: string;
		status: string;
		additions: number | null;
		deletions: number | null;
	}

	interface Props {
		files: ReviewFile[] | null;
		patch: string | null;
		truncated: boolean;
		diffError?: string | null;
		loading?: boolean;
		actionError: string | null;
		busy: boolean;
		replyText?: string;
		replying: boolean;
		replyError: string | null;
		canReply: boolean;
		onact: (action: ReviewAction) => void | Promise<void>;
		onsendreply: () => void | Promise<void>;
	}

	let {
		files = null,
		patch = null,
		truncated = false,
		diffError = null,
		loading = false,
		actionError = null,
		busy = false,
		replyText = $bindable(''),
		replying = false,
		replyError = null,
		canReply = false,
		onact,
		onsendreply
	}: Props = $props();

	const hasFiles = $derived((files?.length ?? 0) > 0);
	const fileCount = $derived(`${files?.length ?? 0} ${files?.length === 1 ? 'file' : 'files'}`);

	function countLabel(value: number | null): string {
		return value === null ? '?' : value.toLocaleString();
	}

	function handleReplySubmit(event: SubmitEvent) {
		event.preventDefault();
		if (replying || !canReply || !replyText.trim()) return;
		onsendreply();
	}
</script>

<section class="rounded-xl border bg-card shadow-sm">
	<div class="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
		<div class="flex items-center gap-2">
			<FileDiff class="h-4 w-4 text-muted-foreground" />
			<h2 class="text-sm font-semibold">Review changes</h2>
		</div>
		{#if files}
			<span class="rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">
				{fileCount}
			</span>
		{/if}
	</div>

	<div class="space-y-4 p-4">
		{#if actionError}
			<p class="text-sm text-destructive">{actionError}</p>
		{/if}

		{#if diffError}
			<p class="text-sm text-destructive">Could not load the diff: {diffError}</p>
		{:else if loading || files === null}
			<p class="text-sm text-muted-foreground">Loading diff...</p>
		{:else}
			<div class="grid gap-3 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
				<div class="min-w-0 rounded-lg border bg-background/70">
					<div class="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
						<Files class="h-3.5 w-3.5 text-muted-foreground" />
						Files
					</div>
					{#if hasFiles}
						<ul class="divide-y">
							{#each files as file (file.path)}
								<li class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2">
									<span
										class="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
									>
										{file.status}
									</span>
									<code class="truncate text-xs" title={file.path}>{file.path}</code>
									<span class="font-mono text-xs text-muted-foreground">
										+{countLabel(file.additions)} -{countLabel(file.deletions)}
									</span>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="px-3 py-6 text-sm text-muted-foreground">No changes in this run.</p>
					{/if}
				</div>

				<div class="min-w-0 rounded-lg border bg-background/70">
					<div class="flex items-center justify-between gap-2 border-b px-3 py-2">
						<div class="flex items-center gap-2 text-xs font-medium">
							<FileDiff class="h-3.5 w-3.5 text-muted-foreground" />
							Diff
						</div>
						{#if truncated}
							<span class="text-xs text-muted-foreground">truncated</span>
						{/if}
					</div>
					{#if hasFiles && patch}
						<pre
							class="max-h-[34rem] overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">{patch}{truncated
								? '\n... (diff truncated)'
								: ''}</pre>
					{:else}
						<p class="px-3 py-6 text-sm text-muted-foreground">No patch to display.</p>
					{/if}
				</div>
			</div>

			<div class="flex flex-wrap gap-2">
				{#if hasFiles}
					<Button onclick={() => onact('push_pr')} disabled={busy}>
						<GitPullRequest data-icon="inline-start" />
						Push and PR
					</Button>
					<Button variant="outline" onclick={() => onact('push')} disabled={busy}>
						<Upload data-icon="inline-start" />
						Push branch
					</Button>
				{/if}
				<Button variant="outline" onclick={() => onact('abandon')} disabled={busy}>
					<Ban data-icon="inline-start" />
					Abandon
				</Button>
			</div>
		{/if}

		<form class="space-y-3 border-t pt-4" onsubmit={handleReplySubmit}>
			<div class="space-y-1">
				<div class="flex items-center gap-2">
					<MessageSquare class="h-4 w-4 text-muted-foreground" />
					<h3 class="text-sm font-medium">Reply to the agent</h3>
				</div>
				<p class="text-xs text-muted-foreground">
					Send a message to continue this run in the same session.
				</p>
			</div>

			{#if replyError}
				<p class="text-sm text-destructive">{replyError}</p>
			{/if}
			{#if !canReply}
				<p class="text-xs text-muted-foreground">
					This run has no agent session, so it cannot be resumed.
				</p>
			{/if}

			<textarea
				bind:value={replyText}
				rows="3"
				aria-label="Reply to the agent"
				placeholder="Type your reply..."
				disabled={replying || !canReply}
				class="min-h-24 w-full rounded-lg border bg-background p-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:opacity-50"
			></textarea>

			<div class="flex justify-end">
				<Button type="submit" disabled={replying || !replyText.trim() || !canReply}>
					<Send data-icon="inline-start" />
					{replying ? 'Sending...' : 'Send reply'}
				</Button>
			</div>
		</form>
	</div>
</section>
