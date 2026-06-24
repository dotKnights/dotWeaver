# Prepared Environment Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make project setup happen once during environment preparation, then hydrate each isolated agent run from that prepared template.

**Architecture:** Keep the existing project environment profile and prepare queue, but move preparation from a disposable checkout to a durable template checkout. Runtime adapters declare which prepared artifacts can be hydrated into run workspaces, and the run orchestrator blocks stale environments instead of installing during agent execution.

**Tech Stack:** TypeScript, SvelteKit 5, Prisma, Docker runner, Bun, Vitest, Svelte component tests.

---

## Current Working Tree Note

Before executing this plan, run `git status --short`. The branch may already contain uncommitted bugfix work in:

- `src/lib/server/project-environments/prepare.ts`
- `src/lib/components/projects/EnvironmentPanel.svelte`
- `tests/unit/lib/server/project-environments/prepare.test.ts`
- `tests/unit/lib/server/docker.test.ts`
- `tests/unit/lib/components/projects/environment-panel.svelte.test.ts`

Do not revert those changes. If they are still present, keep them as the baseline and build on top of them.

## File Structure

Create:

- `src/lib/server/project-environments/hydrate.ts` -- copy declared prepared artifacts from the durable template into a run checkout.
- `tests/unit/lib/server/project-environments/hydrate.test.ts` -- filesystem tests for hydration behavior.

Modify:

- `src/lib/server/workspace-paths.ts` -- add template and metadata path helpers.
- `src/lib/server/workspace.ts` -- add durable template checkout creation.
- `src/lib/server/project-environments/types.ts` -- add prepared artifact adapter contract.
- `src/lib/server/project-environments/adapters/node.ts` -- declare `node_modules` as prepared artifact.
- `src/lib/server/project-environments/adapters/python.ts` -- declare `.venv` as prepared artifact.
- `src/lib/server/project-environments/adapters/custom.ts` -- declare no prepared artifacts.
- `src/lib/server/project-environments/prepare.ts` -- run installs inside the durable template and write non-secret metadata.
- `src/lib/server/project-environments/service.ts` -- require current prepared templates for runs and expose hydration metadata.
- `src/lib/server/run-orchestrator.ts` -- hydrate before agent config materialization and Docker launch.
- `src/lib/components/projects/EnvironmentPanel.svelte` -- make prepared/needs prepare status explicit.
- Existing tests under `tests/unit/lib/server/...` and `tests/unit/lib/components/projects/...`.

No Prisma schema change is required for this iteration. The existing fields `currentFingerprint`, `lastPreparedFingerprint`, `lastPreparedAt`, and `lastPrepareStatus` already model prepared/stale state.

---

### Task 1: Template Workspace Paths

**Files:**

- Modify: `src/lib/server/workspace-paths.ts`
- Modify: `src/lib/server/workspace.ts`
- Test: `tests/unit/lib/server/workspace-paths.test.ts`
- Test: `tests/unit/lib/server/workspace.test.ts`

- [ ] **Step 1: Write failing path tests**

Update `tests/unit/lib/server/workspace-paths.test.ts` imports:

```ts
import {
	workspaceRoot,
	mirrorPath,
	runWorktreePath,
	agentBranch,
	containerName,
	projectEnvironmentPrepareCheckoutPath,
	projectEnvironmentCachePath,
	projectEnvironmentTemplatePath,
	projectEnvironmentMetadataPath
} from '$lib/server/workspace-paths';
```

Extend the environment path test:

```ts
it('derives project environment prepare, template, metadata and cache paths', () => {
	expect(projectEnvironmentPrepareCheckoutPath('/root', 'p1', 'default')).toBe(
		'/root/p1/environment/default/checkout'
	);
	expect(projectEnvironmentTemplatePath('/root', 'p1', 'default')).toBe(
		'/root/p1/environment/default/template'
	);
	expect(projectEnvironmentMetadataPath('/root', 'p1', 'default')).toBe(
		'/root/p1/environment/default/metadata.json'
	);
	expect(projectEnvironmentCachePath('/root', 'p1')).toBe('/root/p1/cache');
});
```

- [ ] **Step 2: Write failing workspace lifecycle tests**

Update `tests/unit/lib/server/workspace.test.ts` imports:

```ts
import {
	ensureMirror,
	createEnvironmentPrepareCheckout,
	createEnvironmentTemplateCheckout,
	createRunCheckout,
	getHeadSha,
	listMirrorBranches,
	readMirrorFiles,
	removeRunCheckout
} from '$lib/server/workspace';
```

