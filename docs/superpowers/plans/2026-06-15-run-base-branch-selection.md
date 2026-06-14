# Run Base Branch Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users choose the base branch for every project run while keeping agent changes isolated on `claude/<runId>` and opening PRs back to the selected base branch.

**Architecture:** Store `baseBranch` on `Run` at creation time, list project branches from the existing mirror-backed git workflow, and thread the captured base branch through checkout creation and PR approval. The project page exposes the choice at launch; the run page displays base and agent branches separately.

**Tech Stack:** SvelteKit remote functions, Svelte 5 runes, Prisma/PostgreSQL, Bun, Vitest, git CLI helpers.

---

## File Structure

- Modify `prisma/schema.prisma`: add `Run.baseBranch`.
- Create `prisma/migrations/20260615000000_add_run_base_branch/migration.sql`: backfill existing runs from their project default branch.
- Modify `src/lib/schemas/runs.ts`: accept optional `baseBranch` on `startRunSchema`.
- Modify `tests/unit/lib/schemas/runs.test.ts`: cover `baseBranch`.
- Create `src/lib/server/project-branches-service.ts`: branch listing, ordering, and branch validation helpers.
- Create `tests/unit/lib/server/project-branches-service.test.ts`: unit coverage for branch ordering and validation flow.
- Modify `tests/unit/lib/server/workspace.test.ts`: integration coverage for listing mirror branches with names containing `/`.
- Modify `src/lib/rfc/projects.remote.ts`: add `listProjectBranches`.
- Modify `src/lib/rfc/runs.remote.ts`: persist and validate `baseBranch`; use `run.baseBranch` for PR base.
- Move/modify `tests/unit/lib/rfc/runs.remote.test.ts`: command tests for defaulting, persistence, invalid branch rejection, and PR base. The previous colocated `src/lib/rfc/runs.remote.test.ts` path is not included by Vitest.
- Modify `src/lib/server/run-orchestrator.ts`: use `run.baseBranch` for checkout base.
- Modify `tests/unit/lib/server/run-orchestrator.test.ts`: ensure checkout uses `run.baseBranch`.
- Modify `src/lib/server/runs-service.ts`: include base/agent branch in list/detail projections where needed.
- Modify `src/routes/(app)/projects/[id]/+page.svelte`: add base branch select to the run launcher.
- Modify `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`: show `Base branch` and rename `Branch` to `Agent branch`.

---

### Task 1: Persist Base Branch On Runs

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260615000000_add_run_base_branch/migration.sql`
- Modify: `src/lib/schemas/runs.ts`
- Test: `tests/unit/lib/schemas/runs.test.ts`

- [ ] **Step 1: Write the failing schema tests**

Add these tests inside `describe('startRunSchema', ...)` in `tests/unit/lib/schemas/runs.test.ts`:

```ts
it('accepts a baseBranch when starting a run', () => {
	const parsed = startRunSchema.parse({
		projectId: 'p1',
		prompt: 'go',
		baseBranch: 'feature/login'
	});

	expect(parsed.baseBranch).toBe('feature/login');
});

it('rejects an empty baseBranch', () => {
	expect(
		startRunSchema.safeParse({
			projectId: 'p1',
			prompt: 'go',
			baseBranch: ''
		}).success
	).toBe(false);
});
```

- [ ] **Step 2: Run the schema test to verify it fails**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/schemas/runs.test.ts
```

Expected: FAIL because `baseBranch` is not part of `startRunSchema`.

- [ ] **Step 3: Add `baseBranch` to the Prisma schema**

In `prisma/schema.prisma`, add `baseBranch String` to `model Run` after `agentBranch`:

```prisma
  agentBranch           String
  baseBranch            String
  sessionId             String?
```

- [ ] **Step 4: Add the migration SQL**

Create `prisma/migrations/20260615000000_add_run_base_branch/migration.sql`:

```sql
ALTER TABLE "run" ADD COLUMN "baseBranch" TEXT;

UPDATE "run"
SET "baseBranch" = "project"."defaultBranch"
FROM "project"
WHERE "run"."projectId" = "project"."id";

ALTER TABLE "run" ALTER COLUMN "baseBranch" SET NOT NULL;
```

- [ ] **Step 5: Update the run schema**

In `src/lib/schemas/runs.ts`, update `startRunSchema`:

