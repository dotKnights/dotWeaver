<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import {
		ArrowRight,
		Bot,
		Cable,
		Command,
		FolderKanban,
		GitBranch,
		ShieldCheck
	} from '@lucide/svelte';
</script>

<svelte:head>
	<title>dotWeaver | AI command center for product teams</title>
	<meta
		name="description"
		content="dotWeaver brings projects, teams, mail, and connectors into one restrained AI command center."
	/>
</svelte:head>

<div class="min-h-[100dvh] bg-background text-foreground">
	<div class="mx-auto flex min-h-[100dvh] w-full max-w-7xl flex-col px-4 sm:px-6 lg:px-8">
		<header class="flex h-16 shrink-0 items-center justify-between border-b border-border/80">
			<a href="/" class="flex min-w-0 items-center gap-2.5 font-semibold tracking-tight">
				<span
					class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
					aria-hidden="true"
				>
					<Command class="size-4" strokeWidth={1.8} />
				</span>
				<span class="truncate">dotWeaver</span>
			</a>
			<nav aria-label="Account" class="flex shrink-0 items-center gap-2">
				<Button href="/login" variant="ghost" size="sm">Sign in</Button>
				<Button href="/register" size="sm">Create account</Button>
			</nav>
		</header>

		<main
			class="grid flex-1 items-center gap-10 py-10 lg:grid-cols-[minmax(0,0.92fr)_minmax(420px,1.08fr)] lg:py-14"
		>
			<section class="max-w-2xl space-y-7">
				<div
					class="inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-card px-3 text-xs font-medium text-muted-foreground"
				>
					<ShieldCheck class="size-3.5 text-primary" strokeWidth={1.8} />
					Authenticated team workspace
				</div>
				<div class="space-y-5">
					<h1
						class="text-4xl leading-[1.02] font-semibold tracking-normal text-balance sm:text-5xl lg:text-6xl"
					>
						Run product work from one calm command center.
					</h1>
					<p class="max-w-[58ch] text-base leading-7 text-muted-foreground sm:text-lg">
						Route projects, team context, mail, and connectors through focused AI workflows without
						turning the workspace into noise.
					</p>
				</div>
				<div class="flex flex-col gap-3 sm:flex-row">
					<Button href="/login" size="lg" class="w-full sm:w-auto">
						Sign in
						<ArrowRight class="size-4" strokeWidth={1.8} />
					</Button>
					<Button href="/register" variant="outline" size="lg" class="w-full sm:w-auto">
						Create account
					</Button>
				</div>
			</section>

			<section
				class="overflow-hidden rounded-xl border border-border bg-card shadow-[0_20px_70px_oklch(0.18_0.02_155/0.08)]"
				aria-label="dotWeaver product overview"
			>
				<div
					class="flex min-h-14 items-center justify-between border-b border-sidebar-border bg-sidebar px-4 text-sidebar-foreground"
				>
					<div class="flex min-w-0 items-center gap-2.5">
						<span
							class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"
						>
							<Bot class="size-4" strokeWidth={1.8} />
						</span>
						<div class="min-w-0">
							<p class="truncate text-sm font-semibold">Command routing</p>
							<p class="truncate text-xs text-sidebar-foreground/60">Workspace context is ready</p>
						</div>
					</div>
					<span
						class="rounded-md border border-sidebar-border px-2 py-1 text-[11px] font-medium text-sidebar-foreground/70"
					>
						Live shell
					</span>
				</div>

				<div class="grid gap-0 md:grid-cols-[minmax(0,1fr)_17rem]">
					<div class="space-y-4 p-4 sm:p-5">
						<div class="rounded-lg border border-border bg-background p-4">
							<div class="mb-4 flex items-center justify-between gap-3">
								<div class="min-w-0">
									<h2 class="truncate text-sm font-semibold">Today&apos;s focus</h2>
									<p class="truncate text-xs text-muted-foreground">
										Repo updates, team work, connector health
									</p>
								</div>
								<GitBranch class="size-4 shrink-0 text-primary" strokeWidth={1.8} />
							</div>
							<div class="space-y-2">
								<div
									class="flex min-h-11 items-center justify-between gap-3 border-t border-border pt-2"
								>
									<span class="min-w-0 truncate text-sm">Review project runs</span>
									<span class="shrink-0 text-xs font-medium text-primary">Queued</span>
								</div>
								<div
									class="flex min-h-11 items-center justify-between gap-3 border-t border-border pt-2"
								>
									<span class="min-w-0 truncate text-sm">Sync team context</span>
									<span class="shrink-0 text-xs font-medium text-muted-foreground">Ready</span>
								</div>
								<div
									class="flex min-h-11 items-center justify-between gap-3 border-t border-border pt-2"
								>
									<span class="min-w-0 truncate text-sm">Check connector access</span>
									<span class="shrink-0 text-xs font-medium text-muted-foreground">Ready</span>
								</div>
							</div>
						</div>

						<div class="grid gap-3 sm:grid-cols-2">
							<div class="rounded-lg border border-border bg-background p-4">
								<FolderKanban class="mb-3 size-4 text-primary" strokeWidth={1.8} />
								<p class="text-sm font-semibold">Projects</p>
								<p class="mt-1 text-xs leading-5 text-muted-foreground">
									Keep agent config and run history close to the work.
								</p>
							</div>
							<div class="rounded-lg border border-border bg-background p-4">
								<Cable class="mb-3 size-4 text-primary" strokeWidth={1.8} />
								<p class="text-sm font-semibold">Connectors</p>
								<p class="mt-1 text-xs leading-5 text-muted-foreground">
									Bring external systems into one authenticated surface.
								</p>
							</div>
						</div>
					</div>

					<aside class="border-t border-border bg-muted/45 p-4 md:border-t-0 md:border-l">
						<h2 class="text-sm font-semibold">Workspace map</h2>
						<div class="mt-4 space-y-3">
							<div
								class="flex min-h-10 items-center justify-between gap-3 rounded-lg bg-background px-3 text-xs"
							>
								<span class="truncate text-muted-foreground">Team</span>
								<span class="truncate font-medium">Active</span>
							</div>
							<div
								class="flex min-h-10 items-center justify-between gap-3 rounded-lg bg-background px-3 text-xs"
							>
								<span class="truncate text-muted-foreground">Mail</span>
								<span class="truncate font-medium">Connected</span>
							</div>
							<div
								class="flex min-h-10 items-center justify-between gap-3 rounded-lg bg-background px-3 text-xs"
							>
								<span class="truncate text-muted-foreground">Runs</span>
								<span class="truncate font-medium">Tracked</span>
							</div>
						</div>
					</aside>
				</div>
			</section>
		</main>
	</div>
</div>
