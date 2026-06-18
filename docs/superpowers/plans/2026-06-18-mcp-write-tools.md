# MCP Write Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose safe write operations over the existing remote MCP server so agents can import GitHub projects, start runs, cancel runs, reply to runs, and approve runs by opening pull requests or abandoning them.

**Architecture:** Keep `/mcp` stateless and treat MCP tools as thin adapters. Extract the existing web mutation logic into pure server services, then have both SvelteKit remote functions and MCP tools call those services with their own auth context. Multi-tenant scoping stays centralized through `organizationId`, and MCP approval exposes only `push_pr` and `abandon`.

**Tech Stack:** TypeScript, SvelteKit remote functions, Prisma/PostgreSQL, better-auth OAuth tokens, `mcp-handler`, Zod, pg-boss, Docker helpers, Vitest, Prettier.

---

## File Structure

**Modify:**

- `src/lib/server/projects-service.ts` — add GitHub project import service and import error class.
- `tests/unit/lib/server/projects-service.test.ts` — add import service tests.
- `src/lib/server/runs-service.ts` — add start/cancel/approve run mutation services and run mutation error class. The service keeps the existing web `push` action, while MCP exposes only `push_pr` and `abandon`.
- `tests/unit/lib/server/runs-service.test.ts` — add mutation service tests.
- `src/lib/rfc/projects.remote.ts` — replace inline import mutation with service call.
- `src/lib/rfc/runs.remote.ts` — replace inline start/cancel/approve logic with service calls.
- `tests/unit/lib/rfc/runs.remote.test.ts` — update mocks so remote tests assert service delegation instead of inline Prisma/git behavior.
- `src/lib/server/mcp/tools.ts` — register the 5 write tools.
- `tests/unit/lib/server/mcp/tools.test.ts` — cover tool registration, delegation, and error mapping.
- `tests/integration/lib/server/mcp/mcp.integration.test.ts` — update expected tool list from 7 tools to 12 tools.
- `docs/mcp.md` — document the new write tools and update manual verification steps.

**Do not modify:**

- `prisma/schema.prisma` — no schema change is needed for this feature.
- `src/lib/server/mcp/server.ts` and `src/routes/mcp/+server.ts` — transport/auth wiring remains unchanged.
- Project MCP config, secrets, env vars, and skills services — out of scope.

---

## Task 1: Project Import Service

**Files:**

- Modify: `src/lib/server/projects-service.ts`
- Test: `tests/unit/lib/server/projects-service.test.ts`

- [ ] **Step 1: Extend project service mocks in the test**

In `tests/unit/lib/server/projects-service.test.ts`, update the mocks at the top so project import dependencies are available:

```ts
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		project: { findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn() }
	}
}));

vi.mock('$lib/server/github', () => ({
	getRepo: vi.fn(),
	mapRepoToProjectInput: vi.fn()
}));
```

Also add imports after the existing imports:

```ts
import { getRepo, mapRepoToProjectInput } from '$lib/server/github';
import {
	listProjectsForOrg,
	getProjectForOrg,
	importGithubProjectForOrg,
	GithubProjectImportError
} from '$lib/server/projects-service';
```

Add mock handles near the existing `findMany` and `findFirst` handles:

```ts
const upsert = vi.mocked(prisma.project.upsert) as unknown as Mock;
const getRepoMock = vi.mocked(getRepo) as unknown as Mock;
const mapRepoToProjectInputMock = vi.mocked(mapRepoToProjectInput) as unknown as Mock;
```

- [ ] **Step 2: Add failing import tests**

Append these tests inside `describe('projects-service', () => { ... })`:

```ts
it('importGithubProjectForOrg refuses when GitHub is not connected', async () => {
	await expect(
		importGithubProjectForOrg({
			organizationId: 'org1',
			userId: 'user1',
			token: null,
			owner: 'acme',
			name: 'repo'
		})
	).rejects.toThrow(GithubProjectImportError);

	expect(getRepoMock).not.toHaveBeenCalled();
	expect(upsert).not.toHaveBeenCalled();
});

it('importGithubProjectForOrg fetches GitHub and upserts the project in the org', async () => {
	const repo = {
		id: 123,
		name: 'repo',
		full_name: 'acme/repo',
		private: false,
		default_branch: 'main',
		clone_url: 'https://github.com/acme/repo.git',
		owner: { login: 'acme' }
	};
	const data = {
		organizationId: 'org1',
		githubRepoId: '123',
		owner: 'acme',
		name: 'repo',
		defaultBranch: 'main',
		cloneUrl: 'https://github.com/acme/repo.git',
		private: false,
		importedById: 'user1'
	};
	getRepoMock.mockResolvedValue(repo);
	mapRepoToProjectInputMock.mockReturnValue(data);
	upsert.mockResolvedValue({ id: 'p1' });

	const result = await importGithubProjectForOrg({
		organizationId: 'org1',
		userId: 'user1',
		token: 'gh-token',
		owner: 'acme',
		name: 'repo'
	});

	expect(getRepoMock).toHaveBeenCalledWith('gh-token', 'acme', 'repo');
	expect(mapRepoToProjectInputMock).toHaveBeenCalledWith(repo, 'org1', 'user1');
	expect(upsert).toHaveBeenCalledWith({
		where: { organizationId_githubRepoId: { organizationId: 'org1', githubRepoId: '123' } },
		create: data,
		update: { defaultBranch: 'main', cloneUrl: 'https://github.com/acme/repo.git', private: false }
	});
	expect(result).toEqual({ id: 'p1' });
});
```

- [ ] **Step 3: Run the project service test to verify it fails**

Run:

```bash
bunx vitest run tests/unit/lib/server/projects-service.test.ts
```

Expected: FAIL because `importGithubProjectForOrg` and `GithubProjectImportError` are not exported yet.

- [ ] **Step 4: Implement the import service**

In `src/lib/server/projects-service.ts`, add these imports:

```ts
import { getRepo, mapRepoToProjectInput } from '$lib/server/github';
```

Add the error class after the imports:

```ts
export class GithubProjectImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GithubProjectImportError';
	}
}
```

Add the service after `getProjectForOrg`:

```ts
export async function importGithubProjectForOrg(input: {
	organizationId: string;
	userId: string;
	token: string | null;
	owner: string;
	name: string;
}): Promise<{ id: string }> {
	if (!input.token) {
		throw new GithubProjectImportError('Connect your GitHub account to continue');
	}

	const repo = await getRepo(input.token, input.owner, input.name);
	const data = mapRepoToProjectInput(repo, input.organizationId, input.userId);
	const project = await prisma.project.upsert({
		where: {
			organizationId_githubRepoId: {
				organizationId: input.organizationId,
				githubRepoId: data.githubRepoId
			}
		},
		create: data,
		update: {
			defaultBranch: data.defaultBranch,
			cloneUrl: data.cloneUrl,
			private: data.private
		}
	});
	return { id: project.id };
}
```