Add this test after the current prepare checkout test:

```ts
it('creates a durable template checkout for an environment profile', async () => {
	await ensureMirror('proj1', sourceRepo, env);
	const checkout = await createEnvironmentTemplateCheckout('proj1', 'default', 'main', env);

	expect(checkout.checkoutPath.endsWith('/proj1/environment/default/template')).toBe(true);
	expect(existsSync(join(checkout.checkoutPath, '.git', 'HEAD'))).toBe(true);
});
```

Add unsafe-name coverage:

```ts
it('rejects unsafe environment profile names for template checkout', async () => {
	await ensureMirror('proj1', sourceRepo, env);

	await expect(
		createEnvironmentTemplateCheckout('proj1', '../escape', 'main', env)
	).rejects.toThrow(/Invalid environment profile name/);
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/workspace-paths.test.ts tests/unit/lib/server/workspace.test.ts --run
```

Expected: FAIL because `projectEnvironmentTemplatePath`, `projectEnvironmentMetadataPath`, and `createEnvironmentTemplateCheckout` do not exist.

- [ ] **Step 4: Implement path helpers**

Add to `src/lib/server/workspace-paths.ts`:

```ts
export function projectEnvironmentTemplatePath(
	root: string,
	projectId: string,
	profileName: string
): string {
	return join(root, projectId, 'environment', profileName, 'template');
}

export function projectEnvironmentMetadataPath(
	root: string,
	projectId: string,
	profileName: string
): string {
	return join(root, projectId, 'environment', profileName, 'metadata.json');
}
```

- [ ] **Step 5: Implement template checkout**

Update imports in `src/lib/server/workspace.ts`:

```ts
import {
	workspaceRoot,
	mirrorPath,
	runWorktreePath,
	agentBranch,
	projectEnvironmentPrepareCheckoutPath,
	projectEnvironmentTemplatePath
} from './workspace-paths';
```

Add a small shared guard near the checkout functions:

```ts
function assertSafeEnvironmentProfileName(profileName: string): void {
	if (!/^[A-Za-z0-9_-]+$/.test(profileName)) {
		throw new Error('Invalid environment profile name');
	}
}
```

Use it inside `createEnvironmentPrepareCheckout`:

```ts
assertSafeEnvironmentProfileName(profileName);
```

Then add:

```ts
export async function createEnvironmentTemplateCheckout(
	projectId: string,
	profileName: string,
	baseRef: string,
	env: Record<string, string | undefined> = privateEnv
): Promise<{ checkoutPath: string; baseSha: string }> {
	assertSafeEnvironmentProfileName(profileName);
	const mirror = mirrorPath(workspaceRoot(env), projectId);
	const checkoutPath = projectEnvironmentTemplatePath(workspaceRoot(env), projectId, profileName);
	await rm(checkoutPath, { recursive: true, force: true });
	const baseSha = await gitOk(['rev-parse', baseRef], { cwd: mirror, env });
	await mkdir(dirname(checkoutPath), { recursive: true });
	await gitOk(['clone', '--no-checkout', mirror, checkoutPath], { env });
	await gitOk(['checkout', baseSha], { cwd: checkoutPath, env });
	return { checkoutPath, baseSha };
}
```

- [ ] **Step 6: Verify task**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/workspace-paths.test.ts tests/unit/lib/server/workspace.test.ts --run
```

Expected: PASS.

- [ ] **Step 7: Commit task**

```bash
git add src/lib/server/workspace-paths.ts src/lib/server/workspace.ts tests/unit/lib/server/workspace-paths.test.ts tests/unit/lib/server/workspace.test.ts
git commit -m "feat(environment): add prepared template workspace paths"
```

---

### Task 2: Runtime Prepared Artifacts And Hydration

**Files:**

- Modify: `src/lib/server/project-environments/types.ts`
- Modify: `src/lib/server/project-environments/adapters/node.ts`
- Modify: `src/lib/server/project-environments/adapters/python.ts`
- Modify: `src/lib/server/project-environments/adapters/custom.ts`
- Create: `src/lib/server/project-environments/hydrate.ts`
- Test: `tests/unit/lib/server/project-environments/adapters.test.ts`
- Test: `tests/unit/lib/server/project-environments/hydrate.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Add to `tests/unit/lib/server/project-environments/adapters.test.ts`:

