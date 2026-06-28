<script lang="ts">
	import type { Run } from '@prisma/client';
	import { Bot, Cpu, GitBranch, GitCommit, CircleDot, XCircle } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';

	type RunSummary = Pick<Run, 'status' | 'agent' | 'model' | 'baseBranch' | 'agentBranch'>;

	interface Props {
		run: RunSummary;
		cancelable: boolean;
		canceling: boolean;
		oncancel: () => void | Promise<void>;
	}

	let { run, cancelable, canceling, oncancel }: Props = $props();

	const statusClasses: Partial<Record<RunSummary['status'], string>> = {
		queued: 'border-muted-foreground/20 bg-muted text-muted-foreground',
		preparing: 'border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300',
		running: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
		awaiting_input: 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300',
		awaiting_review: 'border-primary/20 bg-primary/10 text-primary',
		pushing: 'border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300',
		completed: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
		failed: 'border-destructive/20 bg-destructive/10 text-destructive',
		canceled: 'border-muted-foreground/20 bg-muted text-muted-foreground',
		timed_out: 'border-destructive/20 bg-destructive/10 text-destructive'
	};

	const agentLabel = $derived(
		run.agent === 'codex' ? 'Codex' : run.agent === 'claude' ? 'Claude' : run.agent
	);
	const modelLabel = $derived(run.model ?? 'default');
	const statusLabel = $derived(run.status.replaceAll('_', ' '));

	function statusClass(status: RunSummary['status']): string {
		return statusClasses[status] ?? 'border-border bg-muted text-muted-foreground';
	}
</script>

<section class="rounded-xl border bg-card p-4 shadow-sm">
	<div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
		<div class="min-w-0 space-y-3">
			<div class="flex flex-wrap items-center gap-2">
				<span
					class={[
						'inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium capitalize',
						statusClass(run.status)
					]}
				>
					<CircleDot class="h-3.5 w-3.5 shrink-0" />
					{statusLabel}
				</span>
				<span
					class="inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-1 text-xs text-muted-foreground"
				>
					<Bot class="h-3.5 w-3.5 shrink-0" />
					{agentLabel}
				</span>
				<span
					class="inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-1 text-xs text-muted-foreground"
				>
					<Cpu class="h-3.5 w-3.5 shrink-0" />
					{modelLabel}
				</span>
			</div>
			<div>
				<h1 class="text-xl font-semibold tracking-normal">Run workspace</h1>
				<p class="mt-1 text-sm text-muted-foreground">
					Review the agent branch, current status, and timeline from one focused surface.
				</p>
			</div>
		</div>
		{#if cancelable}
			<Button variant="outline" size="sm" onclick={oncancel} disabled={canceling}>
				<XCircle data-icon="inline-start" />
				{canceling ? 'Canceling...' : 'Cancel run'}
			</Button>
		{/if}
	</div>

	<div class="mt-4 grid gap-3 md:grid-cols-2">
		<div class="min-w-0 rounded-lg border bg-background/70 p-3">
			<div class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
				<GitBranch class="h-3.5 w-3.5 shrink-0" />
				Base branch
			</div>
			<code class="mt-2 block truncate text-sm" title={run.baseBranch}>{run.baseBranch}</code>
		</div>
		<div class="min-w-0 rounded-lg border bg-background/70 p-3">
			<div class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
				<GitCommit class="h-3.5 w-3.5 shrink-0" />
				Agent branch
			</div>
			<code class="mt-2 block truncate text-sm" title={run.agentBranch}>{run.agentBranch}</code>
		</div>
	</div>
</section>