```ts
export const startRunSchema = z.object({
	projectId: z.string().min(1, 'Project is required'),
	prompt: z.string().min(1, 'A prompt is required'),
	baseBranch: z.string().min(1, 'Base branch is required').optional(),
	// Absent = on laisse l'agent décider (pas d'override de modèle).
	model: runModelSchema.optional(),
	useProjectAgentConfig: z.boolean().default(true)
});
```

- [ ] **Step 6: Run the schema test to verify it passes**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/schemas/runs.test.ts
```

Expected: PASS.

---

### Task 2: Add Mirror-Backed Branch Listing

**Files:**
- Create: `src/lib/server/project-branches-service.ts`
- Test: `tests/unit/lib/server/project-branches-service.test.ts`
- Modify: `src/lib/server/workspace.ts`
- Test: `tests/unit/lib/server/workspace.test.ts`

- [ ] **Step 1: Write failing unit tests for branch helpers**

Create `tests/unit/lib/server/project-branches-service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	git: vi.fn()
}));

vi.mock('$lib/server/git', () => ({
	git: mocks.git
}));

import {
	assertValidBranchName,
	orderProjectBranches
} from '$lib/server/project-branches-service';

describe('project-branches-service', () => {
	beforeEach(() => vi.resetAllMocks());

	it('orders the default branch first and de-duplicates names', () => {
		expect(orderProjectBranches(['feature/login', 'main', 'feature/login'], 'main')).toEqual([
			'main',
			'feature/login'
		]);
	});

	it('keeps non-default branches sorted alphabetically', () => {
		expect(orderProjectBranches(['zeta', 'main', 'alpha'], 'main')).toEqual([
			'main',
			'alpha',
			'zeta'
		]);
	});

	it('accepts a valid branch name through git check-ref-format', async () => {
		mocks.git.mockResolvedValue({ code: 0, stdout: 'feature/login\n', stderr: '' });

		await expect(assertValidBranchName('feature/login')).resolves.toBeUndefined();
		expect(mocks.git).toHaveBeenCalledWith(['check-ref-format', '--branch', 'feature/login'], {
			env: expect.any(Object)
		});
	});

	it('rejects an invalid branch name', async () => {
		mocks.git.mockResolvedValue({ code: 1, stdout: '', stderr: 'fatal: invalid ref' });

		await expect(assertValidBranchName('bad..branch')).rejects.toThrow(
			'Invalid base branch name'
		);
	});
});
```

- [ ] **Step 2: Run the helper tests to verify they fail**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/project-branches-service.test.ts
```

Expected: FAIL because `project-branches-service.ts` does not exist.

- [ ] **Step 3: Add a low-level mirror branch lister**

In `src/lib/server/workspace.ts`, add this import:

```ts
import { mirrorPath, runWorktreePath, agentBranch } from './workspace-paths';
```

Then add this function after `ensureMirror`:

```ts
export async function listMirrorBranches(
	projectId: string,
	env: Record<string, string | undefined> = privateEnv
): Promise<string[]> {
	const mirror = mirrorPath(workspaceRoot(env), projectId);
	const output = await gitOk(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
		cwd: mirror,
		env
	});
	return output
		.split('\n')
		.map((branch) => branch.trim())
		.filter(Boolean);
}
```

- [ ] **Step 4: Add the project branches service**

Create `src/lib/server/project-branches-service.ts`:

```ts
import { env as privateEnv } from '$env/dynamic/private';
import { git } from '$lib/server/git';
import { authedCloneUrl, makeGitAuth } from '$lib/server/github-git';
import { ensureMirror, listMirrorBranches } from '$lib/server/workspace';

export interface BranchProject {
	id: string;
	cloneUrl: string;
	defaultBranch: string;
}

export function orderProjectBranches(branches: string[], defaultBranch: string): string[] {
	const unique = [...new Set(branches.filter(Boolean))].sort((a, b) => a.localeCompare(b));
	return [defaultBranch, ...unique.filter((branch) => branch !== defaultBranch)];
}

export async function assertValidBranchName(
	branch: string,
	env: Record<string, string | undefined> = privateEnv
): Promise<void> {
	if (branch.trim() !== branch) throw new Error('Invalid base branch name');
	const result = await git(['check-ref-format', '--branch', branch], { env });
	if (result.code !== 0) throw new Error('Invalid base branch name');
}

export async function listBranchesForProject(
	project: BranchProject,
	token: string | null,
	env: Record<string, string | undefined> = privateEnv
): Promise<string[]> {
	const auth = token ? await makeGitAuth(token) : null;
	try {
		const gitEnv = auth?.env ?? env;
		const cloneUrl = token ? authedCloneUrl(project.cloneUrl) : project.cloneUrl;
		await ensureMirror(project.id, cloneUrl, gitEnv);
		const branches = await listMirrorBranches(project.id, gitEnv);
		return orderProjectBranches(branches, project.defaultBranch);
	} finally {
		await auth?.cleanup();
	}
}

export async function assertProjectBranchExists(
	project: BranchProject,
	branch: string,
	token: string | null,
	env: Record<string, string | undefined> = privateEnv
): Promise<void> {
	await assertValidBranchName(branch, env);
	const branches = await listBranchesForProject(project, token, env);
	if (!branches.includes(branch)) {
		throw new Error(`Base branch "${branch}" was not found`);
	}
}
```