```ts
import { getRuntimeAdapter } from '$lib/server/project-environments/adapters';
```

Add tests:

```ts
it('declares Node prepared artifacts', () => {
	expect(
		getRuntimeAdapter('node')?.preparedArtifacts({
			packageManager: 'bun'
		})
	).toEqual([{ path: 'node_modules' }]);
});

it('declares Python prepared artifacts', () => {
	expect(
		getRuntimeAdapter('python')?.preparedArtifacts({
			packageManager: 'uv'
		})
	).toEqual([{ path: '.venv' }]);
});

it('declares no custom prepared artifacts', () => {
	expect(
		getRuntimeAdapter('custom')?.preparedArtifacts({
			packageManager: 'custom'
		})
	).toEqual([]);
});
```

- [ ] **Step 2: Write failing hydration tests**

Create `tests/unit/lib/server/project-environments/hydrate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hydrateRunFromPreparedEnvironment } from '$lib/server/project-environments/hydrate';

async function tempRoot() {
	return mkdtemp(join(tmpdir(), 'dw-hydrate-'));
}

describe('hydrateRunFromPreparedEnvironment', () => {
	it('copies declared Node artifacts from the prepared template into the run checkout', async () => {
		const root = await tempRoot();
		try {
			const templatePath = join(root, 'template');
			const checkoutPath = join(root, 'run');
			await mkdir(join(templatePath, 'node_modules', 'left-pad'), { recursive: true });
			await mkdir(checkoutPath, { recursive: true });
			await writeFile(
				join(templatePath, 'node_modules', 'left-pad', 'index.js'),
				'module.exports = 1;'
			);

			const result = await hydrateRunFromPreparedEnvironment({
				templatePath,
				checkoutPath,
				runtime: 'node',
				packageManager: 'bun'
			});

			expect(result).toEqual({ copied: ['node_modules'], skipped: [] });
			await expect(
				readFile(join(checkoutPath, 'node_modules', 'left-pad', 'index.js'), 'utf8')
			).resolves.toBe('module.exports = 1;');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('skips missing optional artifacts', async () => {
		const root = await tempRoot();
		try {
			const templatePath = join(root, 'template');
			const checkoutPath = join(root, 'run');
			await mkdir(templatePath, { recursive: true });
			await mkdir(checkoutPath, { recursive: true });

			const result = await hydrateRunFromPreparedEnvironment({
				templatePath,
				checkoutPath,
				runtime: 'node',
				packageManager: 'bun'
			});

			expect(result).toEqual({ copied: [], skipped: ['node_modules'] });
			expect(existsSync(join(checkoutPath, 'node_modules'))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('rejects unsafe artifact paths', async () => {
		const root = await tempRoot();
		try {
			await expect(
				hydrateRunFromPreparedEnvironment({
					templatePath: join(root, 'template'),
					checkoutPath: join(root, 'run'),
					runtime: 'custom',
					packageManager: 'custom',
					artifacts: [{ path: '../escape' }]
				})
			).rejects.toThrow(/Unsafe prepared artifact path/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/project-environments/adapters.test.ts tests/unit/lib/server/project-environments/hydrate.test.ts --run
```

Expected: FAIL because `preparedArtifacts` and `hydrateRunFromPreparedEnvironment` do not exist.

- [ ] **Step 4: Extend adapter types**

Add to `src/lib/server/project-environments/types.ts`:

```ts
export interface PreparedArtifactSpec {
	path: string;
	required?: boolean;
}
```

Extend `RuntimeAdapter`:

```ts
	preparedArtifacts(input: {
		packageManager: ProjectEnvironmentPackageManager;
	}): PreparedArtifactSpec[];
```

- [ ] **Step 5: Implement adapter artifact declarations**

Add to `nodeAdapter` in `src/lib/server/project-environments/adapters/node.ts`:

```ts
	preparedArtifacts() {
		return [{ path: 'node_modules' }];
	},
```

Add to `pythonAdapter` in `src/lib/server/project-environments/adapters/python.ts`:

```ts
	preparedArtifacts() {
		return [{ path: '.venv' }];
	},
```

Add to `customAdapter` in `src/lib/server/project-environments/adapters/custom.ts`:

```ts
	preparedArtifacts() {
		return [];
	},
```

- [ ] **Step 6: Implement hydration**

Create `src/lib/server/project-environments/hydrate.ts`:

```ts
import { cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { getRuntimeAdapter } from '$lib/server/project-environments/adapters';
import type {
	ProjectEnvironmentPackageManager,
	ProjectEnvironmentRuntime
} from '$lib/domain/project-environment';
import type { PreparedArtifactSpec } from '$lib/server/project-environments/types';

export class ProjectEnvironmentHydrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectEnvironmentHydrationError';
	}
}

export interface HydrateRunFromPreparedEnvironmentInput {
	templatePath: string;
	checkoutPath: string;
	runtime: ProjectEnvironmentRuntime;
	packageManager: ProjectEnvironmentPackageManager;
	artifacts?: PreparedArtifactSpec[];
}

export interface HydrateRunFromPreparedEnvironmentResult {
	copied: string[];
	skipped: string[];
}

function assertSafeArtifactPath(path: string): void {
	const normalized = normalize(path);
	if (
		path.length === 0 ||
		isAbsolute(path) ||
		normalized === '..' ||
		normalized.startsWith(`..${sep}`) ||
		normalized.includes(`${sep}..${sep}`)
	) {
		throw new ProjectEnvironmentHydrationError(`Unsafe prepared artifact path: ${path}`);
	}
}

export async function hydrateRunFromPreparedEnvironment(
	input: HydrateRunFromPreparedEnvironmentInput
): Promise<HydrateRunFromPreparedEnvironmentResult> {
	const adapter = getRuntimeAdapter(input.runtime);
	if (!adapter) {
		throw new ProjectEnvironmentHydrationError(`Runtime adapter ${input.runtime} not found`);
	}
	const artifacts =
		input.artifacts ?? adapter.preparedArtifacts({ packageManager: input.packageManager });
	const copied: string[] = [];
	const skipped: string[] = [];

	for (const artifact of artifacts) {
		assertSafeArtifactPath(artifact.path);
		const source = join(input.templatePath, artifact.path);
		const target = join(input.checkoutPath, artifact.path);
		if (!existsSync(source)) {
			if (artifact.required) {
				throw new ProjectEnvironmentHydrationError(
					`Prepared artifact ${artifact.path} is missing from template`
				);
			}
			skipped.push(artifact.path);
			continue;
		}
		await rm(target, { recursive: true, force: true });
		await cp(source, target, { recursive: true, force: true });
		copied.push(artifact.path);
	}

	return { copied, skipped };
}
```

- [ ] **Step 7: Verify task**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/project-environments/adapters.test.ts tests/unit/lib/server/project-environments/hydrate.test.ts --run
```

Expected: PASS.

- [ ] **Step 8: Commit task**

```bash
git add src/lib/server/project-environments/types.ts src/lib/server/project-environments/adapters/node.ts src/lib/server/project-environments/adapters/python.ts src/lib/server/project-environments/adapters/custom.ts src/lib/server/project-environments/hydrate.ts tests/unit/lib/server/project-environments/adapters.test.ts tests/unit/lib/server/project-environments/hydrate.test.ts
git commit -m "feat(environment): declare prepared artifacts"
```

---

### Task 3: Prepare Into Durable Template

**Files:**

- Modify: `src/lib/server/project-environments/prepare.ts`
- Modify: `tests/unit/lib/server/project-environments/prepare.test.ts`

- [ ] **Step 1: Update prepare mocks and failing expectations**

In `tests/unit/lib/server/project-environments/prepare.test.ts`, rename the workspace mock:

```ts
createEnvironmentTemplateCheckout: vi.fn(),
```

Update the workspace mock:

```ts
vi.mock('$lib/server/workspace', () => ({
	ensureMirror: mocks.ensureMirror,
	createEnvironmentTemplateCheckout: mocks.createEnvironmentTemplateCheckout
}));
```

Update the default mock:

```ts
mocks.createEnvironmentTemplateCheckout.mockResolvedValue({ checkoutPath: '/template' });
```

Update the first test expectations:

```ts
expect(mocks.createEnvironmentTemplateCheckout).toHaveBeenCalledWith(
	'p1',
	'default',
	'main',
	expect.anything()
);
expect(mocks.buildRunArgs).toHaveBeenCalledWith(
	expect.objectContaining({
		workspacePath: '/template',
		entrypoint: '/bin/sh',
		command: ['-c', 'bun install']
	})
);
```

- [ ] **Step 2: Add metadata write expectation**

Extend the workspace-paths mock:

```ts
projectEnvironmentMetadataPath: () => '/workspaces/p1/environment/default/metadata.json';
```

Mock `node:fs/promises` at the top of the test file:

```ts
const mocks = vi.hoisted(() => ({
	// existing mocks
	writeFile: vi.fn()
}));