- [ ] **Step 5: Run the project service test to verify it passes**

Run:

```bash
bunx vitest run tests/unit/lib/server/projects-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/projects-service.ts tests/unit/lib/server/projects-service.test.ts
git commit -m "refactor(projects): extract github import service"
```

---

## Task 2: Run Mutation Services

**Files:**

- Modify: `src/lib/server/runs-service.ts`
- Test: `tests/unit/lib/server/runs-service.test.ts`

- [ ] **Step 1: Extend run service test mocks**

In `tests/unit/lib/server/runs-service.test.ts`, replace the existing mocks at the top with this expanded set:

```ts
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		project: { findFirst: vi.fn() },
		run: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
		pullRequest: { create: vi.fn() }
	}
}));
vi.mock('$lib/server/diff', () => ({ computeDiff: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
vi.mock('$lib/server/queue', () => ({ enqueueRun: vi.fn() }));
vi.mock('$lib/server/run-transitions', () => ({ transitionRun: vi.fn() }));
vi.mock('$lib/server/project-agent-config-service', () => ({
	buildRunAgentConfig: vi.fn(),
	ProjectAgentConfigError: class extends Error {}
}));
vi.mock('$lib/server/project-branches-service', () => ({
	assertProjectBranchExists: vi.fn()
}));
vi.mock('$lib/server/run-interactions-service', () => ({
	cancelPendingRunInteractions: vi.fn()
}));
vi.mock('$lib/server/docker', () => ({ killContainer: vi.fn() }));
vi.mock('$lib/server/workspace', () => ({ removeRunCheckout: vi.fn() }));
vi.mock('$lib/server/github-push', () => ({
	pushBranch: vi.fn(),
	openPullRequest: vi.fn()
}));
```

Add imports for the new dependencies:

```ts
import { enqueueRun } from '$lib/server/queue';
import { transitionRun } from '$lib/server/run-transitions';
import { buildRunAgentConfig } from '$lib/server/project-agent-config-service';
import { assertProjectBranchExists } from '$lib/server/project-branches-service';
import { cancelPendingRunInteractions } from '$lib/server/run-interactions-service';
import { killContainer } from '$lib/server/docker';
import { removeRunCheckout } from '$lib/server/workspace';
import { pushBranch, openPullRequest } from '$lib/server/github-push';
```

Extend the service import:

```ts
import {
	listRunsForOrg,
	getRunForOrg,
	getRunDiffForOrg,
	startRunForOrg,
	cancelRunForOrg,
	approveRunForOrg,
	RunMutationError,
	RunWorkspaceUnavailableError
} from '$lib/server/runs-service';
```

Add mock handles:

```ts
const projectFindFirstMock = prisma.project.findFirst as unknown as Mock;
const runCreateMock = prisma.run.create as unknown as Mock;
const pullRequestCreateMock = prisma.pullRequest.create as unknown as Mock;
const enqueueRunMock = enqueueRun as unknown as Mock;
const transitionRunMock = transitionRun as unknown as Mock;
const buildRunAgentConfigMock = buildRunAgentConfig as unknown as Mock;
const assertProjectBranchExistsMock = assertProjectBranchExists as unknown as Mock;
const cancelPendingRunInteractionsMock = cancelPendingRunInteractions as unknown as Mock;
const killContainerMock = killContainer as unknown as Mock;
const removeRunCheckoutMock = removeRunCheckout as unknown as Mock;
const pushBranchMock = pushBranch as unknown as Mock;
const openPullRequestMock = openPullRequest as unknown as Mock;
```

- [ ] **Step 2: Add failing tests for `startRunForOrg`**

Append these tests inside the existing `describe('runs-service', () => { ... })`:

```ts
it('startRunForOrg returns null when project is outside the org', async () => {
	projectFindFirstMock.mockResolvedValue(null);

	const result = await startRunForOrg({
		organizationId: 'org1',
		userId: 'user1',
		githubToken: 'gh-token',
		projectId: 'missing',
		prompt: 'ship it',
		useProjectAgentConfig: true,
		timeoutAt: new Date('2026-06-18T10:00:00Z')
	});

	expect(result).toBeNull();
	expect(runCreateMock).not.toHaveBeenCalled();
});

it('startRunForOrg validates the branch, creates the run and enqueues it', async () => {
	projectFindFirstMock.mockResolvedValue({
		id: 'p1',
		organizationId: 'org1',
		defaultBranch: 'main',
		cloneUrl: 'https://github.com/acme/repo.git'
	});
	assertProjectBranchExistsMock.mockResolvedValue(undefined);
	buildRunAgentConfigMock.mockResolvedValue({ snapshot: {} });
	runCreateMock.mockResolvedValue({ id: 'r1' });
	enqueueRunMock.mockResolvedValue(undefined);

	const timeoutAt = new Date('2026-06-18T10:00:00Z');
	const result = await startRunForOrg({
		organizationId: 'org1',
		userId: 'user1',
		githubToken: 'gh-token',
		projectId: 'p1',
		prompt: 'ship it',
		baseBranch: 'feature/mcp',
		model: 'sonnet',
		useProjectAgentConfig: true,
		timeoutAt
	});

	expect(assertProjectBranchExistsMock).toHaveBeenCalledWith(
		expect.objectContaining({ id: 'p1', defaultBranch: 'main' }),
		'feature/mcp',
		'gh-token'
	);
	expect(buildRunAgentConfigMock).toHaveBeenCalledWith('org1', 'p1', {
		useProjectAgentConfig: true
	});
	expect(runCreateMock).toHaveBeenCalledWith({
		data: expect.objectContaining({
			projectId: 'p1',
			organizationId: 'org1',
			createdById: 'user1',
			prompt: 'ship it',
			model: 'sonnet',
			useProjectAgentConfig: true,
			baseBranch: 'feature/mcp',
			status: 'queued',
			timeoutAt
		})
	});
	expect(enqueueRunMock).toHaveBeenCalledWith(expect.any(String));
	expect(result).toEqual({ runId: expect.any(String), projectId: 'p1' });
});

it('startRunForOrg marks a created run failed if enqueue fails', async () => {
	projectFindFirstMock.mockResolvedValue({
		id: 'p1',
		organizationId: 'org1',
		defaultBranch: 'main',
		cloneUrl: 'https://github.com/acme/repo.git'
	});
	assertProjectBranchExistsMock.mockResolvedValue(undefined);
	runCreateMock.mockResolvedValue({ id: 'r1' });
	enqueueRunMock.mockRejectedValue(new Error('queue unavailable'));

	await expect(
		startRunForOrg({
			organizationId: 'org1',
			userId: 'user1',
			githubToken: null,
			projectId: 'p1',
			prompt: 'ship it',
			useProjectAgentConfig: false,
			timeoutAt: new Date('2026-06-18T10:00:00Z')
		})
	).rejects.toThrow('queue unavailable');

	expect(transitionRunMock).toHaveBeenCalledWith(expect.any(String), 'queued', 'failed', {
		error: 'queue unavailable',
		finishedAt: expect.any(Date)
	});
});
```

