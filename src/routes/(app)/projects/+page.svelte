<script lang="ts">
	import { listProjects, listGithubRepos, importProject } from '$lib/rfc/projects.remote';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';

	const projects = listProjects();
	const repos = listGithubRepos();

	let showImport = $state(false);
	let importing = $state<string | null>(null);
	let importError = $state<string | null>(null);

	async function handleImport(owner: string, name: string) {
		importError = null;
		importing = `${owner}/${name}`;
		try {
			await importProject({ owner, name });
			showImport = false;
		} catch (e) {
			importError = e instanceof Error ? e.message : 'Import failed';
		} finally {
			importing = null;
		}
	}
</script>

<div class="mx-auto max-w-3xl space-y-6 p-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-semibold">Projects</h1>
		<Button onclick={() => (showImport = !showImport)}>
			{showImport ? 'Close' : 'Import repository'}
		</Button>
	</div>

	{#if showImport}
		<Card.Root>
			<Card.Header>
				<Card.Title>Import a GitHub repository</Card.Title>
				<Card.Description>Pick one of the repositories you have access to.</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-2">
				{#if importError}
					<p class="text-sm text-red-500">{importError}</p>
				{/if}
				{#if repos.error}
					<p class="text-sm text-red-500">Could not load repositories: {repos.error.message}</p>
				{:else if repos.current}
					{#if !repos.current.connected}
						<p class="text-sm text-muted-foreground">
							Connect your GitHub account to import repositories.
						</p>
					{:else if repos.current.repos.length === 0}
						<p class="text-sm text-muted-foreground">No repositories found.</p>
					{:else}
						<ul class="divide-y">
							{#each repos.current.repos as repo (repo.githubRepoId)}
								<li class="flex items-center justify-between py-2">
									<span class="text-sm">
										{repo.fullName}
										{#if repo.private}<span class="ml-2 text-xs text-muted-foreground">private</span
											>{/if}
									</span>
									<Button
										variant="outline"
										disabled={importing === repo.fullName}
										onclick={() => handleImport(repo.owner, repo.name)}
									>
										{importing === repo.fullName ? 'Importing…' : 'Import'}
									</Button>
								</li>
							{/each}
						</ul>
					{/if}
				{:else}
					<p class="text-sm text-muted-foreground">Loading repositories…</p>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}

	{#if projects.error}
		<p class="text-sm text-red-500">Could not load projects: {projects.error.message}</p>
	{:else if projects.current}
		{#if projects.current.length === 0}
			<p class="text-sm text-muted-foreground">
				No projects yet. Import a repository to get started.
			</p>
		{:else}
			<ul class="space-y-2">
				{#each projects.current as project (project.id)}
					<li>
						<a href={`/projects/${project.id}`} class="block rounded-md border p-4 hover:bg-accent">
							<span class="font-medium">{project.owner}/{project.name}</span>
							<span class="ml-2 text-xs text-muted-foreground">{project.defaultBranch}</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	{:else}
		<p class="text-sm text-muted-foreground">Loading projects…</p>
	{/if}
</div>