- [ ] **Step 5: Run the helper tests to verify they pass**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/project-branches-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Write failing integration coverage for mirror branch listing**

In `tests/unit/lib/server/workspace.test.ts`, add `listMirrorBranches` to the import list and add this test inside `describe('workspace lifecycle', ...)`:

```ts
it('lists branches from the project mirror, including slash names', async () => {
	await gitOk(['checkout', '-b', 'feature/login'], { cwd: sourceRepo });
	await writeFile(join(sourceRepo, 'FEATURE.md'), 'feature\n');
	await gitOk(['add', '-A'], { cwd: sourceRepo });
	await gitOk(['commit', '-m', 'feature'], { cwd: sourceRepo });

	await ensureMirror('proj1', sourceRepo, env);

	await expect(listMirrorBranches('proj1', env)).resolves.toEqual(
		expect.arrayContaining(['main', 'feature/login'])
	);
});
```

- [ ] **Step 7: Run the workspace test to verify it fails**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/workspace.test.ts
```

Expected: FAIL until `listMirrorBranches` is exported and imported correctly.

- [ ] **Step 8: Fix imports and rerun workspace tests**

Ensure `tests/unit/lib/server/workspace.test.ts` imports:

```ts
import {
	ensureMirror,
	createRunCheckout,
	getHeadSha,
	listMirrorBranches,
	removeRunCheckout
} from '$lib/server/workspace';
```

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/workspace.test.ts
```

Expected: PASS.

---

### Task 3: Expose Branches And Validate Run Creation

**Files:**
- Modify: `src/lib/rfc/projects.remote.ts`
- Modify: `src/lib/rfc/runs.remote.ts`
- Test: `tests/unit/lib/rfc/runs.remote.test.ts`

- [ ] **Step 1: Extend the remote tests with branch validation mocks**

In `tests/unit/lib/rfc/runs.remote.test.ts`, add these mocks to the hoisted object:

```ts
getGithubToken: vi.fn(),
assertProjectBranchExists: vi.fn()
```

If `getGithubToken` already exists, keep the existing entry and add only `assertProjectBranchExists`.

Mock the service:

```ts
vi.mock('$lib/server/project-branches-service', () => ({
	assertProjectBranchExists: mocks.assertProjectBranchExists
}));
```

- [ ] **Step 2: Write failing `startRun` tests**

Add these tests inside `describe('runs.remote commands', ...)`:

```ts
it('persists the selected base branch when starting a run', async () => {
	mocks.projectFindFirst.mockResolvedValue({
		id: 'p1',
		cloneUrl: 'https://github.com/acme/repo.git',
		defaultBranch: 'main'
	});
	mocks.getGithubToken.mockResolvedValue('gh-token');
	mocks.assertProjectBranchExists.mockResolvedValue(undefined);
	mocks.runCreate.mockResolvedValue({ id: 'run-created' });
	mocks.enqueueRun.mockResolvedValue(undefined);

	await startRun({
		projectId: 'p1',
		prompt: 'do it',
		baseBranch: 'feature/login'
	});

	expect(mocks.assertProjectBranchExists).toHaveBeenCalledWith(
		expect.objectContaining({ id: 'p1', defaultBranch: 'main' }),
		'feature/login',
		'gh-token'
	);
	expect(mocks.runCreate).toHaveBeenCalledWith(
		expect.objectContaining({
			data: expect.objectContaining({ baseBranch: 'feature/login' })
		})
	);
});

it('defaults baseBranch to the project default branch', async () => {
	mocks.projectFindFirst.mockResolvedValue({
		id: 'p1',
		cloneUrl: 'https://github.com/acme/repo.git',
		defaultBranch: 'main'
	});
	mocks.getGithubToken.mockResolvedValue(null);
	mocks.assertProjectBranchExists.mockResolvedValue(undefined);
	mocks.runCreate.mockResolvedValue({ id: 'run-created' });
	mocks.enqueueRun.mockResolvedValue(undefined);

	await startRun({ projectId: 'p1', prompt: 'do it' });

	expect(mocks.assertProjectBranchExists).toHaveBeenCalledWith(
		expect.objectContaining({ id: 'p1', defaultBranch: 'main' }),
		'main',
		null
	);
	expect(mocks.runCreate).toHaveBeenCalledWith(
		expect.objectContaining({
			data: expect.objectContaining({ baseBranch: 'main' })
		})
	);
});

it('rejects an unknown base branch before creating a run', async () => {
	mocks.projectFindFirst.mockResolvedValue({
		id: 'p1',
		cloneUrl: 'https://github.com/acme/repo.git',
		defaultBranch: 'main'
	});
	mocks.getGithubToken.mockResolvedValue('gh-token');
	mocks.assertProjectBranchExists.mockRejectedValue(new Error('Base branch "missing" was not found'));

	await expect(
		startRun({ projectId: 'p1', prompt: 'do it', baseBranch: 'missing' })
	).rejects.toMatchObject({ status: 400 });

	expect(mocks.runCreate).not.toHaveBeenCalled();
	expect(mocks.enqueueRun).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the remote tests to verify they fail**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/rfc/runs.remote.test.ts
```

Expected: FAIL because `startRun` does not validate or persist `baseBranch`.

- [ ] **Step 4: Add `listProjectBranches` to project remote functions**

In `src/lib/rfc/projects.remote.ts`, import:

```ts
import { listBranchesForProject } from '$lib/server/project-branches-service';
```

Add this query after `getProject`:

```ts
export const listProjectBranches = query(z.string(), async (id) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const project = await getProjectForOrg(organizationId, id);
	if (!project) error(404, 'Project not found');
	const token = await getGithubToken(headers);
	return await listBranchesForProject(project, token);
});
```

- [ ] **Step 5: Update `startRun` validation and persistence**

In `src/lib/rfc/runs.remote.ts`, import:

```ts
import { assertProjectBranchExists } from '$lib/server/project-branches-service';
```

Update the command signature and body:

```ts
export const startRun = command(
	startRunSchema,
	async ({ projectId, prompt, baseBranch, model, useProjectAgentConfig }) => {
		const headers = requireHeaders();
		const organizationId = await requireActiveOrg(headers);
		const { locals } = getRequestEvent();
		const project = await prisma.project.findFirst({ where: { id: projectId, organizationId } });
		if (!project) error(404, 'Project not found');

		const effectiveBaseBranch = baseBranch ?? project.defaultBranch;
		const token = await getGithubToken(headers);
		try {
			await assertProjectBranchExists(project, effectiveBaseBranch, token);
		} catch (e) {
			error(400, e instanceof Error ? e.message : 'Invalid base branch');
		}

		if (useProjectAgentConfig) {
			try {
				await buildRunAgentConfig(organizationId, projectId, { useProjectAgentConfig: true });
			} catch (e) {
				if (e instanceof ProjectAgentConfigError) error(400, e.message);
				throw e;
			}
		}

		const id = crypto.randomUUID();
		let created = false;
		try {
			await prisma.run.create({
				data: {
					id,
					projectId,
					organizationId,
					createdById: locals.user!.id,
					prompt,
					model: model ?? null,
					useProjectAgentConfig,
					agentBranch: agentBranch(id),
					baseBranch: effectiveBaseBranch,
					status: RUN_STATUS.QUEUED,
					timeoutAt: new Date(Date.now() + TIMEOUT_MS)
				}
			});
			created = true;
			await enqueueRun(id);
		} catch (err) {
			if (created) {
				await transitionRun(id, RUN_STATUS.QUEUED, RUN_STATUS.FAILED, {
					error: String((err as Error)?.message ?? err),
					finishedAt: new Date()
				}).catch(() => {});
			}
			throw err;
		}
		await listRuns(projectId).refresh();
		return { runId: id };
	}
);
```

