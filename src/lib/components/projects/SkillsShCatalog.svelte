<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import {
		getSkillsShSkill,
		importSkillsShSkill,
		searchSkillsSh
	} from '$lib/rfc/project-agent-config.remote';
	import { Download, ExternalLink, Eye, Search as SearchIcon } from '@lucide/svelte';

	type SkillsShResult = {
		id: string;
		slug: string;
		name: string;
		source: string;
		installs: number;
		url?: string | null;
		isDuplicate?: boolean;
	};

	type SkillsShPreview = {
		id: string;
		name: string;
		description: string;
		source: string;
		slug: string;
		hash: string | null;
		files: Array<{ path: string; content: string }>;
		url?: string | null;
	};

	let {
		projectId,
		existingSkillNames
	}: {
		projectId: string;
		existingSkillNames: string[];
	} = $props();

	let query = $state('');
	let results = $state<SkillsShResult[]>([]);
	let selected = $state<SkillsShPreview | null>(null);
	let searching = $state(false);
	let loadingId = $state<string | null>(null);
	let importingId = $state<string | null>(null);
	let error = $state<string | null>(null);

	const canSearch = $derived(query.trim().length >= 2 && !searching);
	const selectedFileCount = $derived(selected ? selected.files.length + 1 : 0);

	function isExisting(result: SkillsShResult): boolean {
		return existingSkillNames.includes(result.slug);
	}

	function formatInstalls(installs: number): string {
		return new Intl.NumberFormat('en', { notation: 'compact' }).format(installs);
	}

	async function runSearch() {
		if (!canSearch) return;
		error = null;
		searching = true;
		selected = null;
		try {
			const response = await searchSkillsSh({ query: query.trim(), limit: 20 });
			results = response.results;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not search skills.sh';
		} finally {
			searching = false;
		}
	}

	async function loadPreview(result: SkillsShResult) {
		if (loadingId || importingId) return;
		error = null;
		loadingId = result.id;
		try {
			selected = await getSkillsShSkill({ id: result.id });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load skill';
		} finally {
			loadingId = null;
		}
	}

	async function addSkill(result: SkillsShResult) {
		if (importingId) return;
		error = null;
		importingId = result.id;
		try {
			await importSkillsShSkill({
				projectId,
				id: result.id,
				replace: isExisting(result)
			});
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not import skill';
		} finally {
			importingId = null;
		}
	}
</script>

<section class="space-y-3 border-y border-border py-4">
	<div class="flex items-center justify-between gap-3">
		<div class="min-w-0">
			<h3 class="text-sm font-medium">skills.sh</h3>
			<p class="truncate text-xs text-muted-foreground">Catalog</p>
		</div>
		{#if selected?.url}
			<a
				href={selected.url}
				target="_blank"
				rel="noreferrer"
				class="inline-flex h-8 items-center gap-1 border border-border px-2 text-xs hover:bg-muted"
			>
				<ExternalLink class="size-3.5" />
				Open
			</a>
		{/if}
	</div>

	<form
		class="grid gap-2 md:grid-cols-[1fr_auto]"
		onsubmit={(event) => {
			event.preventDefault();
			void runSearch();
		}}
	>
		<Input bind:value={query} placeholder="Search skills" aria-label="Search skills.sh" />
		<Button type="submit" disabled={!canSearch}>
			<SearchIcon />
			{searching ? 'Searching' : 'Search'}
		</Button>
	</form>

	{#if error}
		<p class="text-sm break-words text-destructive" role="alert">{error}</p>
	{/if}

	{#if results.length > 0}
		<div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
			<ul class="divide-y divide-border border-y border-border">
				{#each results as result (result.id)}
					<li class="grid gap-2 py-2 text-sm md:grid-cols-[1fr_auto] md:items-center">
						<button
							type="button"
							class="min-w-0 text-left"
							onclick={() => void loadPreview(result)}
						>
							<span class="block truncate font-medium">{result.name}</span>
							<span class="block truncate text-xs text-muted-foreground">
								{result.source} · {formatInstalls(result.installs)}
								{#if result.isDuplicate}
									· duplicate
								{/if}
							</span>
						</button>
						<div class="flex flex-wrap gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={loadingId !== null || importingId !== null}
								onclick={() => void loadPreview(result)}
							>
								<Eye />
								{loadingId === result.id ? 'Loading' : 'Preview'}
							</Button>
							<Button
								type="button"
								size="sm"
								disabled={importingId !== null}
								onclick={() => void addSkill(result)}
							>
								<Download />
								{importingId === result.id ? 'Adding' : isExisting(result) ? 'Replace' : 'Add'}
							</Button>
						</div>
					</li>
				{/each}
			</ul>

			<div class="min-h-36 border border-border p-3 text-sm">
				{#if selected}
					<div class="space-y-2">
						<div class="min-w-0">
							<p class="truncate font-medium">{selected.name}</p>
							<p class="truncate text-xs text-muted-foreground">{selected.source}</p>
						</div>
						<p class="text-sm break-words text-muted-foreground">{selected.description}</p>
						<div class="grid gap-1 text-xs text-muted-foreground">
							<p>{selectedFileCount} files</p>
							{#if selected.hash}
								<p class="truncate font-mono">{selected.hash}</p>
							{/if}
						</div>
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">No preview selected.</p>
				{/if}
			</div>
		</div>
	{/if}
</section>