vi.mock('node:fs/promises', async () => {
	const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
	return { ...actual, writeFile: mocks.writeFile };
});
```

Add to the success test:

```ts
expect(mocks.writeFile).toHaveBeenCalledWith(
	'/workspaces/p1/environment/default/metadata.json',
	expect.stringContaining('"fingerprint": "fp1"')
);
expect(mocks.writeFile.mock.calls[0][1]).not.toContain('postgres://secret');
```

- [ ] **Step 3: Run test to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/project-environments/prepare.test.ts --run
```

Expected: FAIL because prepare still uses `createEnvironmentPrepareCheckout` and does not write metadata.

- [ ] **Step 4: Implement template prepare checkout**

Update imports in `src/lib/server/project-environments/prepare.ts`:

```ts
import { writeFile } from 'node:fs/promises';
import { createEnvironmentTemplateCheckout, ensureMirror } from '$lib/server/workspace';
import { projectEnvironmentMetadataPath, workspaceRoot } from '$lib/server/workspace-paths';
```

Replace:

```ts
const { checkoutPath } = await createEnvironmentPrepareCheckout(
	profile.projectId,
	profile.name,
	profile.project.defaultBranch,
	auth?.env
);
```

with:

```ts
const { checkoutPath, baseSha } = await createEnvironmentTemplateCheckout(
	profile.projectId,
	profile.name,
	profile.project.defaultBranch,
	auth?.env
);
```

After successful install and before updating the Prisma profile, write metadata:

```ts
await writeFile(
	projectEnvironmentMetadataPath(workspaceRoot(), profile.projectId, profile.name),
	`${JSON.stringify(
		{
			projectId: profile.projectId,
			profileId: profile.id,
			profileName: profile.name,
			runtime: profile.runtime,
			packageManager: profile.packageManager,
			installCommand: profile.installCommand,
			fingerprint: profile.currentFingerprint,
			baseSha,
			preparedAt: new Date().toISOString()
		},
		null,
		2
	)}\n`
);
```

Move template checkout creation before the empty-install branch so even projects with an empty install command have a durable template. In the empty-install branch, skip Docker but still materialize `.env`, write metadata, and mark the profile prepared.

- [ ] **Step 5: Verify task**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/project-environments/prepare.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit task**

```bash
git add src/lib/server/project-environments/prepare.ts tests/unit/lib/server/project-environments/prepare.test.ts
git commit -m "feat(environment): prepare durable templates"
```

---

### Task 4: Require Prepared Environments For Runs

**Files:**

- Modify: `src/lib/server/project-environments/service.ts`
- Modify: `tests/unit/lib/server/project-environments/service.test.ts`

- [ ] **Step 1: Write failing service tests**

Update the existing `builds an enabled run environment snapshot with cache mounts and prepare decision` test into two tests.

First, current prepared profile:

```ts
it('builds an enabled run environment snapshot for a current prepared profile', async () => {
	mocks.profileFindFirst.mockResolvedValue({
		id: 'env1',
		name: 'default',
		status: 'ready',
		runtime: 'node',
		packageManager: 'bun',
		installCommand: 'bun install',
		currentFingerprint: 'fp1',
		lastPreparedFingerprint: 'fp1',
		lastPrepareStatus: 'succeeded'
	});

	await expect(buildRunEnvironmentConfig('org1', 'p1')).resolves.toEqual({
		cacheMounts: [
			{
				source: '/workspaces/p1/cache/default/node/bun/install',
				target: '/root/.bun/install/cache'
			}
		],
		snapshot: {
			enabled: true,
			profileId: 'env1',
			profileName: 'default',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp1',
			lastPreparedFingerprint: 'fp1',
			lastPrepareStatus: 'succeeded',
			needsPrepare: false,
			prepared: true,
			templatePath: '/workspaces/p1/environment/default/template'
		}
	});
});
```

Second, stale profile:

```ts
it('rejects stale ready profiles instead of preparing inside a run', async () => {
	mocks.profileFindFirst.mockResolvedValue({
		id: 'env1',
		name: 'default',
		status: 'ready',
		runtime: 'node',
		packageManager: 'bun',
		installCommand: 'bun install',
		currentFingerprint: 'fp2',
		lastPreparedFingerprint: 'fp1',
		lastPrepareStatus: 'succeeded'
	});

	await expect(buildRunEnvironmentConfig('org1', 'p1')).rejects.toThrow(
		'Prepare the project environment before starting a run'
	);
});
```