- [ ] **Step 6: Run the remote tests to verify they pass**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/rfc/runs.remote.test.ts
```

Expected: PASS.

---

### Task 4: Thread Base Branch Through Execution And PRs

**Files:**
- Modify: `src/lib/server/run-orchestrator.ts`
- Test: `tests/unit/lib/server/run-orchestrator.test.ts`
- Modify: `src/lib/rfc/runs.remote.ts`
- Test: `tests/unit/lib/rfc/runs.remote.test.ts`
- Modify: `src/lib/server/runs-service.ts`
- Test: `tests/unit/lib/server/runs-service.test.ts`

- [ ] **Step 1: Write failing orchestrator coverage**

In `tests/unit/lib/server/run-orchestrator.test.ts`, update `setupRun` so the mocked run includes:

```ts
baseBranch: 'feature/login',
```

Add this test inside `describe('executeRun interactions', ...)`:

```ts
it('creates the run checkout from the captured base branch', async () => {
	setupRun();
	mocks.runContainer.mockResolvedValue({ exitCode: 0, timedOut: false });

	await executeRun(runId);

	expect(mocks.createRunCheckout).toHaveBeenCalledWith('p1', runId, 'feature/login', undefined);
});
```

- [ ] **Step 2: Run the orchestrator test to verify it fails**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/run-orchestrator.test.ts
```

Expected: FAIL because `executeRun` still passes `project.defaultBranch`.

- [ ] **Step 3: Update the orchestrator checkout base**

In `src/lib/server/run-orchestrator.ts`, replace the checkout call with:

```ts
const { checkoutPath, baseSha } = await createRunCheckout(
	project.id,
	runId,
	run.baseBranch,
	auth?.env
);
```

- [ ] **Step 4: Run the orchestrator tests to verify they pass**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/run-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing PR-base coverage**

In the existing `claims awaiting_review atomically before pushing a run` mock in `tests/unit/lib/rfc/runs.remote.test.ts`, add:

```ts
baseBranch: 'feature/login',
```

Add this test:

```ts
it('opens pull requests against the run base branch', async () => {
	mocks.runFindFirst.mockResolvedValue({
		id: 'r1',
		status: 'awaiting_review',
		projectId: 'p1',
		agentBranch: 'claude/r1',
		baseBranch: 'feature/login',
		prompt: 'ship it',
		project: {
			owner: 'acme',
			name: 'repo',
			cloneUrl: 'https://github.com/acme/repo.git',
			defaultBranch: 'main'
		}
	});
	mocks.getGithubToken.mockResolvedValue('gh-token');
	mocks.runUpdateMany.mockResolvedValue({ count: 1 });
	mocks.pushBranch.mockResolvedValue(undefined);
	mocks.openPullRequest.mockResolvedValue({
		number: 42,
		url: 'https://github.com/acme/repo/pull/42',
		state: 'open'
	});
	mocks.pullRequestCreate.mockResolvedValue({ id: 'pr1' });

	await approveRun({ runId: 'r1', action: 'push_pr' });

	expect(mocks.openPullRequest).toHaveBeenCalledWith(
		'gh-token',
		'acme',
		'repo',
		'claude/r1',
		'feature/login',
		expect.any(String),
		expect.any(String)
	);
});
```

- [ ] **Step 6: Run the remote tests to verify they fail**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/rfc/runs.remote.test.ts
```

Expected: FAIL because `approveRun` still uses `project.defaultBranch`.

- [ ] **Step 7: Update PR creation to use `run.baseBranch`**

In `src/lib/rfc/runs.remote.ts`, replace the `openPullRequest` base argument:

```ts
run.baseBranch,
```

instead of:

```ts
project.defaultBranch,
```

- [ ] **Step 8: Include branch fields in run lists**

In `src/lib/server/runs-service.ts`, add `agentBranch` and `baseBranch` to `listRunsForOrg` select:

```ts
select: {
	id: true,
	status: true,
	prompt: true,
	queuedAt: true,
	finishedAt: true,
	error: true,
	agentBranch: true,
	baseBranch: true
}
```

- [ ] **Step 9: Run affected server tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/rfc/runs.remote.test.ts tests/unit/lib/server/run-orchestrator.test.ts tests/unit/lib/server/runs-service.test.ts
```

Expected: PASS.

---

### Task 5: Add Base Branch Selection To The Project Page

**Files:**
- Modify: `src/routes/(app)/projects/[id]/+page.svelte`

- [ ] **Step 1: Update imports**

In `src/routes/(app)/projects/[id]/+page.svelte`, change the project remote import to:

```ts
import { getProject, listProjectBranches } from '$lib/rfc/projects.remote';
```