- [ ] **Step 3: Add failing tests for `cancelRunForOrg` and `approveRunForOrg`**

Append these tests:

```ts
it('cancelRunForOrg returns null when the run is outside the org', async () => {
	runFindFirstMock.mockResolvedValue(null);
	await expect(cancelRunForOrg('org1', 'missing')).resolves.toBeNull();
	expect(transitionRunMock).not.toHaveBeenCalled();
});

it('cancelRunForOrg cancels pending interactions and kills the container when claimed', async () => {
	runFindFirstMock.mockResolvedValue({ id: 'r1', projectId: 'p1', status: 'running' });
	transitionRunMock.mockResolvedValue(true);

	const result = await cancelRunForOrg('org1', 'r1');

	expect(transitionRunMock).toHaveBeenCalledWith('r1', expect.any(Array), 'canceled', {
		finishedAt: expect.any(Date)
	});
	expect(cancelPendingRunInteractionsMock).toHaveBeenCalledWith('r1');
	expect(killContainerMock).toHaveBeenCalledWith('dotweaver-run-r1');
	expect(result).toEqual({ canceled: true, projectId: 'p1' });
});

it('approveRunForOrg refuses a run that is not awaiting review', async () => {
	runFindFirstMock.mockResolvedValue({
		id: 'r1',
		status: 'running',
		projectId: 'p1',
		project: {}
	});

	await expect(
		approveRunForOrg({
			organizationId: 'org1',
			githubToken: 'gh-token',
			runId: 'r1',
			action: 'push_pr'
		})
	).rejects.toThrow(RunMutationError);
});

it('approveRunForOrg abandons an awaiting_review run and removes the checkout', async () => {
	runFindFirstMock.mockResolvedValue({
		id: 'r1',
		status: 'awaiting_review',
		projectId: 'p1',
		project: { cloneUrl: 'https://github.com/acme/repo.git' }
	});
	transitionRunMock.mockResolvedValue(true);

	const result = await approveRunForOrg({
		organizationId: 'org1',
		githubToken: null,
		runId: 'r1',
		action: 'abandon'
	});

	expect(transitionRunMock).toHaveBeenCalledWith('r1', 'awaiting_review', 'canceled', {
		finishedAt: expect.any(Date)
	});
	expect(removeRunCheckoutMock).toHaveBeenCalledWith('p1', 'r1');
	expect(result).toEqual({ status: 'canceled', pullRequestUrl: null, projectId: 'p1' });
});

it('approveRunForOrg pushes the branch, opens a PR and completes the run', async () => {
	runFindFirstMock.mockResolvedValue({
		id: 'r1',
		status: 'awaiting_review',
		projectId: 'p1',
		agentBranch: 'codex/r1',
		baseBranch: 'feature/mcp',
		prompt: 'ship MCP writes',
		project: {
			owner: 'acme',
			name: 'repo',
			cloneUrl: 'https://github.com/acme/repo.git'
		}
	});
	transitionRunMock.mockResolvedValue(true);
	pushBranchMock.mockResolvedValue(undefined);
	openPullRequestMock.mockResolvedValue({
		number: 42,
		url: 'https://github.com/acme/repo/pull/42',
		state: 'open'
	});
	pullRequestCreateMock.mockResolvedValue({ id: 'pr1' });

	const result = await approveRunForOrg({
		organizationId: 'org1',
		githubToken: 'gh-token',
		runId: 'r1',
		action: 'push_pr'
	});

	expect(pushBranchMock).toHaveBeenCalledWith(
		expect.stringContaining('/p1/r1'),
		'https://github.com/acme/repo.git',
		'codex/r1',
		'gh-token'
	);
	expect(openPullRequestMock).toHaveBeenCalledWith(
		'gh-token',
		'acme',
		'repo',
		'codex/r1',
		'feature/mcp',
		expect.any(String),
		expect.any(String)
	);
	expect(transitionRunMock).toHaveBeenLastCalledWith('r1', 'pushing', 'completed', {
		finishedAt: expect.any(Date)
	});
	expect(result).toEqual({
		status: 'completed',
		pullRequestUrl: 'https://github.com/acme/repo/pull/42',
		projectId: 'p1'
	});
});

it('approveRunForOrg can preserve the existing web push-only action', async () => {
	runFindFirstMock.mockResolvedValue({
		id: 'r1',
		status: 'awaiting_review',
		projectId: 'p1',
		agentBranch: 'codex/r1',
		baseBranch: 'main',
		prompt: 'ship MCP writes',
		project: {
			owner: 'acme',
			name: 'repo',
			cloneUrl: 'https://github.com/acme/repo.git'
		}
	});
	transitionRunMock.mockResolvedValue(true);
	pushBranchMock.mockResolvedValue(undefined);

	const result = await approveRunForOrg({
		organizationId: 'org1',
		githubToken: 'gh-token',
		runId: 'r1',
		action: 'push'
	});

	expect(pushBranchMock).toHaveBeenCalledWith(
		expect.stringContaining('/p1/r1'),
		'https://github.com/acme/repo.git',
		'codex/r1',
		'gh-token'
	);
	expect(openPullRequestMock).not.toHaveBeenCalled();
	expect(result).toEqual({ status: 'completed', pullRequestUrl: null, projectId: 'p1' });
});
```

- [ ] **Step 4: Run the run service test to verify it fails**

Run:

```bash
bunx vitest run tests/unit/lib/server/runs-service.test.ts
```

Expected: FAIL because the mutation service exports do not exist yet.

- [ ] **Step 5: Implement run mutation service imports and error**

In `src/lib/server/runs-service.ts`, add imports:

```ts
import { enqueueRun } from '$lib/server/queue';
import { agentBranch, containerName } from '$lib/server/workspace-paths';
import { pushBranch, openPullRequest } from '$lib/server/github-push';
import { removeRunCheckout } from '$lib/server/workspace';
import { killContainer } from '$lib/server/docker';
import { buildRunAgentConfig } from '$lib/server/project-agent-config-service';
import { assertProjectBranchExists } from '$lib/server/project-branches-service';
import { cancelPendingRunInteractions } from '$lib/server/run-interactions-service';
import { RUN_STATUS, RUN_STATUS_GROUPS } from '$lib/domain/run-status';
import { transitionRun } from '$lib/server/run-transitions';
import type { RunModel } from '$lib/schemas/runs';
```

Add this error class after `RunWorkspaceUnavailableError`:

```ts
export class RunMutationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RunMutationError';
	}
}
```

- [ ] **Step 6: Implement `startRunForOrg`**

Add this function after `getRunDiffForOrg`:

```ts
export async function startRunForOrg(input: {
	organizationId: string;
	userId: string;
	githubToken: string | null;
	projectId: string;
	prompt: string;
	baseBranch?: string;
	model?: RunModel;
	useProjectAgentConfig: boolean;
	timeoutAt: Date;
}): Promise<{ runId: string; projectId: string } | null> {
	const project = await prisma.project.findFirst({
		where: { id: input.projectId, organizationId: input.organizationId }
	});
	if (!project) return null;

	const effectiveBaseBranch = input.baseBranch ?? project.defaultBranch;
	await assertProjectBranchExists(project, effectiveBaseBranch, input.githubToken);

	if (input.useProjectAgentConfig) {
		await buildRunAgentConfig(input.organizationId, input.projectId, {
			useProjectAgentConfig: true
		});
	}

	const id = crypto.randomUUID();
	let created = false;
	try {
		await prisma.run.create({
			data: {
				id,
				projectId: input.projectId,
				organizationId: input.organizationId,
				createdById: input.userId,
				prompt: input.prompt,
				model: input.model ?? null,
				useProjectAgentConfig: input.useProjectAgentConfig,
				agentBranch: agentBranch(id),
				baseBranch: effectiveBaseBranch,
				status: RUN_STATUS.QUEUED,
				timeoutAt: input.timeoutAt
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

	return { runId: id, projectId: input.projectId };
}
```

- [ ] **Step 7: Implement `cancelRunForOrg`**

Add:

```ts
export async function cancelRunForOrg(
	organizationId: string,
	runId: string
): Promise<{ canceled: boolean; projectId: string } | null> {
	const run = await prisma.run.findFirst({
		where: { id: runId, organizationId },
		select: { id: true, status: true, projectId: true }
	});
	if (!run) return null;

	const canceled = await transitionRun(runId, RUN_STATUS_GROUPS.CANCELABLE, RUN_STATUS.CANCELED, {
		finishedAt: new Date()
	});
	if (canceled) {
		await cancelPendingRunInteractions(runId);
		await killContainer(containerName(runId));
	}
	return { canceled, projectId: run.projectId };
}
```

- [ ] **Step 8: Implement `approveRunForOrg`**

Add:

```ts
export async function approveRunForOrg(input: {
	organizationId: string;
	githubToken: string | null;
	runId: string;
	action: 'push_pr' | 'push' | 'abandon';
}): Promise<{ status: string; pullRequestUrl: string | null; projectId: string } | null> {
	const run = await prisma.run.findFirst({
		where: { id: input.runId, organizationId: input.organizationId },
		include: { project: true }
	});
	if (!run) return null;
	if (run.status !== RUN_STATUS.AWAITING_REVIEW) {
		throw new RunMutationError(`Run is not awaiting review (status: ${run.status})`);
	}

	if (input.action === 'abandon') {
		const canceled = await transitionRun(
			input.runId,
			RUN_STATUS.AWAITING_REVIEW,
			RUN_STATUS.CANCELED,
			{ finishedAt: new Date() }
		);
		if (!canceled) throw new RunMutationError('Run is no longer awaiting review');
		await removeRunCheckout(run.projectId, input.runId);
		return { status: RUN_STATUS.CANCELED, pullRequestUrl: null, projectId: run.projectId };
	}

	if (!input.githubToken) {
		throw new RunMutationError('Connect your GitHub account to continue');
	}

	const claimed = await transitionRun(input.runId, RUN_STATUS.AWAITING_REVIEW, RUN_STATUS.PUSHING);
	if (!claimed) throw new RunMutationError('Run is no longer awaiting review');
	try {
		const checkout = runWorktreePath(workspaceRoot(), run.projectId, input.runId);
		await pushBranch(checkout, run.project.cloneUrl, run.agentBranch, input.githubToken);

		let pullRequestUrl: string | null = null;
		if (input.action === 'push_pr') {
			const title =
				run.prompt.split('\n')[0].slice(0, 72) || `dotWeaver run ${input.runId.slice(0, 8)}`;
			const body = `Automated changes from a dotWeaver agent run.\n\n**Prompt:**\n\n> ${run.prompt}`;
			const pr = await openPullRequest(
				input.githubToken,
				run.project.owner,
				run.project.name,
				run.agentBranch,
				run.baseBranch,
				title,
				body
			);
			await prisma.pullRequest.create({
				data: { runId: input.runId, number: pr.number, url: pr.url, state: pr.state }
			});
			pullRequestUrl = pr.url;
		}

		await transitionRun(input.runId, RUN_STATUS.PUSHING, RUN_STATUS.COMPLETED, {
			finishedAt: new Date()
		});
		return { status: RUN_STATUS.COMPLETED, pullRequestUrl, projectId: run.projectId };
	} catch (err) {
		await transitionRun(input.runId, RUN_STATUS.PUSHING, RUN_STATUS.FAILED, {
			error: String((err as Error)?.message ?? err)
		});
		throw err;
	}
}
```

- [ ] **Step 9: Run the run service test to verify it passes**

Run:

```bash
bunx vitest run tests/unit/lib/server/runs-service.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/server/runs-service.ts tests/unit/lib/server/runs-service.test.ts
git commit -m "refactor(runs): extract write mutation services"
```

---

## Task 3: Remote Function Adapters

**Files:**

- Modify: `src/lib/rfc/projects.remote.ts`
- Modify: `src/lib/rfc/runs.remote.ts`
- Modify: `tests/unit/lib/rfc/runs.remote.test.ts`

- [ ] **Step 1: Refactor project import remote function**

In `src/lib/rfc/projects.remote.ts`, remove direct imports of `prisma`, `getRepo`, and `mapRepoToProjectInput`. Import the service instead:

```ts
import {
	listProjectsForOrg,
	getProjectForOrg,
	importGithubProjectForOrg,
	GithubProjectImportError
} from '$lib/server/projects-service';
```

Replace `importProject` with:

```ts
export const importProject = command(importProjectSchema, async ({ owner, name }) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const { locals } = getRequestEvent();
	const token = await getGithubToken(headers);
	try {
		const project = await importGithubProjectForOrg({
			organizationId,
			userId: locals.user!.id,
			token,
			owner,
			name
		});
		await listProjects().refresh();
		return project;
	} catch (e) {
		if (e instanceof GithubProjectImportError) error(400, e.message);
		throw e;
	}
});
```

- [ ] **Step 2: Refactor run remote imports**

In `src/lib/rfc/runs.remote.ts`, remove imports that are now service internals:

```ts
import { prisma } from '$lib/server/prisma';
import {
	agentBranch,
	runWorktreePath,
	workspaceRoot,
	containerName
} from '$lib/server/workspace-paths';
import { enqueueRun } from '$lib/server/queue';
import { pushBranch, openPullRequest } from '$lib/server/github-push';
import { removeRunCheckout } from '$lib/server/workspace';
import { killContainer } from '$lib/server/docker';
import {
	buildRunAgentConfig,
	ProjectAgentConfigError
} from '$lib/server/project-agent-config-service';
import { assertProjectBranchExists } from '$lib/server/project-branches-service';
import { cancelPendingRunInteractions } from '$lib/server/run-interactions-service';
import { RUN_STATUS, RUN_STATUS_GROUPS } from '$lib/domain/run-status';
import { transitionRun } from '$lib/server/run-transitions';
```

Keep `getGithubToken`, `ProjectAgentConfigError`, `RunInteractionAnswerError`, `RunReplyError`, and `RUN_STATUS` only if still used. Add these imports:

```ts
import {
	listRunsForOrg,
	getRunForOrg,
	getRunDiffForOrg,
	startRunForOrg,
	cancelRunForOrg,
	approveRunForOrg,
	RunMutationError,
	RunWorkspaceUnavailableError
} from '$lib/server/runs-service';
import { ProjectAgentConfigError } from '$lib/server/project-agent-config-service';
import { RUN_STATUS } from '$lib/domain/run-status';
```

- [ ] **Step 3: Replace `startRun` remote body**

Replace the `startRun` command handler body with:

```ts
async ({ projectId, prompt, baseBranch, model, useProjectAgentConfig }) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const { locals } = getRequestEvent();
	const token = await getGithubToken(headers);
	try {
		const result = await startRunForOrg({
			organizationId,
			userId: locals.user!.id,
			githubToken: token,
			projectId,
			prompt,
			baseBranch,
			model,
			useProjectAgentConfig,
			timeoutAt: new Date(Date.now() + TIMEOUT_MS)
		});
		if (!result) error(404, 'Project not found');
		await listRuns(projectId).refresh();
		return { runId: result.runId };
	} catch (e) {
		if (e instanceof ProjectAgentConfigError || e instanceof RunMutationError)
			error(400, e.message);
		throw e;
	}
};
```

- [ ] **Step 4: Replace `cancelRun` remote body**

Replace the `cancelRun` command with:

```ts
export const cancelRun = command(z.string(), async (runId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const result = await cancelRunForOrg(organizationId, runId);
	if (!result) error(404, 'Run not found');
	await getRun(runId).refresh();
	await listRuns(result.projectId).refresh();
	return { canceled: result.canceled };
});
```

- [ ] **Step 5: Replace `approveRun` remote body**

Replace the `approveRun` command body with:

```ts
export const approveRun = command(approveRunSchema, async ({ runId, action }) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const token = await getGithubToken(headers);
	try {
		const result = await approveRunForOrg({
			organizationId,
			githubToken: token,
			runId,
			action
		});
		if (!result) error(404, 'Run not found');
		await getRun(runId).refresh();
		await listRuns(result.projectId).refresh();
		return { status: result.status, pullRequestUrl: result.pullRequestUrl };
	} catch (e) {
		if (e instanceof RunMutationError) error(400, e.message);
		throw e;
	}
});
```

- [ ] **Step 6: Update `runs.remote.test.ts` to delegation tests**

Replace the inline mutation mocks in `tests/unit/lib/rfc/runs.remote.test.ts` with service mocks:

```ts
const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	requireHeaders: vi.fn(),
	requireActiveOrg: vi.fn(),
	getGithubToken: vi.fn(),
	listRunsForOrg: vi.fn(),
	getRunForOrg: vi.fn(),
	getRunDiffForOrg: vi.fn(),
	startRunForOrg: vi.fn(),
	cancelRunForOrg: vi.fn(),
	approveRunForOrg: vi.fn(),
	answerPendingRunInteractionForOrg: vi.fn()
}));
```

Update the `$lib/server/runs-service` mock:

```ts
vi.mock('$lib/server/runs-service', () => ({
	listRunsForOrg: mocks.listRunsForOrg,
	getRunForOrg: mocks.getRunForOrg,
	getRunDiffForOrg: mocks.getRunDiffForOrg,
	startRunForOrg: mocks.startRunForOrg,
	cancelRunForOrg: mocks.cancelRunForOrg,
	approveRunForOrg: mocks.approveRunForOrg,
	RunMutationError: class extends Error {},
	RunWorkspaceUnavailableError: class extends Error {}
}));
```

Use these focused tests:

```ts
it('startRun delegates to startRunForOrg and refreshes project runs', async () => {
	mocks.getGithubToken.mockResolvedValue('gh-token');
	mocks.startRunForOrg.mockResolvedValue({ runId: 'r1', projectId: 'p1' });

	await expect(
		startRun({ projectId: 'p1', prompt: 'do it', baseBranch: 'feature/mcp' })
	).resolves.toEqual({ runId: 'r1' });

	expect(mocks.startRunForOrg).toHaveBeenCalledWith(
		expect.objectContaining({
			organizationId: 'org1',
			userId: 'user1',
			githubToken: 'gh-token',
			projectId: 'p1',
			prompt: 'do it',
			baseBranch: 'feature/mcp'
		})
	);
});

it('cancelRun delegates to cancelRunForOrg', async () => {
	mocks.cancelRunForOrg.mockResolvedValue({ canceled: true, projectId: 'p1' });

	await expect(cancelRun('r1')).resolves.toEqual({ canceled: true });
	expect(mocks.cancelRunForOrg).toHaveBeenCalledWith('org1', 'r1');
});

it('approveRun delegates push_pr to approveRunForOrg', async () => {
	mocks.getGithubToken.mockResolvedValue('gh-token');
	mocks.approveRunForOrg.mockResolvedValue({
		status: 'completed',
		pullRequestUrl: 'https://github.com/acme/repo/pull/42',
		projectId: 'p1'
	});

	await expect(approveRun({ runId: 'r1', action: 'push_pr' })).resolves.toEqual({
		status: 'completed',
		pullRequestUrl: 'https://github.com/acme/repo/pull/42'
	});
	expect(mocks.approveRunForOrg).toHaveBeenCalledWith({
		organizationId: 'org1',
		githubToken: 'gh-token',
		runId: 'r1',
		action: 'push_pr'
	});
});
```

