<script lang="ts">
	import { goto } from '$app/navigation';
	import { listProjects, listGithubRepos, importProject } from '$lib/rfc/projects.remote';
	import { Button } from '$lib/components/ui/button';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import {
		AlertCircle,
		ArrowRight,
		FolderKanban,
		GitBranch,
		LoaderCircle,
		Plus,
		X
	} from '@lucide/svelte';

	const projects = listProjects();
	const repos = listGithubRepos();

	let showImport = $state(false);
	let importing = $state<string | null>(null);
	let importError = $state<string | null>(null);

	async function handleImport(owner: string, name: string) {
		importError = null;
		importing = `${owner}/${name}`;
		let setupPath: string | null = null;
		try {
			const project = await importProject({ owner, name });
			setupPath = `/projects/${project.id}/setup`;
		} catch (e) {
			importError = e instanceof Error ? e.message : 'Import failed';
			return;
		} finally {
			importing = null;
		}
		if (!setupPath) return;
		showImport = false;
		await goto(setupPath);
	}
</script>

<svelte:head>
	<title>Projects | dotWeaver</title>
</svelte:head>

<div class="space-y-6">
	<header class="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
		<div class="min-w-0 space-y-1">
			<h1 class="truncate text-2xl font-semibold tracking-tight">Projects</h1>
			<p class="text-sm text-muted-foreground">
				Import GitHub repositories and open workspaces for agent runs.
			</p>
		</div>
		<Button onclick={() => (showImport = !showImport)} class="w-full sm:w-fit">
			{#if showImport}
				<X class="size-4" strokeWidth={1.8} />
				Close import
			{:else}
				<Plus class="size-4" strokeWidth={1.8} />
				Import repository
			{/if}
		</Button>
	</header>

	{#if showImport}
		<Card.Root class="rounded-lg shadow-sm">
			<Card.Header class="border-b">
				<div class="min-w-0">
					<Card.Title>Import repository</Card.Title>
					<Card.Description>Pick one GitHub repository available to your account.</Card.Description>
				</div>
				<Card.Action>
					<Button
						variant="ghost"
						size="icon-sm"
						onclick={() => (showImport = false)}
						aria-label="Close import panel"
					>
						<X class="size-4" strokeWidth={1.8} />
					</Button>
				</Card.Action>
			</Card.Header>
			<Card.Content class="space-y-3">
				{#if importError}
					<Alert.Root variant="destructive">
						<AlertCircle class="size-4" strokeWidth={1.8} />
						<Alert.Description>{importError}</Alert.Description>
					</Alert.Root>
				{/if}

				{#if repos.error}
					<Alert.Root variant="destructive">
						<AlertCircle class="size-4" strokeWidth={1.8} />
						<Alert.Description>
							Could not load repositories: {repos.error.message}
						</Alert.Description>
					</Alert.Root>
				{:else if repos.current}
					{#if !repos.current.connected}
						<div
							class="flex flex-col gap-3 rounded-lg border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between"
						>
							<div class="min-w-0 space-y-1">
								<p class="text-sm font-medium">GitHub is not connected</p>
								<p class="text-sm text-muted-foreground">
									Connect your GitHub account before importing repositories.
								</p>
							</div>
							<Button href="/settings/connectors" variant="outline" class="w-full sm:w-fit">
								Open connectors
							</Button>
						</div>
					{:else if repos.current.repos.length === 0}
						<div class="rounded-lg border bg-muted/20 p-4">
							<p class="text-sm font-medium">No repositories found</p>
							<p class="text-sm text-muted-foreground">
								GitHub did not return any repositories for this account.
							</p>
						</div>
					{:else}
						<ul class="overflow-hidden rounded-lg border">
							{#each repos.current.repos as repo (repo.githubRepoId)}
								<li
									class="grid gap-3 border-b p-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
								>
									<div class="min-w-0 space-y-1">
										<div class="flex min-w-0 items-center gap-2">
											<span class="truncate text-sm font-medium">{repo.owner}/{repo.name}</span>
											{#if repo.private}
												<Badge variant="outline" class="shrink-0 text-muted-foreground"
													>Private</Badge
												>
											{/if}
										</div>
										<p class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
											<GitBranch class="size-3.5 shrink-0" strokeWidth={1.8} />
											<span class="truncate">Default branch: {repo.defaultBranch}</span>
										</p>
									</div>
									<Button
										variant="outline"
										disabled={importing === repo.fullName}
										onclick={() => handleImport(repo.owner, repo.name)}
										class="w-full sm:w-fit"
									>
										{#if importing === repo.fullName}
											<LoaderCircle class="size-4 animate-spin" strokeWidth={1.8} />
											Importing
										{:else}
											Import
										{/if}
									</Button>
								</li>
							{/each}
						</ul>
					{/if}
				{:else}
					<div
						class="flex items-center gap-2 rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground"
					>
						<LoaderCircle class="size-4 animate-spin" strokeWidth={1.8} />
						Loading repositories
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}

	<section class="space-y-3" aria-label="Imported projects">
		{#if projects.error}
			<Alert.Root variant="destructive">
				<AlertCircle class="size-4" strokeWidth={1.8} />
				<Alert.Description>Could not load projects: {projects.error.message}</Alert.Description>
			</Alert.Root>
		{:else if projects.current}
			{#if projects.current.length === 0}
				<div class="rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
					<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
						<div class="flex min-w-0 gap-3">
							<span
								class="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted text-muted-foreground"
							>
								<FolderKanban class="size-4" strokeWidth={1.8} />
							</span>
							<div class="min-w-0 space-y-1">
								<h2 class="text-sm font-medium">No projects yet</h2>
								<p class="text-sm text-muted-foreground">
									Import a repository to start running agents against real code.
								</p>
							</div>
						</div>
						<Button onclick={() => (showImport = true)} class="w-full sm:w-fit">
							<Plus class="size-4" strokeWidth={1.8} />
							Import repository
						</Button>
					</div>
				</div>
			{:else}
				<ul class="grid gap-2">
					{#each projects.current as project (project.id)}
						<li>
							<a
								href={`/projects/${project.id}`}
								class="group grid min-w-0 gap-3 rounded-lg border bg-card p-4 text-card-foreground shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
							>
								<div class="min-w-0 space-y-1">
									<div class="flex min-w-0 items-baseline gap-1 text-sm font-medium">
										<span class="truncate text-muted-foreground">{project.owner}</span>
										<span class="shrink-0 text-muted-foreground">/</span>
										<span class="truncate">{project.name}</span>
									</div>
									<p class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
										<span class="truncate">{project.private ? 'Private' : 'Public'} repository</span
										>
									</p>
								</div>

								<div class="flex min-w-0 items-center gap-2 sm:justify-end">
									<Badge variant="outline" class="max-w-full min-w-0 gap-1 text-muted-foreground">
										<GitBranch class="size-3.5 shrink-0" strokeWidth={1.8} />
										<span class="truncate">{project.defaultBranch}</span>
									</Badge>
									<ArrowRight
										class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
										strokeWidth={1.8}
									/>
								</div>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		{:else}
			<div
				class="flex items-center gap-2 rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground"
			>
				<LoaderCircle class="size-4 animate-spin" strokeWidth={1.8} />
				Loading projects
			</div>
		{/if}
	</section>
</div>