- [ ] **Step 2: Add branch query and state**

Near existing derived values, add:

```ts
const branches = $derived(listProjectBranches(page.params.id!));
let baseBranch = $state('');
const availableBranches = $derived.by(() => {
	const projectDefault = project.current?.defaultBranch;
	const loaded = branches.current ?? [];
	if (!projectDefault) return loaded;
	return [projectDefault, ...loaded.filter((branch) => branch !== projectDefault)];
});
const selectedBaseBranchLabel = $derived(baseBranch || project.current?.defaultBranch || 'Base branch');
```

- [ ] **Step 3: Initialize the selected base branch from the project default**

Add this effect after state declarations:

```ts
$effect(() => {
	const defaultBranch = project.current?.defaultBranch;
	if (!defaultBranch || baseBranch) return;
	baseBranch = defaultBranch;
});
```

- [ ] **Step 4: Send `baseBranch` when starting a run**

In `handleStart`, update the `startRun` payload:

```ts
await startRun({
	projectId: page.params.id!,
	prompt,
	baseBranch: baseBranch || project.current?.defaultBranch,
	model: model || undefined,
	useProjectAgentConfig
});
```

After a successful start, reset:

```ts
baseBranch = project.current?.defaultBranch ?? '';
```

- [ ] **Step 5: Add the select UI**

In the form controls `<div class="flex flex-col gap-2 sm:flex-row sm:items-center">`, add this select before the model select:

```svelte
<div class="w-full space-y-1 sm:w-52">
	<Select.Root
		type="single"
		value={baseBranch || undefined}
		onValueChange={(v) => (baseBranch = v ?? project.current?.defaultBranch ?? '')}
		disabled={!project.current || !!branches.error || availableBranches.length === 0}
	>
		<Select.Trigger class="w-full">
			{selectedBaseBranchLabel}
		</Select.Trigger>
		<Select.Content>
			{#each availableBranches as branch (branch)}
				<Select.Item value={branch} label={branch} />
			{/each}
		</Select.Content>
	</Select.Root>
	{#if branches.error}
		<p class="text-xs text-destructive">Could not load branches. Default branch only.</p>
	{/if}
</div>
```

- [ ] **Step 6: Keep Run disabled until a base branch is available**

Update the run button disabled condition:

```svelte
disabled={starting || !prompt.trim() || !(baseBranch || project.current?.defaultBranch)}
```

- [ ] **Step 7: Run Svelte autofixer for the project page**

Call the Svelte MCP `svelte-autofixer` on the full updated `src/routes/(app)/projects/[id]/+page.svelte` contents.

Expected: no issues or suggestions. Apply any autofixer feedback and rerun until clean.

---

### Task 6: Show Base And Agent Branches On The Run Page

**Files:**
- Modify: `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte`

- [ ] **Step 1: Update the run details labels**

Replace:

```svelte
<dt class="text-muted-foreground">Branch</dt>
<dd>{run.current.agentBranch}</dd>
```

with:

```svelte
<dt class="text-muted-foreground">Base branch</dt>
<dd>{run.current.baseBranch}</dd>
<dt class="text-muted-foreground">Agent branch</dt>
<dd>{run.current.agentBranch}</dd>
```

- [ ] **Step 2: Run Svelte autofixer for the run page**

Call the Svelte MCP `svelte-autofixer` on the full updated `src/routes/(app)/projects/[id]/runs/[runId]/+page.svelte` contents.

Expected: no issues or suggestions. Apply any autofixer feedback and rerun until clean.

---

### Task 7: Final Verification

**Files:**
- All files touched above.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
bun run test:unit -- --run \
	tests/unit/lib/schemas/runs.test.ts \
	tests/unit/lib/server/project-branches-service.test.ts \
	tests/unit/lib/server/workspace.test.ts \
	tests/unit/lib/rfc/runs.remote.test.ts \
	tests/unit/lib/server/run-orchestrator.test.ts \
	tests/unit/lib/server/runs-service.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run Svelte/type checking**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 3: Run the full unit suite**

Run:

```bash
bun run test:unit -- --run
```

Expected: PASS.

- [ ] **Step 4: Review the final diff**

Run:

```bash
git diff --stat
git diff -- src/lib/rfc/runs.remote.ts src/lib/server/run-orchestrator.ts src/routes/'(app)'/projects/[id]/+page.svelte
```

Expected: diff only touches branch-selection behavior, no unrelated refactors.