- [ ] **Step 7: Run focused remote tests and typecheck**

Run:

```bash
bunx vitest run tests/unit/lib/rfc/runs.remote.test.ts tests/unit/lib/server/projects-service.test.ts tests/unit/lib/server/runs-service.test.ts
bun run check
```

Expected: PASS and no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/rfc/projects.remote.ts src/lib/rfc/runs.remote.ts tests/unit/lib/rfc/runs.remote.test.ts
git commit -m "refactor(mcp): share write services with remote functions"
```

---

## Task 4: MCP Write Tools

**Files:**

- Modify: `src/lib/server/mcp/tools.ts`
- Test: `tests/unit/lib/server/mcp/tools.test.ts`

- [ ] **Step 1: Extend MCP tool test mocks**

In `tests/unit/lib/server/mcp/tools.test.ts`, extend mocks:

```ts
vi.mock('$lib/server/projects-service', () => ({
	listProjectsForOrg: vi.fn(),
	getProjectForOrg: vi.fn(),
	importGithubProjectForOrg: vi.fn(),
	GithubProjectImportError: class extends Error {}
}));
vi.mock('$lib/server/runs-service', () => ({
	listRunsForOrg: vi.fn(),
	getRunForOrg: vi.fn(),
	getRunDiffForOrg: vi.fn(),
	startRunForOrg: vi.fn(),
	cancelRunForOrg: vi.fn(),
	approveRunForOrg: vi.fn(),
	RunMutationError: class extends Error {},
	RunWorkspaceUnavailableError: class extends Error {}
}));
vi.mock('$lib/server/run-reply-service', () => ({
	replyToRunForOrg: vi.fn(),
	RunReplyError: class extends Error {}
}));
vi.mock('$lib/server/github-git', () => ({ getGithubTokenForUser: vi.fn() }));
```

Update `fakeServer` to store schemas:

```ts
function fakeServer() {
	const tools: Record<string, ToolHandler> = {};
	const schemas: Record<string, unknown> = {};
	return {
		tools,
		schemas,
		tool(name: string, _desc: string, schema: unknown, handler: ToolHandler) {
			tools[name] = handler;
			schemas[name] = schema;
		}
	};
}
```

Add imports:

```ts
import { importGithubProjectForOrg } from '$lib/server/projects-service';
import { startRunForOrg, cancelRunForOrg, approveRunForOrg } from '$lib/server/runs-service';
import { replyToRunForOrg } from '$lib/server/run-reply-service';
import { getGithubTokenForUser } from '$lib/server/github-git';
import { z } from 'zod';
```

- [ ] **Step 2: Update the tool registration test**

Change the expected tool list to:

```ts
expect(Object.keys(s.tools).sort()).toEqual([
	'approve_run',
	'cancel_run',
	'get_project',
	'get_run',
	'get_run_diff',
	'import_github_project',
	'list_projects',
	'list_runs',
	'list_teams',
	'reply_to_run',
	'start_run',
	'stream_run_events'
]);
```

- [ ] **Step 3: Add failing write tool tests**

Append these tests:

```ts
it('import_github_project resolves team, gets a GitHub token and imports the repo', async () => {
	const s = fakeServer();
	registerTools(s, { userId: 'u1' });
	mockedResolveOrgContext.mockResolvedValue('org1');
	vi.mocked(getGithubTokenForUser).mockResolvedValue('gh-token');
	vi.mocked(importGithubProjectForOrg).mockResolvedValue({ id: 'p1' });

	const res = await s.tools.import_github_project({ owner: 'acme', name: 'repo', team: 'acme' });

	expect(resolveOrgContext).toHaveBeenCalledWith('u1', 'acme');
	expect(getGithubTokenForUser).toHaveBeenCalledWith('u1');
	expect(importGithubProjectForOrg).toHaveBeenCalledWith({
		organizationId: 'org1',
		userId: 'u1',
		token: 'gh-token',
		owner: 'acme',
		name: 'repo'
	});
	expect(JSON.parse(res.content[0].text)).toEqual({ id: 'p1' });
});

it('start_run resolves team and starts a queued run', async () => {
	const s = fakeServer();
	registerTools(s, { userId: 'u1' });
	mockedResolveOrgContext.mockResolvedValue('org1');
	vi.mocked(getGithubTokenForUser).mockResolvedValue('gh-token');
	vi.mocked(startRunForOrg).mockResolvedValue({ runId: 'r1', projectId: 'p1' });

	const res = await s.tools.start_run({
		projectId: 'p1',
		prompt: 'ship it',
		baseBranch: 'main',
		model: 'sonnet',
		useProjectAgentConfig: true
	});

	expect(startRunForOrg).toHaveBeenCalledWith(
		expect.objectContaining({
			organizationId: 'org1',
			userId: 'u1',
			githubToken: 'gh-token',
			projectId: 'p1',
			prompt: 'ship it',
			baseBranch: 'main',
			model: 'sonnet',
			useProjectAgentConfig: true,
			timeoutAt: expect.any(Date)
		})
	);
	expect(JSON.parse(res.content[0].text)).toEqual({ runId: 'r1' });
});

it('approve_run exposes only push_pr and abandon in its schema', () => {
	const s = fakeServer();
	registerTools(s, { userId: 'u1' });
	const schema = z.object(s.schemas.approve_run as z.ZodRawShape);

	expect(schema.safeParse({ runId: 'r1', action: 'push_pr' }).success).toBe(true);
	expect(schema.safeParse({ runId: 'r1', action: 'abandon' }).success).toBe(true);
	expect(schema.safeParse({ runId: 'r1', action: 'push' }).success).toBe(false);
});