Extend the `workspace-paths` mock:

```ts
projectEnvironmentTemplatePath: (root: string, projectId: string, profileName: string) =>
	`${root}/${projectId}/environment/${profileName}/template`;
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/project-environments/service.test.ts --run
```

Expected: FAIL because stale profiles still return `needsPrepare: true`.

- [ ] **Step 3: Implement current-template snapshot**

Update imports in `src/lib/server/project-environments/service.ts`:

```ts
import { projectEnvironmentCacheMounts } from '$lib/server/project-environments/cache-paths';
import { projectEnvironmentTemplatePath, workspaceRoot } from '$lib/server/workspace-paths';
```

Inside `buildRunEnvironmentConfig`, after computing `needsPrepare`, add:

```ts
if (needsPrepare) {
	throw new ProjectEnvironmentError('Prepare the project environment before starting a run');
}
```

Update the enabled snapshot:

```ts
snapshot: {
	enabled: true,
	profileId: profile.id,
	profileName: profile.name,
	runtime: profile.runtime,
	packageManager: profile.packageManager,
	installCommand: profile.installCommand,
	currentFingerprint: profile.currentFingerprint,
	lastPreparedFingerprint: profile.lastPreparedFingerprint,
	lastPrepareStatus: profile.lastPrepareStatus,
	needsPrepare: false,
	prepared: true,
	templatePath: projectEnvironmentTemplatePath(workspaceRoot(), projectId, profile.name)
}
```

Keep `prepareRunEnvironmentIfNeeded` in place for now so older tests and queued prepare behavior remain available, but do not call it from the run orchestrator after Task 5.

- [ ] **Step 4: Verify task**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/project-environments/service.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit task**

```bash
git add src/lib/server/project-environments/service.ts tests/unit/lib/server/project-environments/service.test.ts
git commit -m "feat(environment): require prepared templates for runs"
```

---

### Task 5: Hydrate Runs Before Agent Startup

**Files:**

- Modify: `src/lib/server/run-orchestrator.ts`
- Modify: `tests/unit/lib/server/run-orchestrator.test.ts`

- [ ] **Step 1: Write failing orchestrator tests**

Add a hoisted mock:

```ts
hydrateRunFromPreparedEnvironment: vi.fn(),
```

Mock the hydrate module:

```ts
vi.mock('$lib/server/project-environments/hydrate', () => ({
	hydrateRunFromPreparedEnvironment: mocks.hydrateRunFromPreparedEnvironment
}));
```

In `beforeEach`, set:

```ts
mocks.hydrateRunFromPreparedEnvironment.mockResolvedValue({
	copied: ['node_modules'],
	skipped: []
});
mocks.buildRunEnvironmentConfig.mockResolvedValue({
	snapshot: {
		enabled: true,
		profileId: 'env1',
		profileName: 'default',
		runtime: 'node',
		packageManager: 'bun',
		installCommand: 'bun install',
		currentFingerprint: 'fp1',
		lastPreparedFingerprint: 'fp1',
		lastPrepareStatus: 'succeeded',
		needsPrepare: false,
		prepared: true,
		templatePath: '/template'
	},
	cacheMounts: []
});
```

Replace the stale prepare test with:

```ts
it('hydrates the run checkout from a prepared environment before agent config and Docker', async () => {
	setupRun();
	mocks.runContainer.mockResolvedValue({ exitCode: 0, timedOut: false });

	await executeRun(runId);

	expect(mocks.hydrateRunFromPreparedEnvironment).toHaveBeenCalledWith({
		templatePath: '/template',
		checkoutPath: '/checkout',
		runtime: 'node',
		packageManager: 'bun'
	});
	expect(mocks.hydrateRunFromPreparedEnvironment.mock.invocationCallOrder[0]).toBeLessThan(
		mocks.materializeRunAgentConfig.mock.invocationCallOrder[0]
	);
	expect(mocks.materializeRunAgentConfig.mock.invocationCallOrder[0]).toBeLessThan(
		mocks.runContainer.mock.invocationCallOrder[0]
	);
	expect(mocks.prepareRunEnvironmentIfNeeded).not.toHaveBeenCalled();
});
```

Add failure coverage:

```ts
it('fails before Docker when prepared environment hydration fails', async () => {
	setupRun();
	mocks.hydrateRunFromPreparedEnvironment.mockRejectedValue(new Error('node_modules missing'));

	await executeRun(runId);

	expect(mocks.runContainer).not.toHaveBeenCalled();
	expectTransition(['queued', 'preparing', 'running', 'awaiting_input'], 'failed');
	expect(mocks.runUpdateMany).toHaveBeenCalledWith(
		expect.objectContaining({
			data: expect.objectContaining({ error: 'node_modules missing' })
		})
	);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/run-orchestrator.test.ts --run
```

Expected: FAIL because orchestrator still calls `prepareRunEnvironmentIfNeeded` and never hydrates.

- [ ] **Step 3: Implement orchestration order**

Update imports in `src/lib/server/run-orchestrator.ts`:

```ts
import { hydrateRunFromPreparedEnvironment } from '$lib/server/project-environments/hydrate';
```

Remove `prepareRunEnvironmentIfNeeded` from the service import.

Change the fresh-run setup order to:

```ts
const agentConfig = await buildRunAgentConfig(run.organizationId, project.id, {
	useProjectAgentConfig: run.useProjectAgentConfig
});

const environmentConfig = isResume
	? {
			snapshot: run.environmentSnapshot ?? { enabled: false, resume: true },
			cacheMounts: resumeEnvironmentCacheMounts({
				snapshot: run.environmentSnapshot,
				projectId: project.id
			})
		}
	: await buildRunEnvironmentConfig(run.organizationId, project.id);

if (!isResume && environmentConfig.snapshot.enabled === true) {
	const snapshot = environmentConfig.snapshot as Record<string, unknown>;
	if (
		typeof snapshot.templatePath === 'string' &&
		typeof snapshot.runtime === 'string' &&
		typeof snapshot.packageManager === 'string'
	) {
		await hydrateRunFromPreparedEnvironment({
			templatePath: snapshot.templatePath,
			checkoutPath,
			runtime: snapshot.runtime as ProjectEnvironmentRuntime,
			packageManager: snapshot.packageManager as ProjectEnvironmentPackageManager
		});
	}
}

if (run.useProjectAgentConfig) {
	await materializeRunAgentConfig(checkoutPath, agentConfig);
}
```

Keep the transition to `running` after hydration and materialization, so failed hydration leaves the run failed before the agent starts.

- [ ] **Step 4: Verify task**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/run-orchestrator.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit task**

```bash
git add src/lib/server/run-orchestrator.ts tests/unit/lib/server/run-orchestrator.test.ts
git commit -m "feat(environment): hydrate runs from prepared templates"
```

---

### Task 6: Environment Panel Prepared State

**Files:**

- Modify: `src/lib/components/projects/EnvironmentPanel.svelte`
- Test: `tests/unit/lib/components/projects/environment-panel.svelte.test.ts`

Before editing the component, use the official Svelte MCP server:

1. `mcp__svelte.list_sections`
2. Fetch relevant docs: `svelte/$state`, `svelte/$derived`, `svelte/testing`
3. After editing, run `mcp__svelte.svelte_autofixer` on `EnvironmentPanel.svelte` until it reports no issues.

- [ ] **Step 1: Write failing component tests**

Add to `tests/unit/lib/components/projects/environment-panel.svelte.test.ts`:

```ts
it('shows prepared state when the current fingerprint has been prepared', async () => {
	const screen = render(EnvironmentPanel, {
		projectId: 'p1',
		environment: readyEnvironment({
			currentFingerprint: 'fp1',
			lastPreparedFingerprint: 'fp1',
			lastPrepareStatus: 'succeeded'
		}),
		onDetect: vi.fn(),
		onSave: vi.fn(),
		onPrepare: vi.fn(),
		prepareEvents: []
	});

	await expect.element(screen.getByText('Prepared')).toBeInTheDocument();
	await expect.element(screen.queryByText('Needs prepare')).not.toBeInTheDocument();
});

it('keeps needs prepare visible when the prepared fingerprint is stale', async () => {
	const screen = render(EnvironmentPanel, {
		projectId: 'p1',
		environment: readyEnvironment({
			currentFingerprint: 'fp2',
			lastPreparedFingerprint: 'fp1',
			lastPrepareStatus: 'succeeded'
		}),
		onDetect: vi.fn(),
		onSave: vi.fn(),
		onPrepare: vi.fn(),
		prepareEvents: []
	});

	await expect.element(screen.getByText('Needs prepare')).toBeInTheDocument();
	await expect.element(screen.queryByText('Prepared')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/lib/components/projects/environment-panel.svelte.test.ts --run
```