it('approve_run returns only the MCP public response shape', async () => {
	const s = fakeServer();
	registerTools(s, { userId: 'u1' });
	mockedResolveOrgContext.mockResolvedValue('org1');
	vi.mocked(getGithubTokenForUser).mockResolvedValue('gh-token');
	vi.mocked(approveRunForOrg).mockResolvedValue({
		status: 'completed',
		pullRequestUrl: 'https://github.com/acme/repo/pull/42',
		projectId: 'p1'
	});

	const res = await s.tools.approve_run({ runId: 'r1', action: 'push_pr' });

	expect(approveRunForOrg).toHaveBeenCalledWith({
		organizationId: 'org1',
		githubToken: 'gh-token',
		runId: 'r1',
		action: 'push_pr'
	});
	expect(JSON.parse(res.content[0].text)).toEqual({
		status: 'completed',
		pullRequestUrl: 'https://github.com/acme/repo/pull/42'
	});
});

it('cancel_run and reply_to_run map not found responses to isError', async () => {
	const s = fakeServer();
	registerTools(s, { userId: 'u1' });
	mockedResolveOrgContext.mockResolvedValue('org1');
	vi.mocked(cancelRunForOrg).mockResolvedValue(null);
	vi.mocked(replyToRunForOrg).mockResolvedValue(null);

	const cancel = await s.tools.cancel_run({ runId: 'missing' });
	const reply = await s.tools.reply_to_run({ runId: 'missing', message: 'continue' });

	expect(cancel.isError).toBe(true);
	expect(cancel.content[0].text).toMatch(/run not found/i);
	expect(reply.isError).toBe(true);
	expect(reply.content[0].text).toMatch(/run not found/i);
});
```

- [ ] **Step 4: Run MCP tool test to verify it fails**

Run:

```bash
bunx vitest run tests/unit/lib/server/mcp/tools.test.ts
```

Expected: FAIL because the write tools are not registered yet.

- [ ] **Step 5: Implement tool imports and schemas**

In `src/lib/server/mcp/tools.ts`, add imports:

```ts
import { importProjectSchema } from '$lib/schemas/projects';
import { startRunSchema, runModelSchema } from '$lib/schemas/runs';
import { importGithubProjectForOrg, GithubProjectImportError } from '$lib/server/projects-service';
import {
	startRunForOrg,
	cancelRunForOrg,
	approveRunForOrg,
	RunMutationError
} from '$lib/server/runs-service';
import { replyToRunForOrg, RunReplyError } from '$lib/server/run-reply-service';
import { getGithubTokenForUser } from '$lib/server/github-git';
import { ProjectAgentConfigError } from '$lib/server/project-agent-config-service';
```

Add this timeout near the `team` schema:

```ts
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 30 * 60 * 1000);
```

Add helpers below `mapOrgError`:

```ts
function mapWriteError(e: unknown, fallback: string): ToolResult {
	const org = mapOrgError(e);
	if (org) return org;
	if (
		e instanceof GithubProjectImportError ||
		e instanceof RunMutationError ||
		e instanceof RunReplyError ||
		e instanceof ProjectAgentConfigError
	) {
		return fail(e.message);
	}
	if (e instanceof Error) return fail(e.message || fallback);
	return fail(fallback);
}

async function githubTokenForMcpUser(userId: string): Promise<string | null> {
	return await getGithubTokenForUser(userId);
}
```

- [ ] **Step 6: Register the 5 write tools**

Append these `server.tool(...)` registrations inside `registerTools` after `stream_run_events` or before it:

```ts
server.tool(
	'import_github_project',
	'Import or update a GitHub repository as a dotWeaver project in a team.',
	{ owner: importProjectSchema.shape.owner, name: importProjectSchema.shape.name, team },
	async (args: { owner: string; name: string; team?: string }): Promise<ToolResult> => {
		try {
			const organizationId = await resolveOrgContext(ctx.userId, args.team);
			const token = await githubTokenForMcpUser(ctx.userId);
			return ok(
				await importGithubProjectForOrg({
					organizationId,
					userId: ctx.userId,
					token,
					owner: args.owner,
					name: args.name
				})
			);
		} catch (e) {
			return mapWriteError(e, 'Failed to import GitHub project');
		}
	}
);

server.tool(
	'start_run',
	'Start a dotWeaver agent run for a project.',
	{
		projectId: startRunSchema.shape.projectId,
		prompt: startRunSchema.shape.prompt,
		baseBranch: startRunSchema.shape.baseBranch,
		model: runModelSchema.optional(),
		useProjectAgentConfig: z.boolean().default(true),
		team
	},
	async (args: {
		projectId: string;
		prompt: string;
		baseBranch?: string;
		model?: 'sonnet' | 'opus' | 'haiku';
		useProjectAgentConfig?: boolean;
		team?: string;
	}): Promise<ToolResult> => {
		try {
			const organizationId = await resolveOrgContext(ctx.userId, args.team);
			const token = await githubTokenForMcpUser(ctx.userId);
			const result = await startRunForOrg({
				organizationId,
				userId: ctx.userId,
				githubToken: token,
				projectId: args.projectId,
				prompt: args.prompt,
				baseBranch: args.baseBranch,
				model: args.model,
				useProjectAgentConfig: args.useProjectAgentConfig ?? true,
				timeoutAt: new Date(Date.now() + RUN_TIMEOUT_MS)
			});
			return result ? ok({ runId: result.runId }) : fail('Project not found');
		} catch (e) {
			return mapWriteError(e, 'Failed to start run');
		}
	}
);

server.tool(
	'cancel_run',
	'Cancel a queued, preparing, running, awaiting input, awaiting review, or pushing run.',
	{ runId: z.string().min(1), team },
	async (args: { runId: string; team?: string }): Promise<ToolResult> => {
		try {
			const organizationId = await resolveOrgContext(ctx.userId, args.team);
			const result = await cancelRunForOrg(organizationId, args.runId);
			return result ? ok({ canceled: result.canceled }) : fail('Run not found');
		} catch (e) {
			return mapWriteError(e, 'Failed to cancel run');
		}
	}
);

server.tool(
	'reply_to_run',
	'Reply to an awaiting_review run and resume the same agent session.',
	{ runId: z.string().min(1), message: z.string().min(1), team },
	async (args: { runId: string; message: string; team?: string }): Promise<ToolResult> => {
		try {
			const organizationId = await resolveOrgContext(ctx.userId, args.team);
			const result = await replyToRunForOrg(organizationId, {
				runId: args.runId,
				message: args.message,
				timeoutAt: new Date(Date.now() + RUN_TIMEOUT_MS)
			});
			return result ? ok({ ok: true }) : fail('Run not found');
		} catch (e) {
			return mapWriteError(e, 'Failed to reply to run');
		}
	}
);

server.tool(
	'approve_run',
	'Approve an awaiting_review run by opening a pull request, or abandon it.',
	{ runId: z.string().min(1), action: z.enum(['push_pr', 'abandon']), team },
	async (args: {
		runId: string;
		action: 'push_pr' | 'abandon';
		team?: string;
	}): Promise<ToolResult> => {
		try {
			const organizationId = await resolveOrgContext(ctx.userId, args.team);
			const token = await githubTokenForMcpUser(ctx.userId);
			const result = await approveRunForOrg({
				organizationId,
				githubToken: token,
				runId: args.runId,
				action: args.action
			});
			return result
				? ok({ status: result.status, pullRequestUrl: result.pullRequestUrl })
				: fail('Run not found');
		} catch (e) {
			return mapWriteError(e, 'Failed to approve run');
		}
	}
);
```

- [ ] **Step 7: Run MCP tool tests**

Run:

```bash
bunx vitest run tests/unit/lib/server/mcp/tools.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/server/mcp/tools.ts tests/unit/lib/server/mcp/tools.test.ts
git commit -m "feat(mcp): add write tools for projects and runs"
```

---

## Task 5: MCP Integration Expectations and Docs

**Files:**

- Modify: `tests/integration/lib/server/mcp/mcp.integration.test.ts`
- Modify: `docs/mcp.md`

- [ ] **Step 1: Update integration test expected tool count/list**

In `tests/integration/lib/server/mcp/mcp.integration.test.ts`, find the assertion that lists tools and update it to include all 12 names:

```ts
expect(toolNames.sort()).toEqual([
	'approve_run',
	'cancel_run',
	'get_project',
	'get_run',
	'get_run_diff',
	'import_github_project',
	'list_projects',
	'list_runs',
	'list_teams',
	'reply_to_run',
	'start_run',
	'stream_run_events'
]);
```

- [ ] **Step 2: Run the MCP integration test**

Run:

```bash
bunx vitest run tests/integration/lib/server/mcp/mcp.integration.test.ts
```

Expected: PASS. If the integration test mocks service modules with a fixed tool list, update those mocks with no-op functions for `importGithubProjectForOrg`, `startRunForOrg`, `cancelRunForOrg`, `approveRunForOrg`, `replyToRunForOrg`, and `getGithubTokenForUser`.

- [ ] **Step 3: Update `docs/mcp.md` scope language**

Change the top scope from read-only to read/write:

```md
**Perimetre** : read tools + write tools projets/runs
```

Replace the sentence:

```md
Tous les outils sont **read-only** en v1.
```

with:

```md
Les outils de consultation restent read-only. Les outils write permettent d'importer
un projet GitHub et de piloter le cycle de vie d'un run, avec les memes garde-fous
multi-tenant que l'UI.
```

- [ ] **Step 4: Add write tools table rows**

In the MCP tools table, add these rows after `stream_run_events`:

```md
| `import_github_project` | `{ owner, name, team? }` | Importe ou met a jour un repo GitHub comme projet dotWeaver. | `{ id }` |
| `start_run` | `{ projectId, prompt, baseBranch?, model?, useProjectAgentConfig?, team? }` | Cree un run `queued` et l'ajoute a la file d'execution. | `{ runId }` |
| `cancel_run` | `{ runId, team? }` | Annule un run cancelable et arrete le conteneur si necessaire. | `{ canceled }` |
| `reply_to_run` | `{ runId, message, team? }` | Repond a un run en `awaiting_review` et relance la meme session agent. | `{ ok: true }` |
| `approve_run` | `{ runId, action: "push_pr" | "abandon", team? }` | Ouvre une PR depuis la branche agent ou abandonne le run. | `{ status, pullRequestUrl }` |
```

Escape the pipe in the `approve_run` input if Prettier does not preserve the table:

```md
`{ runId, action: "push_pr" \| "abandon", team? }`
```

- [ ] **Step 5: Replace out-of-scope mutation note**

Replace:

```md
- Mutations : `start_run`, `cancel_run`, `approve_run` (→ v2).
```

with:

```md
- `approve_run` ne supporte pas `push` direct via MCP ; utiliser `push_pr` ou `abandon`.
- Gestion teams au-dela de `list_teams` (creation, invitations).
- Ecriture de configuration projet MCP, secrets, env vars et skills.
```

- [ ] **Step 6: Update manual verification checklist**

Change the "Liste des outils" checklist item to mention 12 tools:

```md
- [ ] **Liste des outils** — dans l'Inspector, appeler `tools/list` : confirmer que
      les 12 outils sont listes (`list_teams`, `list_projects`, `get_project`,
      `list_runs`, `get_run`, `get_run_diff`, `stream_run_events`,
      `import_github_project`, `start_run`, `cancel_run`, `reply_to_run`,
      `approve_run`).
```

Add a write flow item:

```md
- [ ] **Flow write** — appeler `import_github_project`, puis `start_run`, suivre
      avec `stream_run_events`, et terminer avec `approve_run` en `push_pr` ou
      `abandon` selon le resultat attendu.
```

- [ ] **Step 7: Format docs and run focused checks**

Run:

```bash
bunx prettier --write docs/mcp.md docs/superpowers/plans/2026-06-18-mcp-write-tools.md
bunx vitest run tests/integration/lib/server/mcp/mcp.integration.test.ts tests/unit/lib/server/mcp/tools.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add docs/mcp.md tests/integration/lib/server/mcp/mcp.integration.test.ts
git commit -m "docs(mcp): document write tools"
```

---

## Task 6: Full Verification

**Files:**

- No planned source changes.

- [ ] **Step 1: Run unit tests**

Run:

```bash
bun run test:unit -- --run
```

Expected: PASS.

- [ ] **Step 2: Run Svelte/TypeScript checks**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 3: Run formatting and lint checks**

Run:

```bash
bun run lint
```

Expected: PASS.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git status --short
git log --oneline -6
```

Expected: only intentional commits from Tasks 1-5 are present, and the worktree is clean.

- [ ] **Step 5: Manual MCP smoke if credentials are available**

Run the dev server:

```bash
bun run dev
```

Then in MCP Inspector against `http://localhost:5173/mcp`, verify:

1. `tools/list` shows 12 tools.
2. `import_github_project` returns `{ id }` for an accessible repo.
3. `start_run` returns `{ runId }`.
4. `stream_run_events` returns events for that run.
5. `approve_run` with `abandon` cancels the run, or `push_pr` opens a PR from the agent branch.

Expected: the smoke passes when OAuth, GitHub connection, database, queue worker, and runner environment are available. If any external dependency is unavailable, record the exact missing dependency in the final report.