Expected: FAIL because the panel does not display `Prepared`.

- [ ] **Step 3: Implement prepared derived state**

Add in `EnvironmentPanel.svelte` near `needsPrepare`:

```svelte
const isPrepared = $derived( !!environment?.installCommand?.trim() && environment.lastPrepareStatus
=== 'succeeded' && environment.currentFingerprint === environment.lastPreparedFingerprint );
```

Render badge beside `Needs prepare`:

```svelte
{#if isPrepared}
	<Badge variant="secondary">Prepared</Badge>
{:else if needsPrepare}
	<Badge variant="secondary">Needs prepare</Badge>
{/if}
```

- [ ] **Step 4: Run Svelte autofixer**

Call `mcp__svelte.svelte_autofixer` with the full `EnvironmentPanel.svelte` source.

Expected: no issues or suggestions.

- [ ] **Step 5: Verify task**

Run:

```bash
bun run test:unit -- tests/unit/lib/components/projects/environment-panel.svelte.test.ts --run
bun run check
```

Expected: PASS and `svelte-check found 0 errors and 0 warnings`.

- [ ] **Step 6: Commit task**

```bash
git add src/lib/components/projects/EnvironmentPanel.svelte tests/unit/lib/components/projects/environment-panel.svelte.test.ts
git commit -m "feat(environment): show prepared template state"
```

---

### Task 7: Full Verification And Manual Smoke

**Files:**

- No source files unless verification reveals a bug.

- [ ] **Step 1: Run focused unit suite**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/project-environments tests/unit/lib/server/workspace.test.ts tests/unit/lib/server/workspace-paths.test.ts tests/unit/lib/server/run-orchestrator.test.ts tests/unit/lib/components/projects/environment-panel.svelte.test.ts --run
```

Expected: all selected tests pass.

- [ ] **Step 2: Run type/Svelte check**

Run:

```bash
bun run check
```

Expected: `svelte-check found 0 errors and 0 warnings`.

- [ ] **Step 3: Run scoped formatting and lint checks**

Run:

```bash
bunx prettier --check src/lib/server/project-environments src/lib/server/workspace.ts src/lib/server/workspace-paths.ts src/lib/server/run-orchestrator.ts src/lib/components/projects/EnvironmentPanel.svelte tests/unit/lib/server/project-environments tests/unit/lib/server/workspace.test.ts tests/unit/lib/server/workspace-paths.test.ts tests/unit/lib/server/run-orchestrator.test.ts tests/unit/lib/components/projects/environment-panel.svelte.test.ts
bunx eslint src/lib/server/project-environments src/lib/server/workspace.ts src/lib/server/workspace-paths.ts src/lib/server/run-orchestrator.ts src/lib/components/projects/EnvironmentPanel.svelte tests/unit/lib/server/project-environments tests/unit/lib/server/workspace.test.ts tests/unit/lib/server/workspace-paths.test.ts tests/unit/lib/server/run-orchestrator.test.ts tests/unit/lib/components/projects/environment-panel.svelte.test.ts
```

Expected: both commands exit 0.

- [ ] **Step 4: Build runner image**

Run:

```bash
RUNNER_IMAGE=dotweaver-runner bun run runner:build-image
```

Expected: image builds successfully.

- [ ] **Step 5: Manual smoke test**

1. Start the app and runner.
2. Import or open a Bun project.
3. Click `Detect`, review `Configure`, then click `Prepare`.
4. Verify the template folder exists:

```bash
find "${WORKSPACE_ROOT:-/tmp/dotweaver-workspaces}" -path '*/environment/default/template/node_modules' -maxdepth 6 -type d
```

5. Start an agent run with this prompt:

```text
Ne modifie aucun fichier. Verifie uniquement que l'environnement est hydrate:
pwd
test -d node_modules && echo "node_modules: present" || echo "node_modules: missing"
which bun && bun --version
```

Expected: run starts without asking the agent to install dependencies and reports `node_modules: present`.

- [ ] **Step 6: Final commit if verification fixes were needed**

If Step 1-5 required any fixes, commit them:

```bash
git add <fixed-files>
git commit -m "fix(environment): stabilize prepared template hydration"
```

If no fixes were needed, do not create an empty commit.
