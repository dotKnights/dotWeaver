# Project Environment Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable project runtime environment profiles with modular detection, dependency caches, standalone preparation, and run-time preparation before agents start.

**Architecture:** Add a new `project-environments` domain beside the existing project agent config domain. Runtime adapters detect and validate Node/Python/Custom environments, services persist the `default` profile and compute fingerprints, the runner prepares dependencies in Docker with cache mounts, and the project page exposes detection/edit/prepare controls.

**Tech Stack:** SvelteKit 5 remote functions, Svelte 5 runes, Prisma/PostgreSQL, pg-boss, Docker, Bun, Vitest, Playwright.

---

## File Structure

Create:

- `prisma/migrations/20260623180000_add_project_environment/migration.sql` -- database tables and run snapshot field.
- `src/lib/domain/project-environment.ts` -- shared runtime/status constants.
- `src/lib/schemas/project-environments.ts` -- Zod schemas for profile edits, detection, preparation commands.
- `src/lib/server/project-environments/types.ts` -- server-only adapter/profile types.
- `src/lib/server/project-environments/adapters/node.ts` -- Node adapter detection, defaults and cache mounts.
- `src/lib/server/project-environments/adapters/python.ts` -- Python adapter detection, defaults and cache mounts.
- `src/lib/server/project-environments/adapters/custom.ts` -- Custom adapter.
- `src/lib/server/project-environments/adapters/index.ts` -- adapter registry and detection ranking.
- `src/lib/server/project-environments/fingerprint.ts` -- stable fingerprint creation and comparison.
- `src/lib/server/project-environments/cache-paths.ts` -- host/cache path helpers.
- `src/lib/server/project-environments/service.ts` -- CRUD, detect, event listing, prepare state transitions.
- `src/lib/server/project-environments/prepare.ts` -- Docker prepare execution and log scrubbing.
- `src/lib/rfc/project-environments.remote.ts` -- project environment remote queries/commands.
- `src/lib/components/projects/EnvironmentPanel.svelte` -- compact environment status and actions.
- `src/lib/components/projects/EnvironmentEditor.svelte` -- structured profile editor.
- `tests/unit/lib/schemas/project-environments.test.ts`
- `tests/unit/lib/server/project-environments/adapters.test.ts`
- `tests/unit/lib/server/project-environments/fingerprint.test.ts`
- `tests/unit/lib/server/project-environments/cache-paths.test.ts`
- `tests/unit/lib/server/project-environments/service.test.ts`
- `tests/unit/lib/server/project-environments/prepare.test.ts`
- `tests/unit/lib/rfc/project-environments.remote.test.ts`
- `tests/unit/lib/components/projects/environment-panel.svelte.test.ts`

Modify:

- `prisma/schema.prisma` -- add environment models, relations, enum fields and `Run.environmentSnapshot`.
- `src/lib/server/project-agent-config-service.ts` -- expose env-only materialization for prepare checkouts.
- `src/lib/server/docker.ts` -- support entrypoint/command overrides and cache mounts.
- `src/lib/server/queue.ts` -- add environment prepare queue.
- `src/runner/index.ts` -- consume both run and prepare queues.
- `src/lib/server/run-orchestrator.ts` -- prepare environment before agent launch and mount caches on agent containers.
- `src/lib/server/workspace.ts` -- create/remove prepare checkout.
- `src/lib/server/workspace-paths.ts` -- derive prepare checkout and cache paths.
- `src/routes/(app)/projects/[id]/+page.svelte` -- load and render project environment panel.
- `src/lib/components/projects/AgentConfigPanel.svelte` -- no behavior change, only keep layout compatible if needed.
- `tests/unit/lib/server/docker.test.ts`
- `tests/unit/lib/server/workspace-paths.test.ts`
- `tests/unit/lib/server/workspace.test.ts`
- `tests/unit/lib/server/run-orchestrator.test.ts`
- `tests/unit/lib/rfc/projects.remote.test.ts` if import starts detection refresh later.

## Svelte Documentation Notes

Use the official Svelte MCP docs while implementing UI and remote functions:

- `kit/remote-functions` and `kit/$app-server`: remote queries/commands must validate inputs and refresh affected queries after mutations.
- `kit/server-only-modules` and `kit/$env-dynamic-private`: environment services stay under `$lib/server`.
- `svelte/$state`, `svelte/$derived`, `svelte/$props`, `{#if}`, `{#each}`, `bind:`: new components should follow the existing Svelte 5 rune style.

Run `mcp__svelte.svelte_autofixer` on each new or modified `.svelte` component before considering the UI task complete.

---

### Task 1: Data Model And Schemas

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260623180000_add_project_environment/migration.sql`
- Create: `src/lib/domain/project-environment.ts`
- Create: `src/lib/schemas/project-environments.ts`
- Test: `tests/unit/lib/schemas/project-environments.test.ts`

- [ ] **Step 1: Write schema/domain tests**

Create `tests/unit/lib/schemas/project-environments.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	projectEnvironmentDetectSchema,
	projectEnvironmentPrepareSchema,
	projectEnvironmentProfileInputSchema
} from '$lib/schemas/project-environments';

describe('project environment schemas', () => {
	it('accepts a Node Bun default profile', () => {
		const parsed = projectEnvironmentProfileInputSchema.parse({
			projectId: 'p1',
			runtime: 'node',
			adapterId: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			testCommand: 'bun run test',
			buildCommand: 'bun run build',
			devCommand: 'bun run dev'
		});

		expect(parsed).toMatchObject({
			projectId: 'p1',
			name: 'default',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install'
		});
	});

	it('rejects mismatched runtime package managers', () => {
		expect(() =>
			projectEnvironmentProfileInputSchema.parse({
				projectId: 'p1',
				runtime: 'python',
				adapterId: 'python',
				packageManager: 'bun',
				installCommand: 'bun install'
			})
		).toThrow(/not valid for python/);
	});

	it('allows a custom profile with custom package manager', () => {
		const parsed = projectEnvironmentProfileInputSchema.parse({
			projectId: 'p1',
			runtime: 'custom',
			adapterId: 'custom',
			packageManager: 'custom',
			installCommand: 'make setup'
		});

		expect(parsed.packageManager).toBe('custom');
	});

	it('validates detect and prepare commands', () => {
		expect(projectEnvironmentDetectSchema.parse({ projectId: 'p1' })).toEqual({ projectId: 'p1' });
		expect(
			projectEnvironmentPrepareSchema.parse({ projectId: 'p1', profileId: 'env1', force: true })
		).toEqual({ projectId: 'p1', profileId: 'env1', force: true });
	});
});
```

- [ ] **Step 2: Run schema tests to verify failure**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/schemas/project-environments.test.ts
```

Expected: FAIL with module not found for `$lib/schemas/project-environments`.

- [ ] **Step 3: Add domain constants**

Create `src/lib/domain/project-environment.ts`:

```ts
export const PROJECT_ENVIRONMENT_RUNTIMES = ['node', 'python', 'custom'] as const;
export type ProjectEnvironmentRuntime = (typeof PROJECT_ENVIRONMENT_RUNTIMES)[number];

export const PROJECT_ENVIRONMENT_PACKAGE_MANAGERS = [
	'bun',
	'npm',
	'pnpm',
	'yarn',
	'uv',
	'pip',
	'poetry',
	'custom'
] as const;
export type ProjectEnvironmentPackageManager =
	(typeof PROJECT_ENVIRONMENT_PACKAGE_MANAGERS)[number];

export const PROJECT_ENVIRONMENT_STATUSES = [
	'unconfigured',
	'detected',
	'ready',
	'invalid'
] as const;
export type ProjectEnvironmentStatus = (typeof PROJECT_ENVIRONMENT_STATUSES)[number];

export const PROJECT_ENVIRONMENT_PREPARE_STATUSES = [
	'never',
	'running',
	'succeeded',
	'failed'
] as const;
export type ProjectEnvironmentPrepareStatus =
	(typeof PROJECT_ENVIRONMENT_PREPARE_STATUSES)[number];

export const PROJECT_ENVIRONMENT_PREPARE_EVENT_TYPES = [
	'system',
	'output',
	'error',
	'result'
] as const;
export type ProjectEnvironmentPrepareEventType =
	(typeof PROJECT_ENVIRONMENT_PREPARE_EVENT_TYPES)[number];

export const NODE_PACKAGE_MANAGERS = ['bun', 'npm', 'pnpm', 'yarn'] as const;
export const PYTHON_PACKAGE_MANAGERS = ['uv', 'pip', 'poetry'] as const;
```

- [ ] **Step 4: Add Zod schemas**

Create `src/lib/schemas/project-environments.ts`:

```ts
import { z } from 'zod';
import {
	NODE_PACKAGE_MANAGERS,
	PROJECT_ENVIRONMENT_PACKAGE_MANAGERS,
	PROJECT_ENVIRONMENT_RUNTIMES,
	PYTHON_PACKAGE_MANAGERS
} from '$lib/domain/project-environment';

export const projectEnvironmentRuntimeSchema = z.enum(PROJECT_ENVIRONMENT_RUNTIMES);
export const projectEnvironmentPackageManagerSchema = z.enum(
	PROJECT_ENVIRONMENT_PACKAGE_MANAGERS
);

const commandSchema = z
	.string()
	.trim()
	.max(500)
	.refine((value) => !value.includes('\0'), 'Command cannot contain null bytes')
	.default('');

export const projectEnvironmentProfileInputSchema = z
	.object({
		projectId: z.string().min(1),
		name: z.literal('default').default('default'),
		runtime: projectEnvironmentRuntimeSchema,
		adapterId: z.enum(['node', 'python', 'custom']),
		packageManager: projectEnvironmentPackageManagerSchema,
		installCommand: commandSchema,
		testCommand: commandSchema,
		buildCommand: commandSchema,
		devCommand: commandSchema
	})
	.superRefine((input, ctx) => {
		if (input.runtime === 'node' && !NODE_PACKAGE_MANAGERS.includes(input.packageManager as never)) {
			ctx.addIssue({
				code: 'custom',
				path: ['packageManager'],
				message: `${input.packageManager} is not valid for node`
			});
		}
		if (
			input.runtime === 'python' &&
			!PYTHON_PACKAGE_MANAGERS.includes(input.packageManager as never)
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['packageManager'],
				message: `${input.packageManager} is not valid for python`
			});
		}
		if (input.runtime === 'custom' && input.packageManager !== 'custom') {
			ctx.addIssue({
				code: 'custom',
				path: ['packageManager'],
				message: `${input.packageManager} is not valid for custom`
			});
		}
		if (input.adapterId !== input.runtime) {
			ctx.addIssue({
				code: 'custom',
				path: ['adapterId'],
				message: `Adapter ${input.adapterId} does not match runtime ${input.runtime}`
			});
		}
	});

export type ProjectEnvironmentProfileInput = z.infer<
	typeof projectEnvironmentProfileInputSchema
>;

export const projectEnvironmentProjectIdSchema = z.object({
	projectId: z.string().min(1)
});

export const projectEnvironmentDetectSchema = projectEnvironmentProjectIdSchema;

export const projectEnvironmentPrepareSchema = projectEnvironmentProjectIdSchema.extend({
	profileId: z.string().min(1),
	force: z.boolean().default(false)
});
```

- [ ] **Step 5: Update Prisma schema**

In `prisma/schema.prisma`, add enums after `ProjectSkillSource`:

```prisma
enum ProjectEnvironmentRuntime {
  node
  python
  custom
}

enum ProjectEnvironmentPackageManager {
  bun
  npm
  pnpm
  yarn
  uv
  pip
  poetry
  custom
}

enum ProjectEnvironmentStatus {
  unconfigured
  detected
  ready
  invalid
}

enum ProjectEnvironmentPrepareStatus {
  never
  running
  succeeded
  failed
}

enum ProjectEnvironmentPrepareEventType {
  system
  output
  error
  result
}
```

Add relation on `Project`:

```prisma
  environmentProfiles ProjectEnvironmentProfile[]
```

Add relation on `User`:

```prisma
  projectEnvironmentProfiles ProjectEnvironmentProfile[]
```

Add models before `Run`:

```prisma
model ProjectEnvironmentProfile {
  id                      String                          @id @default(cuid())
  projectId               String
  project                 Project                         @relation(fields: [projectId, organizationId], references: [id, organizationId], onDelete: Cascade)
  organizationId          String
  name                    String                          @default("default")
  runtime                 ProjectEnvironmentRuntime
  adapterId               String
  adapterVersion          String
  packageManager          ProjectEnvironmentPackageManager
  installCommand          String                          @default("")
  testCommand             String                          @default("")
  buildCommand            String                          @default("")
  devCommand              String                          @default("")
  status                  ProjectEnvironmentStatus        @default(detected)
  detection               Json                            @default("{}")
  warnings                Json                            @default("[]")
  currentFingerprint      String?
  lastPreparedFingerprint String?
  lastPreparedAt          DateTime?
  lastPrepareStatus       ProjectEnvironmentPrepareStatus @default(never)
  lastPrepareError        String?
  createdById             String
  createdBy               User                            @relation(fields: [createdById], references: [id], onDelete: Cascade)
  createdAt               DateTime                        @default(now())
  updatedAt               DateTime                        @updatedAt
  prepareEvents           ProjectEnvironmentPrepareEvent[]

  @@unique([projectId, name])
  @@index([organizationId, projectId])
  @@map("project_environment_profile")
}

model ProjectEnvironmentPrepareEvent {
  id             String                             @id @default(cuid())
  profileId      String
  profile        ProjectEnvironmentProfile          @relation(fields: [profileId], references: [id], onDelete: Cascade)
  projectId      String
  organizationId String
  seq            Int
  type           ProjectEnvironmentPrepareEventType
  payload        Json
  createdAt      DateTime                           @default(now())

  @@unique([profileId, seq])
  @@index([organizationId, projectId, profileId])
  @@map("project_environment_prepare_event")
}
```

Add to `Run`:

```prisma
  environmentSnapshot   Json?
```

- [ ] **Step 6: Add SQL migration**

Create `prisma/migrations/20260623180000_add_project_environment/migration.sql`:

```sql
CREATE TYPE "ProjectEnvironmentRuntime" AS ENUM ('node', 'python', 'custom');
CREATE TYPE "ProjectEnvironmentPackageManager" AS ENUM ('bun', 'npm', 'pnpm', 'yarn', 'uv', 'pip', 'poetry', 'custom');
CREATE TYPE "ProjectEnvironmentStatus" AS ENUM ('unconfigured', 'detected', 'ready', 'invalid');
CREATE TYPE "ProjectEnvironmentPrepareStatus" AS ENUM ('never', 'running', 'succeeded', 'failed');
CREATE TYPE "ProjectEnvironmentPrepareEventType" AS ENUM ('system', 'output', 'error', 'result');

ALTER TABLE "run" ADD COLUMN "environmentSnapshot" JSONB;

CREATE TABLE "project_environment_profile" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'default',
    "runtime" "ProjectEnvironmentRuntime" NOT NULL,
    "adapterId" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "packageManager" "ProjectEnvironmentPackageManager" NOT NULL,
    "installCommand" TEXT NOT NULL DEFAULT '',
    "testCommand" TEXT NOT NULL DEFAULT '',
    "buildCommand" TEXT NOT NULL DEFAULT '',
    "devCommand" TEXT NOT NULL DEFAULT '',
    "status" "ProjectEnvironmentStatus" NOT NULL DEFAULT 'detected',
    "detection" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "warnings" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "currentFingerprint" TEXT,
    "lastPreparedFingerprint" TEXT,
    "lastPreparedAt" TIMESTAMP(3),
    "lastPrepareStatus" "ProjectEnvironmentPrepareStatus" NOT NULL DEFAULT 'never',
    "lastPrepareError" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "project_environment_profile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_environment_prepare_event" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" "ProjectEnvironmentPrepareEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_environment_prepare_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_environment_profile_projectId_name_key" ON "project_environment_profile"("projectId", "name");
CREATE INDEX "project_environment_profile_organizationId_projectId_idx" ON "project_environment_profile"("organizationId", "projectId");
CREATE UNIQUE INDEX "project_environment_prepare_event_profileId_seq_key" ON "project_environment_prepare_event"("profileId", "seq");
CREATE INDEX "project_environment_prepare_event_organizationId_projectId_profileId_idx" ON "project_environment_prepare_event"("organizationId", "projectId", "profileId");

ALTER TABLE "project_environment_profile"
ADD CONSTRAINT "project_environment_profile_projectId_organizationId_fkey"
FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_environment_profile"
ADD CONSTRAINT "project_environment_profile_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "user"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_environment_prepare_event"
ADD CONSTRAINT "project_environment_prepare_event_profileId_fkey"
FOREIGN KEY ("profileId") REFERENCES "project_environment_profile"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 7: Run schema tests and Prisma validation**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/schemas/project-environments.test.ts
bunx prisma validate
```

Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260623180000_add_project_environment/migration.sql src/lib/domain/project-environment.ts src/lib/schemas/project-environments.ts tests/unit/lib/schemas/project-environments.test.ts
git commit -m "feat(environment): add project environment schema"
```

---

### Task 2: Runtime Adapters, Fingerprints, And Cache Paths

**Files:**

- Create: `src/lib/server/project-environments/types.ts`
- Create: `src/lib/server/project-environments/adapters/node.ts`
- Create: `src/lib/server/project-environments/adapters/python.ts`
- Create: `src/lib/server/project-environments/adapters/custom.ts`
- Create: `src/lib/server/project-environments/adapters/index.ts`
- Create: `src/lib/server/project-environments/fingerprint.ts`
- Create: `src/lib/server/project-environments/cache-paths.ts`
- Modify: `src/lib/server/workspace-paths.ts`
- Test: `tests/unit/lib/server/project-environments/adapters.test.ts`
- Test: `tests/unit/lib/server/project-environments/fingerprint.test.ts`
- Test: `tests/unit/lib/server/project-environments/cache-paths.test.ts`
- Test: `tests/unit/lib/server/workspace-paths.test.ts`

- [ ] **Step 1: Write adapter tests**

Create `tests/unit/lib/server/project-environments/adapters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { detectProjectEnvironment } from '$lib/server/project-environments/adapters';

describe('project environment adapters', () => {
	it('detects Bun Node projects from package.json and bun.lock', () => {
		const result = detectProjectEnvironment({
			files: {
				'package.json': JSON.stringify({
					scripts: { test: 'vitest', build: 'vite build', dev: 'vite dev' }
				}),
				'bun.lock': ''
			}
		});

		expect(result.runtime).toBe('node');
		expect(result.packageManager).toBe('bun');
		expect(result.installCommand).toBe('bun install');
		expect(result.testCommand).toBe('bun run test');
		expect(result.buildCommand).toBe('bun run build');
		expect(result.devCommand).toBe('bun run dev');
		expect(result.confidence).toBeGreaterThan(80);
	});

	it('detects pnpm before npm when pnpm lock exists', () => {
		const result = detectProjectEnvironment({
			files: {
				'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
				'pnpm-lock.yaml': 'lockfileVersion: 9'
			}
		});

		expect(result.runtime).toBe('node');
		expect(result.packageManager).toBe('pnpm');
		expect(result.installCommand).toBe('pnpm install');
		expect(result.testCommand).toBe('pnpm run test');
	});

	it('detects Python uv projects from pyproject.toml and uv.lock', () => {
		const result = detectProjectEnvironment({
			files: {
				'pyproject.toml': '[project]\nname = "demo"\n',
				'uv.lock': 'version = 1\n'
			}
		});

		expect(result.runtime).toBe('python');
		expect(result.packageManager).toBe('uv');
		expect(result.installCommand).toBe('uv sync');
	});

	it('falls back to custom for unknown projects', () => {
		const result = detectProjectEnvironment({ files: { 'README.md': '# demo\n' } });

		expect(result.runtime).toBe('custom');
		expect(result.packageManager).toBe('custom');
		expect(result.installCommand).toBe('');
		expect(result.warnings).toContain('No supported runtime files detected');
	});
});
```

- [ ] **Step 2: Write fingerprint tests**

Create `tests/unit/lib/server/project-environments/fingerprint.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	buildProjectEnvironmentFingerprint,
	needsProjectEnvironmentPrepare
} from '$lib/server/project-environments/fingerprint';

describe('project environment fingerprint', () => {
	it('is stable and excludes env values', () => {
		const first = buildProjectEnvironmentFingerprint({
			adapterId: 'node',
			adapterVersion: '1',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			lockfiles: [{ path: 'bun.lock', content: 'lock-data' }],
			envKeys: ['DATABASE_URL', 'PUBLIC_API_URL']
		});
		const second = buildProjectEnvironmentFingerprint({
			adapterId: 'node',
			adapterVersion: '1',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			lockfiles: [{ path: 'bun.lock', content: 'lock-data' }],
			envKeys: ['PUBLIC_API_URL', 'DATABASE_URL']
		});

		expect(first).toBe(second);
		expect(first).toMatch(/^[a-f0-9]{64}$/);
		expect(first).not.toContain('postgres');
	});

	it('marks prepare as needed unless the previous success matches the current fingerprint', () => {
		expect(
			needsProjectEnvironmentPrepare({
				currentFingerprint: 'a',
				lastPreparedFingerprint: 'a',
				lastPrepareStatus: 'succeeded',
				installCommand: 'bun install'
			})
		).toBe(false);

		expect(
			needsProjectEnvironmentPrepare({
				currentFingerprint: 'b',
				lastPreparedFingerprint: 'a',
				lastPrepareStatus: 'succeeded',
				installCommand: 'bun install'
			})
		).toBe(true);

		expect(
			needsProjectEnvironmentPrepare({
				currentFingerprint: 'a',
				lastPreparedFingerprint: 'a',
				lastPrepareStatus: 'failed',
				installCommand: 'bun install'
			})
		).toBe(true);

		expect(
			needsProjectEnvironmentPrepare({
				currentFingerprint: 'a',
				lastPreparedFingerprint: null,
				lastPrepareStatus: 'never',
				installCommand: ''
			})
		).toBe(false);
	});
});
```

- [ ] **Step 3: Write cache path tests**

Create `tests/unit/lib/server/project-environments/cache-paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { projectEnvironmentCacheMounts } from '$lib/server/project-environments/cache-paths';

describe('project environment cache paths', () => {
	it('maps Bun caches to deterministic host and container paths', () => {
		const mounts = projectEnvironmentCacheMounts({
			root: '/workspaces',
			projectId: 'p1',
			profileName: 'default',
			runtime: 'node',
			packageManager: 'bun'
		});

		expect(mounts).toEqual([
			{
				source: '/workspaces/p1/cache/default/node/bun/install',
				target: '/root/.bun/install/cache'
			}
		]);
	});

	it('returns no automatic mounts for custom package managers', () => {
		expect(
			projectEnvironmentCacheMounts({
				root: '/workspaces',
				projectId: 'p1',
				profileName: 'default',
				runtime: 'custom',
				packageManager: 'custom'
			})
		).toEqual([]);
	});
});
```

- [ ] **Step 4: Run adapter/fingerprint tests to verify failure**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/project-environments/adapters.test.ts tests/unit/lib/server/project-environments/fingerprint.test.ts tests/unit/lib/server/project-environments/cache-paths.test.ts
```

Expected: FAIL with module not found under `$lib/server/project-environments`.

- [ ] **Step 5: Add server-only types**

Create `src/lib/server/project-environments/types.ts`:

```ts
import type {
	ProjectEnvironmentPackageManager,
	ProjectEnvironmentRuntime
} from '$lib/domain/project-environment';

export type DetectionFiles = Record<string, string | null>;

export interface DetectionInput {
	files: DetectionFiles;
}

export interface EnvironmentCommands {
	installCommand: string;
	testCommand: string;
	buildCommand: string;
	devCommand: string;
}

export interface DetectionResult extends EnvironmentCommands {
	runtime: ProjectEnvironmentRuntime;
	adapterId: string;
	adapterVersion: string;
	packageManager: ProjectEnvironmentPackageManager;
	confidence: number;
	detectedFiles: string[];
	warnings: string[];
	detection: Record<string, unknown>;
}

export interface CacheMountSpec {
	source: string;
	target: string;
	readOnly?: boolean;
}

export interface RuntimeAdapter {
	id: ProjectEnvironmentRuntime;
	label: string;
	version: string;
	detect(input: DetectionInput): DetectionResult | null;
	cacheMounts(input: {
		root: string;
		projectId: string;
		profileName: string;
		packageManager: ProjectEnvironmentPackageManager;
	}): CacheMountSpec[];
	validate(input: {
		packageManager: ProjectEnvironmentPackageManager;
		installCommand: string;
	}): { warnings: string[]; errors: string[] };
}
```

- [ ] **Step 6: Implement cache paths**

Create `src/lib/server/project-environments/cache-paths.ts`:

```ts
import { join } from 'node:path';
import type {
	ProjectEnvironmentPackageManager,
	ProjectEnvironmentRuntime
} from '$lib/domain/project-environment';
import type { CacheMountSpec } from '$lib/server/project-environments/types';

export function projectEnvironmentCacheRoot(input: {
	root: string;
	projectId: string;
	profileName: string;
	runtime: ProjectEnvironmentRuntime;
	packageManager: ProjectEnvironmentPackageManager;
}): string {
	return join(input.root, input.projectId, 'cache', input.profileName, input.runtime, input.packageManager);
}

export function projectEnvironmentCacheMounts(input: {
	root: string;
	projectId: string;
	profileName: string;
	runtime: ProjectEnvironmentRuntime;
	packageManager: ProjectEnvironmentPackageManager;
}): CacheMountSpec[] {
	const base = projectEnvironmentCacheRoot(input);
	switch (input.packageManager) {
		case 'bun':
			return [{ source: join(base, 'install'), target: '/root/.bun/install/cache' }];
		case 'npm':
			return [{ source: join(base, 'npm'), target: '/root/.npm' }];
		case 'pnpm':
			return [{ source: join(base, 'store'), target: '/root/.local/share/pnpm/store' }];
		case 'yarn':
			return [{ source: join(base, 'yarn'), target: '/root/.cache/yarn' }];
		case 'uv':
			return [{ source: join(base, 'uv'), target: '/root/.cache/uv' }];
		case 'pip':
			return [{ source: join(base, 'pip'), target: '/root/.cache/pip' }];
		case 'poetry':
			return [{ source: join(base, 'poetry'), target: '/root/.cache/pypoetry' }];
		case 'custom':
			return [];
	}
}
```

- [ ] **Step 7: Implement adapters**

Create `src/lib/server/project-environments/adapters/node.ts`:

```ts
import { projectEnvironmentCacheMounts } from '$lib/server/project-environments/cache-paths';
import type { DetectionInput, DetectionResult, RuntimeAdapter } from '$lib/server/project-environments/types';

const VERSION = '1';

function has(input: DetectionInput, path: string): boolean {
	return input.files[path] !== undefined && input.files[path] !== null;
}

function readPackageJson(input: DetectionInput): { scripts?: Record<string, string> } {
	const raw = input.files['package.json'];
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === 'object' && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

function packageManager(input: DetectionInput): DetectionResult['packageManager'] {
	if (has(input, 'bun.lock')) return 'bun';
	if (has(input, 'pnpm-lock.yaml')) return 'pnpm';
	if (has(input, 'yarn.lock')) return 'yarn';
	if (has(input, 'package-lock.json')) return 'npm';
	return 'npm';
}

function runCommand(pm: DetectionResult['packageManager'], script: string): string {
	return pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`;
}

export const nodeAdapter: RuntimeAdapter = {
	id: 'node',
	label: 'Node.js',
	version: VERSION,
	detect(input) {
		if (!has(input, 'package.json')) return null;
		const pm = packageManager(input);
		const pkg = readPackageJson(input);
		const scripts = pkg.scripts ?? {};
		const detectedFiles = ['package.json'].filter((path) => has(input, path));
		for (const lock of ['bun.lock', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']) {
			if (has(input, lock)) detectedFiles.push(lock);
		}
		return {
			runtime: 'node',
			adapterId: 'node',
			adapterVersion: VERSION,
			packageManager: pm,
			confidence: detectedFiles.length > 1 ? 95 : 75,
			detectedFiles,
			warnings: detectedFiles.length === 1 ? ['No JavaScript lockfile detected'] : [],
			detection: { scripts: Object.keys(scripts) },
			installCommand: `${pm} install`,
			testCommand: scripts.test ? runCommand(pm, 'test') : '',
			buildCommand: scripts.build ? runCommand(pm, 'build') : '',
			devCommand: scripts.dev ? runCommand(pm, 'dev') : ''
		};
	},
	cacheMounts(input) {
		return projectEnvironmentCacheMounts({ ...input, runtime: 'node' });
	},
	validate(input) {
		const errors: string[] = [];
		if (!['bun', 'npm', 'pnpm', 'yarn'].includes(input.packageManager)) {
			errors.push(`${input.packageManager} is not valid for node`);
		}
		return { warnings: [], errors };
	}
};
```

Create `src/lib/server/project-environments/adapters/python.ts`:

```ts
import { projectEnvironmentCacheMounts } from '$lib/server/project-environments/cache-paths';
import type { DetectionInput, DetectionResult, RuntimeAdapter } from '$lib/server/project-environments/types';

const VERSION = '1';

function has(input: DetectionInput, path: string): boolean {
	return input.files[path] !== undefined && input.files[path] !== null;
}

function packageManager(input: DetectionInput): DetectionResult['packageManager'] {
	if (has(input, 'uv.lock')) return 'uv';
	if (has(input, 'poetry.lock')) return 'poetry';
	if (has(input, 'requirements.txt')) return 'pip';
	return 'uv';
}

function installCommand(pm: DetectionResult['packageManager'], input: DetectionInput): string {
	if (pm === 'uv') return 'uv sync';
	if (pm === 'poetry') return 'poetry install';
	if (pm === 'pip' && has(input, 'requirements.txt')) return 'pip install -r requirements.txt';
	return '';
}

export const pythonAdapter: RuntimeAdapter = {
	id: 'python',
	label: 'Python',
	version: VERSION,
	detect(input) {
		const detectedFiles = ['pyproject.toml', 'requirements.txt', 'uv.lock', 'poetry.lock'].filter(
			(path) => has(input, path)
		);
		if (detectedFiles.length === 0) return null;
		const pm = packageManager(input);
		const warnings =
			has(input, 'pyproject.toml') && !has(input, 'uv.lock') && !has(input, 'poetry.lock')
				? ['pyproject.toml has no supported lockfile; uv is suggested']
				: [];
		return {
			runtime: 'python',
			adapterId: 'python',
			adapterVersion: VERSION,
			packageManager: pm,
			confidence: detectedFiles.some((path) => path.endsWith('.lock')) ? 90 : 70,
			detectedFiles,
			warnings,
			detection: {},
			installCommand: installCommand(pm, input),
			testCommand: '',
			buildCommand: '',
			devCommand: ''
		};
	},
	cacheMounts(input) {
		return projectEnvironmentCacheMounts({ ...input, runtime: 'python' });
	},
	validate(input) {
		const errors: string[] = [];
		if (!['uv', 'pip', 'poetry'].includes(input.packageManager)) {
			errors.push(`${input.packageManager} is not valid for python`);
		}
		return { warnings: [], errors };
	}
};
```

Create `src/lib/server/project-environments/adapters/custom.ts`:

```ts
import type { RuntimeAdapter } from '$lib/server/project-environments/types';

export const customAdapter: RuntimeAdapter = {
	id: 'custom',
	label: 'Custom',
	version: '1',
	detect() {
		return {
			runtime: 'custom',
			adapterId: 'custom',
			adapterVersion: '1',
			packageManager: 'custom',
			confidence: 1,
			detectedFiles: [],
			warnings: ['No supported runtime files detected'],
			detection: {},
			installCommand: '',
			testCommand: '',
			buildCommand: '',
			devCommand: ''
		};
	},
	cacheMounts() {
		return [];
	},
	validate(input) {
		return input.packageManager === 'custom'
			? { warnings: [], errors: [] }
			: { warnings: [], errors: [`${input.packageManager} is not valid for custom`] };
	}
};
```

Create `src/lib/server/project-environments/adapters/index.ts`:

```ts
import { customAdapter } from '$lib/server/project-environments/adapters/custom';
import { nodeAdapter } from '$lib/server/project-environments/adapters/node';
import { pythonAdapter } from '$lib/server/project-environments/adapters/python';
import type { DetectionInput, DetectionResult, RuntimeAdapter } from '$lib/server/project-environments/types';

export const runtimeAdapters: RuntimeAdapter[] = [nodeAdapter, pythonAdapter, customAdapter];

export function getRuntimeAdapter(id: string): RuntimeAdapter | null {
	return runtimeAdapters.find((adapter) => adapter.id === id) ?? null;
}

export function detectProjectEnvironment(input: DetectionInput): DetectionResult {
	const detected = runtimeAdapters
		.map((adapter) => adapter.detect(input))
		.filter((result): result is DetectionResult => result !== null)
		.sort((a, b) => b.confidence - a.confidence);
	return detected[0] ?? customAdapter.detect(input)!;
}
```

- [ ] **Step 8: Implement fingerprint helpers**

Create `src/lib/server/project-environments/fingerprint.ts`:

```ts
import { createHash } from 'node:crypto';
import type {
	ProjectEnvironmentPackageManager,
	ProjectEnvironmentPrepareStatus,
	ProjectEnvironmentRuntime
} from '$lib/domain/project-environment';

export function buildProjectEnvironmentFingerprint(input: {
	adapterId: string;
	adapterVersion: string;
	runtime: ProjectEnvironmentRuntime;
	packageManager: ProjectEnvironmentPackageManager;
	installCommand: string;
	lockfiles: Array<{ path: string; content: string }>;
	envKeys: string[];
}): string {
	const payload = {
		adapterId: input.adapterId,
		adapterVersion: input.adapterVersion,
		runtime: input.runtime,
		packageManager: input.packageManager,
		installCommand: input.installCommand,
		lockfiles: input.lockfiles
			.map((file) => ({
				path: file.path,
				hash: createHash('sha256').update(file.content).digest('hex')
			}))
			.sort((a, b) => a.path.localeCompare(b.path)),
		envKeys: [...new Set(input.envKeys)].sort()
	};
	return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function needsProjectEnvironmentPrepare(input: {
	currentFingerprint: string | null;
	lastPreparedFingerprint: string | null;
	lastPrepareStatus: ProjectEnvironmentPrepareStatus;
	installCommand: string;
}): boolean {
	if (input.installCommand.trim().length === 0) return false;
	if (input.lastPrepareStatus !== 'succeeded') return true;
	return input.currentFingerprint !== input.lastPreparedFingerprint;
}
```

- [ ] **Step 9: Extend workspace paths**

Add tests to `tests/unit/lib/server/workspace-paths.test.ts`:

```ts
import {
	projectEnvironmentCachePath,
	projectEnvironmentPrepareCheckoutPath
} from '$lib/server/workspace-paths';

it('derives project environment prepare and cache paths', () => {
	expect(projectEnvironmentPrepareCheckoutPath('/root', 'p1', 'default')).toBe(
		'/root/p1/environment/default/checkout'
	);
	expect(projectEnvironmentCachePath('/root', 'p1')).toBe('/root/p1/cache');
});
```

Add to `src/lib/server/workspace-paths.ts`:

```ts
export function projectEnvironmentPrepareCheckoutPath(
	root: string,
	projectId: string,
	profileName: string
): string {
	return join(root, projectId, 'environment', profileName, 'checkout');
}

export function projectEnvironmentCachePath(root: string, projectId: string): string {
	return join(root, projectId, 'cache');
}
```

- [ ] **Step 10: Run tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/project-environments/adapters.test.ts tests/unit/lib/server/project-environments/fingerprint.test.ts tests/unit/lib/server/project-environments/cache-paths.test.ts tests/unit/lib/server/workspace-paths.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/lib/server/project-environments src/lib/server/workspace-paths.ts tests/unit/lib/server/project-environments tests/unit/lib/server/workspace-paths.test.ts
git commit -m "feat(environment): add runtime adapters"
```

---

### Task 3: Project Environment Service

**Files:**

- Create: `src/lib/server/project-environments/service.ts`
- Modify: `src/lib/server/workspace.ts`
- Test: `tests/unit/lib/server/project-environments/service.test.ts`
- Test: `tests/unit/lib/server/workspace.test.ts`

- [ ] **Step 1: Write service tests with mocked Prisma and Git helpers**

Create `tests/unit/lib/server/project-environments/service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	projectFindFirst: vi.fn(),
	profileFindFirst: vi.fn(),
	profileUpsert: vi.fn(),
	profileUpdateMany: vi.fn(),
	eventFindMany: vi.fn(),
	envVarFindMany: vi.fn(),
	ensureMirror: vi.fn(),
	readMirrorFiles: vi.fn()
}));

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		project: { findFirst: mocks.projectFindFirst },
		projectEnvironmentProfile: {
			findFirst: mocks.profileFindFirst,
			upsert: mocks.profileUpsert,
			updateMany: mocks.profileUpdateMany
		},
		projectEnvironmentPrepareEvent: { findMany: mocks.eventFindMany },
		projectEnvVar: { findMany: mocks.envVarFindMany }
	}
}));

vi.mock('$lib/server/workspace', () => ({
	ensureMirror: mocks.ensureMirror,
	readMirrorFiles: mocks.readMirrorFiles
}));

vi.mock('$env/dynamic/private', () => ({
	env: { WORKSPACE_ROOT: '/workspaces' }
}));

import {
	ProjectEnvironmentError,
	detectProjectEnvironmentForOrg,
	getDefaultProjectEnvironmentForOrg,
	listProjectEnvironmentPrepareEventsForOrg,
	upsertProjectEnvironmentProfileForOrg
} from '$lib/server/project-environments/service';

describe('project environment service', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.projectFindFirst.mockResolvedValue({
			id: 'p1',
			organizationId: 'org1',
			cloneUrl: 'https://github.com/acme/repo.git',
			defaultBranch: 'main'
		});
		mocks.profileFindFirst.mockResolvedValue(null);
		mocks.profileUpsert.mockResolvedValue({ id: 'env1', name: 'default' });
		mocks.eventFindMany.mockResolvedValue([]);
		mocks.envVarFindMany.mockResolvedValue([{ key: 'DATABASE_URL' }]);
		mocks.readMirrorFiles.mockResolvedValue({
			'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
			'bun.lock': 'lock'
		});
	});

	it('returns null when the default profile does not exist', async () => {
		await expect(getDefaultProjectEnvironmentForOrg('org1', 'p1')).resolves.toBeNull();
		expect(mocks.projectFindFirst).toHaveBeenCalledWith({
			where: { id: 'p1', organizationId: 'org1' },
			select: { id: true }
		});
	});

	it('detects a project environment and upserts a detected default profile', async () => {
		await expect(
			detectProjectEnvironmentForOrg({
				organizationId: 'org1',
				userId: 'u1',
				projectId: 'p1',
				githubToken: 'gh-token'
			})
		).resolves.toEqual({ id: 'env1', name: 'default' });

		expect(mocks.ensureMirror).toHaveBeenCalled();
		expect(mocks.profileUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId_name: { projectId: 'p1', name: 'default' } },
				create: expect.objectContaining({
					projectId: 'p1',
					organizationId: 'org1',
					createdById: 'u1',
					runtime: 'node',
					packageManager: 'bun',
					status: 'detected',
					currentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
				})
			})
		);
	});

	it('upserts a validated ready profile from user input', async () => {
		await upsertProjectEnvironmentProfileForOrg('org1', 'u1', {
			projectId: 'p1',
			runtime: 'node',
			adapterId: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			testCommand: 'bun run test',
			buildCommand: '',
			devCommand: ''
		});

		expect(mocks.profileUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ status: 'ready' }),
				update: expect.objectContaining({ status: 'ready' })
			})
		);
	});

	it('throws ProjectEnvironmentError when the project is outside the organization', async () => {
		mocks.projectFindFirst.mockResolvedValue(null);

		await expect(getDefaultProjectEnvironmentForOrg('org1', 'p1')).rejects.toBeInstanceOf(
			ProjectEnvironmentError
		);
	});

	it('lists prepare events scoped to org and project', async () => {
		mocks.profileFindFirst.mockResolvedValue({ id: 'env1', projectId: 'p1' });
		mocks.eventFindMany.mockResolvedValue([{ id: 'e1', seq: 0 }]);

		await expect(listProjectEnvironmentPrepareEventsForOrg('org1', 'p1', 'env1')).resolves.toEqual([
			{ id: 'e1', seq: 0 }
		]);
	});
});
```

- [ ] **Step 2: Run service tests to verify failure**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/project-environments/service.test.ts
```

Expected: FAIL with module not found for service functions.

- [ ] **Step 3: Add mirror file reader and prepare checkout helpers**

Add to `src/lib/server/workspace.ts`:

```ts
import { join } from 'node:path';
import { projectEnvironmentPrepareCheckoutPath } from './workspace-paths';

export async function readMirrorFiles(
	projectId: string,
	baseRef: string,
	paths: string[],
	env: Record<string, string | undefined> = privateEnv
): Promise<Record<string, string | null>> {
	const mirror = mirrorPath(workspaceRoot(env), projectId);
	const result: Record<string, string | null> = {};
	for (const path of paths) {
		const show = await git(['show', `${baseRef}:${path}`], { cwd: mirror, env });
		result[path] = show.code === 0 ? show.stdout : null;
	}
	return result;
}

export async function createEnvironmentPrepareCheckout(
	projectId: string,
	profileName: string,
	baseRef: string,
	env: Record<string, string | undefined> = privateEnv
): Promise<{ checkoutPath: string; baseSha: string }> {
	const mirror = mirrorPath(workspaceRoot(env), projectId);
	const checkoutPath = projectEnvironmentPrepareCheckoutPath(workspaceRoot(env), projectId, profileName);
	await rm(checkoutPath, { recursive: true, force: true });
	const baseSha = await gitOk(['rev-parse', baseRef], { cwd: mirror, env });
	await mkdir(dirname(checkoutPath), { recursive: true });
	await gitOk(['clone', '--no-checkout', mirror, checkoutPath], { env });
	await gitOk(['checkout', baseSha], { cwd: checkoutPath, env });
	return { checkoutPath, baseSha };
}
```

Update `tests/unit/lib/server/workspace.test.ts` with:

```ts
it('reads selected files from the project mirror', async () => {
	await ensureMirror('proj1', sourceRepo, env);
	await expect(readMirrorFiles('proj1', 'main', ['README.md', 'missing.txt'], env)).resolves.toEqual({
		'README.md': '# hi\n',
		'missing.txt': null
	});
});

it('creates a detached prepare checkout for an environment profile', async () => {
	await ensureMirror('proj1', sourceRepo, env);
	const checkout = await createEnvironmentPrepareCheckout('proj1', 'default', 'main', env);
	expect(checkout.checkoutPath.endsWith('/proj1/environment/default/checkout')).toBe(true);
	expect(existsSync(join(checkout.checkoutPath, '.git', 'HEAD'))).toBe(true);
});
```

- [ ] **Step 4: Implement service functions**

Create `src/lib/server/project-environments/service.ts`:

```ts
import type { Prisma } from '@prisma/client';
import { authedCloneUrl, makeGitAuth } from '$lib/server/github-git';
import { prisma } from '$lib/server/prisma';
import { detectProjectEnvironment } from '$lib/server/project-environments/adapters';
import { getRuntimeAdapter } from '$lib/server/project-environments/adapters';
import { buildProjectEnvironmentFingerprint } from '$lib/server/project-environments/fingerprint';
import { ensureMirror, readMirrorFiles } from '$lib/server/workspace';
import { projectEnvironmentProfileInputSchema, type ProjectEnvironmentProfileInput } from '$lib/schemas/project-environments';

export class ProjectEnvironmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectEnvironmentError';
	}
}

const DETECTION_PATHS = [
	'package.json',
	'bun.lock',
	'package-lock.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'pyproject.toml',
	'requirements.txt',
	'uv.lock',
	'poetry.lock'
];

async function requireProjectInOrg(organizationId: string, projectId: string) {
	const project = await prisma.project.findFirst({
		where: { id: projectId, organizationId },
		select: {
			id: true,
			organizationId: true,
			cloneUrl: true,
			defaultBranch: true
		}
	});
	if (!project) throw new ProjectEnvironmentError('Project not found');
	return project;
}

function asJson(value: unknown): Prisma.InputJsonValue {
	return value as Prisma.InputJsonValue;
}

async function envKeysForProject(organizationId: string, projectId: string): Promise<string[]> {
	const rows = await prisma.projectEnvVar.findMany({
		where: { organizationId, projectId, enabled: true },
		select: { key: true },
		orderBy: { key: 'asc' }
	});
	return rows.map((row) => row.key);
}

function lockfilesFrom(files: Record<string, string | null>) {
	return Object.entries(files)
		.filter(([path, content]) => content !== null && /(^bun\.lock$|lock|requirements\.txt)/.test(path))
		.map(([path, content]) => ({ path, content: content ?? '' }));
}

export async function getDefaultProjectEnvironmentForOrg(organizationId: string, projectId: string) {
	await requireProjectInOrg(organizationId, projectId);
	return prisma.projectEnvironmentProfile.findFirst({
		where: { organizationId, projectId, name: 'default' }
	});
}

export async function listProjectEnvironmentPrepareEventsForOrg(
	organizationId: string,
	projectId: string,
	profileId: string
) {
	const profile = await prisma.projectEnvironmentProfile.findFirst({
		where: { id: profileId, projectId, organizationId },
		select: { id: true }
	});
	if (!profile) throw new ProjectEnvironmentError('Project environment profile not found');
	return prisma.projectEnvironmentPrepareEvent.findMany({
		where: { organizationId, projectId, profileId },
		orderBy: { seq: 'asc' }
	});
}

export async function detectProjectEnvironmentForOrg(input: {
	organizationId: string;
	userId: string;
	projectId: string;
	githubToken: string | null;
}) {
	const project = await requireProjectInOrg(input.organizationId, input.projectId);
	const auth = input.githubToken ? await makeGitAuth(input.githubToken) : null;
	try {
		await ensureMirror(
			project.id,
			input.githubToken ? authedCloneUrl(project.cloneUrl) : project.cloneUrl,
			auth?.env
		);
		const files = await readMirrorFiles(project.id, project.defaultBranch, DETECTION_PATHS, auth?.env);
		const detected = detectProjectEnvironment({ files });
		const envKeys = await envKeysForProject(input.organizationId, input.projectId);
		const currentFingerprint = buildProjectEnvironmentFingerprint({
			adapterId: detected.adapterId,
			adapterVersion: detected.adapterVersion,
			runtime: detected.runtime,
			packageManager: detected.packageManager,
			installCommand: detected.installCommand,
			lockfiles: lockfilesFrom(files),
			envKeys
		});
		return prisma.projectEnvironmentProfile.upsert({
			where: { projectId_name: { projectId: input.projectId, name: 'default' } },
			create: {
				projectId: input.projectId,
				organizationId: input.organizationId,
				name: 'default',
				runtime: detected.runtime,
				adapterId: detected.adapterId,
				adapterVersion: detected.adapterVersion,
				packageManager: detected.packageManager,
				installCommand: detected.installCommand,
				testCommand: detected.testCommand,
				buildCommand: detected.buildCommand,
				devCommand: detected.devCommand,
				status: 'detected',
				detection: asJson(detected.detection),
				warnings: asJson(detected.warnings),
				currentFingerprint,
				createdById: input.userId
			},
			update: {
				runtime: detected.runtime,
				adapterId: detected.adapterId,
				adapterVersion: detected.adapterVersion,
				packageManager: detected.packageManager,
				installCommand: detected.installCommand,
				testCommand: detected.testCommand,
				buildCommand: detected.buildCommand,
				devCommand: detected.devCommand,
				status: 'detected',
				detection: asJson(detected.detection),
				warnings: asJson(detected.warnings),
				currentFingerprint
			}
		});
	} finally {
		await auth?.cleanup();
	}
}

export async function upsertProjectEnvironmentProfileForOrg(
	organizationId: string,
	userId: string,
	rawInput: ProjectEnvironmentProfileInput
) {
	const input = projectEnvironmentProfileInputSchema.parse(rawInput);
	await requireProjectInOrg(organizationId, input.projectId);
	const adapter = getRuntimeAdapter(input.adapterId);
	if (!adapter) throw new ProjectEnvironmentError(`Runtime adapter ${input.adapterId} not found`);
	const validation = adapter.validate({
		packageManager: input.packageManager,
		installCommand: input.installCommand
	});
	const status = validation.errors.length > 0 ? 'invalid' : 'ready';
	return prisma.projectEnvironmentProfile.upsert({
		where: { projectId_name: { projectId: input.projectId, name: input.name } },
		create: {
			projectId: input.projectId,
			organizationId,
			name: input.name,
			runtime: input.runtime,
			adapterId: input.adapterId,
			adapterVersion: adapter.version,
			packageManager: input.packageManager,
			installCommand: input.installCommand,
			testCommand: input.testCommand,
			buildCommand: input.buildCommand,
			devCommand: input.devCommand,
			status,
			detection: asJson({ source: 'manual' }),
			warnings: asJson([...validation.warnings, ...validation.errors]),
			createdById: userId
		},
		update: {
			runtime: input.runtime,
			adapterId: input.adapterId,
			adapterVersion: adapter.version,
			packageManager: input.packageManager,
			installCommand: input.installCommand,
			testCommand: input.testCommand,
			buildCommand: input.buildCommand,
			devCommand: input.devCommand,
			status,
			warnings: asJson([...validation.warnings, ...validation.errors])
		}
	});
}
```

- [ ] **Step 5: Run service and workspace tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/project-environments/service.test.ts tests/unit/lib/server/workspace.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/project-environments/service.ts src/lib/server/workspace.ts tests/unit/lib/server/project-environments/service.test.ts tests/unit/lib/server/workspace.test.ts
git commit -m "feat(environment): detect and persist project profiles"
```

---

### Task 4: Env-Only Materialization And Docker Prepare Primitives

**Files:**

- Modify: `src/lib/server/project-agent-config-service.ts`
- Modify: `src/lib/server/docker.ts`
- Test: `tests/unit/lib/server/project-agent-config-service.test.ts`
- Test: `tests/unit/lib/server/docker.test.ts`

- [ ] **Step 1: Add failing tests for env-only materialization**

Add to `tests/unit/lib/server/project-agent-config-service.test.ts`:

```ts
import { materializeProjectEnvFile } from '$lib/server/project-agent-config-service';

it('materializes only .env for environment preparation', async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'dw-env-only-'));
	await gitIn(tempDir, ['init']);
	await gitIn(tempDir, ['config', 'user.email', 't@t.t']);
	await gitIn(tempDir, ['config', 'user.name', 't']);

	await materializeProjectEnvFile(tempDir, [{ key: 'DATABASE_URL', value: 'postgres://local' }]);

	await expect(readFile(join(tempDir, '.env'), 'utf8')).resolves.toContain(
		'DATABASE_URL=postgres://local'
	);
	await expect(readFile(join(tempDir, '.mcp.json'), 'utf8')).rejects.toThrow();
	await expect(readFile(join(tempDir, '.claude/settings.json'), 'utf8')).rejects.toThrow();
});
```

Expected failure: `materializeProjectEnvFile` is not exported.

- [ ] **Step 2: Add failing Docker tests for entrypoint command**

Add to `tests/unit/lib/server/docker.test.ts`:

```ts
it('can override entrypoint and command for prepare containers', () => {
	const args = buildRunArgs({
		image: 'dotweaver-runner',
		name: 'prepare-p1',
		workspacePath: '/workspace/p1/environment/default/checkout',
		entrypoint: '/bin/sh',
		command: ['-lc', 'bun install'],
		env: {},
		mounts: [{ source: '/workspace/p1/cache/default/node/bun/install', target: '/root/.bun/install/cache' }]
	});

	expect(args).toEqual(expect.arrayContaining(['--entrypoint', '/bin/sh']));
	expect(args).toEqual(
		expect.arrayContaining([
			'-v',
			'/workspace/p1/cache/default/node/bun/install:/root/.bun/install/cache'
		])
	);
	expect(args.slice(-3)).toEqual(['dotweaver-runner', '-lc', 'bun install']);
});
```

Expected failure: `entrypoint` and `command` are not part of `RunContainerSpec`.

- [ ] **Step 3: Implement env-only materialization**

In `src/lib/server/project-agent-config-service.ts`, replace the inline `.env` block in `materializeRunAgentConfig` with:

```ts
	if (config.envFile.length > 0) {
		await materializeProjectEnvFile(checkoutPath, config.envFile, generatedPaths);
	}
```

Add exported helper above `materializeRunAgentConfig`:

```ts
export async function materializeProjectEnvFile(
	checkoutPath: string,
	envFile: RuntimeAgentConfig['envFile'],
	generatedPaths: string[] = []
): Promise<void> {
	if (envFile.length === 0) return;
	const envPath = join(checkoutPath, '.env');
	let existing = '';
	try {
		existing = await readFile(envPath, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
	await writeFile(envPath, mergeDotenv(existing, envFile));
	generatedPaths.push('.env');
	await protectGeneratedAgentConfigFiles(checkoutPath, generatedPaths);
}
```

Keep the final `await protectGeneratedAgentConfigFiles(checkoutPath, generatedPaths);` in `materializeRunAgentConfig`. The double call is safe because `protectGeneratedAgentConfigFiles` appends excludes idempotently enough for generated paths; if duplicate exclude entries become noisy, move `.env` merging back inline and call protection once.

- [ ] **Step 4: Extend Docker spec**

Modify `src/lib/server/docker.ts`:

```ts
export interface RunContainerSpec {
	image: string;
	name: string;
	workspacePath: string;
	mounts?: Array<{ source: string; target: string; readOnly?: boolean }>;
	env: Record<string, string>;
	entrypoint?: string;
	command?: string[];
	memory?: string;
	cpus?: string;
	pidsLimit?: number;
	network?: string;
}
```

In `buildRunArgs`, before the workspace `-v` section ends and before env vars:

```ts
	if (spec.entrypoint) {
		args.push('--entrypoint', spec.entrypoint);
	}
```

After `args.push(spec.image);`, append:

```ts
	for (const commandArg of spec.command ?? []) {
		args.push(commandArg);
	}
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/project-agent-config-service.test.ts tests/unit/lib/server/docker.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/project-agent-config-service.ts src/lib/server/docker.ts tests/unit/lib/server/project-agent-config-service.test.ts tests/unit/lib/server/docker.test.ts
git commit -m "feat(environment): support prepare container primitives"
```

---

### Task 5: Standalone Prepare Queue And Worker

**Files:**

- Create: `src/lib/server/project-environments/prepare.ts`
- Modify: `src/lib/server/project-environments/service.ts`
- Modify: `src/lib/server/queue.ts`
- Modify: `src/runner/index.ts`
- Test: `tests/unit/lib/server/project-environments/prepare.test.ts`
- Test: `tests/unit/lib/server/project-environments/service.test.ts`

- [ ] **Step 1: Write prepare execution tests**

Create `tests/unit/lib/server/project-environments/prepare.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	profileFindFirst: vi.fn(),
	profileUpdateMany: vi.fn(),
	eventCreate: vi.fn(),
	eventFindFirst: vi.fn(),
	envVarFindMany: vi.fn(),
	ensureMirror: vi.fn(),
	createEnvironmentPrepareCheckout: vi.fn(),
	runContainer: vi.fn(),
	buildRunArgs: vi.fn(),
	getGithubTokenForUser: vi.fn(),
	makeGitAuth: vi.fn(),
	authedCloneUrl: vi.fn(),
	materializeProjectEnvFile: vi.fn(),
	workspaceRoot: vi.fn()
}));

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		projectEnvironmentProfile: {
			findFirst: mocks.profileFindFirst,
			updateMany: mocks.profileUpdateMany
		},
		projectEnvironmentPrepareEvent: {
			create: mocks.eventCreate,
			findFirst: mocks.eventFindFirst
		},
		projectEnvVar: { findMany: mocks.envVarFindMany }
	}
}));

vi.mock('$lib/server/workspace', () => ({
	ensureMirror: mocks.ensureMirror,
	createEnvironmentPrepareCheckout: mocks.createEnvironmentPrepareCheckout
}));

vi.mock('$lib/server/docker', () => ({
	runContainer: mocks.runContainer,
	buildRunArgs: mocks.buildRunArgs
}));

vi.mock('$lib/server/github-git', () => ({
	getGithubTokenForUser: mocks.getGithubTokenForUser,
	makeGitAuth: mocks.makeGitAuth,
	authedCloneUrl: mocks.authedCloneUrl
}));

vi.mock('$lib/server/project-agent-config-service', () => ({
	materializeProjectEnvFile: mocks.materializeProjectEnvFile
}));

vi.mock('$lib/server/workspace-paths', () => ({
	workspaceRoot: mocks.workspaceRoot,
	containerName: (id: string) => `dwrun-${id}`
}));

vi.mock('$env/dynamic/private', () => ({ env: { RUNNER_IMAGE: 'dotweaver-runner' } }));

import { executeProjectEnvironmentPrepare } from '$lib/server/project-environments/prepare';

describe('project environment prepare', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.workspaceRoot.mockReturnValue('/workspaces');
		mocks.profileFindFirst.mockResolvedValue({
			id: 'env1',
			projectId: 'p1',
			organizationId: 'org1',
			name: 'default',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp1',
			project: {
				id: 'p1',
				cloneUrl: 'https://github.com/acme/repo.git',
				defaultBranch: 'main'
			}
		});
		mocks.profileUpdateMany.mockResolvedValue({ count: 1 });
		mocks.eventFindFirst.mockResolvedValue(null);
		mocks.envVarFindMany.mockResolvedValue([{ key: 'DATABASE_URL', valueEncrypted: 'encrypted' }]);
		mocks.createEnvironmentPrepareCheckout.mockResolvedValue({ checkoutPath: '/checkout' });
		mocks.buildRunArgs.mockReturnValue(['docker', 'args']);
		mocks.runContainer.mockResolvedValue({ exitCode: 0, timedOut: false });
	});

	it('runs install command in Docker, logs events, and marks profile succeeded', async () => {
		await executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: false });

		expect(mocks.buildRunArgs).toHaveBeenCalledWith(
			expect.objectContaining({
				image: 'dotweaver-runner',
				name: 'dwenv-env1',
				workspacePath: '/checkout',
				entrypoint: '/bin/sh',
				command: ['-lc', 'bun install'],
				mounts: expect.arrayContaining([
					expect.objectContaining({ target: '/root/.bun/install/cache' })
				])
			})
		);
		expect(mocks.runContainer).toHaveBeenCalled();
		expect(mocks.profileUpdateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: { id: 'env1', lastPrepareStatus: 'running' },
				data: expect.objectContaining({
					lastPrepareStatus: 'succeeded',
					lastPreparedFingerprint: 'fp1',
					lastPrepareError: null
				})
			})
		);
	});

	it('marks profile failed and rejects when install exits non-zero', async () => {
		mocks.runContainer.mockResolvedValue({ exitCode: 1, timedOut: false });

		await expect(
			executeProjectEnvironmentPrepare({ profileId: 'env1', requestedById: 'u1', force: true })
		).rejects.toThrow('Install command failed with exit code 1');

		expect(mocks.profileUpdateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastPrepareStatus: 'failed',
					lastPrepareError: 'Install command failed with exit code 1'
				})
			})
		);
	});
});
```

- [ ] **Step 2: Run prepare tests to verify failure**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/project-environments/prepare.test.ts
```

Expected: FAIL with module not found for prepare.

- [ ] **Step 3: Add queue constants and enqueue function**

Modify `src/lib/server/queue.ts`:

```ts
export const PROJECT_ENVIRONMENT_PREPARE_QUEUE = 'project-environment-prepare';
```

Refactor `ensureRunQueue` into generic queue creation:

```ts
export async function ensureQueue(boss: PgBoss, queueName: string): Promise<void> {
	try {
		await boss.createQueue(queueName);
	} catch {
	}
}

export async function ensureRunQueue(boss: PgBoss): Promise<void> {
	await ensureQueue(boss, RUN_QUEUE);
}

export async function ensureProjectEnvironmentPrepareQueue(boss: PgBoss): Promise<void> {
	await ensureQueue(boss, PROJECT_ENVIRONMENT_PREPARE_QUEUE);
}
```

Add enqueue:

```ts
export async function enqueueProjectEnvironmentPrepare(input: {
	profileId: string;
	requestedById: string;
	force: boolean;
}): Promise<void> {
	if (!sender) {
		sender = makeBoss();
		await sender.start();
		await ensureRunQueue(sender);
		await ensureProjectEnvironmentPrepareQueue(sender);
	}
	await sender.send(PROJECT_ENVIRONMENT_PREPARE_QUEUE, input);
}
```

- [ ] **Step 4: Implement prepare execution**

Create `src/lib/server/project-environments/prepare.ts`:

```ts
import { prisma } from '$lib/server/prisma';
import { authedCloneUrl, getGithubTokenForUser, makeGitAuth } from '$lib/server/github-git';
import { buildRunArgs, runContainer } from '$lib/server/docker';
import {
	createEnvironmentPrepareCheckout,
	ensureMirror
} from '$lib/server/workspace';
import { workspaceRoot } from '$lib/server/workspace-paths';
import { materializeProjectEnvFile } from '$lib/server/project-agent-config-service';
import { projectEnvironmentCacheMounts } from '$lib/server/project-environments/cache-paths';
import { decryptProjectSecretValue } from '$lib/server/project-agent-config-encryption';
import { env as privateEnv } from '$env/dynamic/private';

const RUNNER_IMAGE = privateEnv.RUNNER_IMAGE ?? 'dotweaver-runner';
const PREPARE_TIMEOUT_MS = Number(privateEnv.PROJECT_ENVIRONMENT_PREPARE_TIMEOUT_MS ?? 10 * 60 * 1000);

export class ProjectEnvironmentPrepareError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectEnvironmentPrepareError';
	}
}

async function appendPrepareEvent(profile: { id: string; projectId: string; organizationId: string }, type: 'system' | 'output' | 'error' | 'result', payload: unknown) {
	const last = await prisma.projectEnvironmentPrepareEvent.findFirst({
		where: { profileId: profile.id },
		orderBy: { seq: 'desc' },
		select: { seq: true }
	});
	await prisma.projectEnvironmentPrepareEvent.create({
		data: {
			profileId: profile.id,
			projectId: profile.projectId,
			organizationId: profile.organizationId,
			seq: (last?.seq ?? -1) + 1,
			type,
			payload: payload as never
		}
	});
}

function prepareContainerName(profileId: string): string {
	return `dwenv-${profileId}`;
}

export async function executeProjectEnvironmentPrepare(input: {
	profileId: string;
	requestedById: string;
	force: boolean;
}): Promise<void> {
	const profile = await prisma.projectEnvironmentProfile.findFirst({
		where: { id: input.profileId },
		include: { project: true }
	});
	if (!profile) throw new ProjectEnvironmentPrepareError('Project environment profile not found');
	if (profile.installCommand.trim().length === 0) {
		await prisma.projectEnvironmentProfile.updateMany({
			where: { id: profile.id },
			data: {
				lastPrepareStatus: 'succeeded',
				lastPreparedAt: new Date(),
				lastPreparedFingerprint: profile.currentFingerprint,
				lastPrepareError: null
			}
		});
		return;
	}
	const claimWhere = input.force
		? { id: profile.id }
		: { id: profile.id, lastPrepareStatus: { not: 'running' as const } };
	const claimed = await prisma.projectEnvironmentProfile.updateMany({
		where: claimWhere,
		data: { lastPrepareStatus: 'running', lastPrepareError: null }
	});
	if (claimed.count === 0) return;

	const token = await getGithubTokenForUser(input.requestedById);
	const auth = token ? await makeGitAuth(token) : null;
	try {
		await appendPrepareEvent(profile, 'system', { kind: 'environment_prepare_started' });
		await ensureMirror(profile.project.id, token ? authedCloneUrl(profile.project.cloneUrl) : profile.project.cloneUrl, auth?.env);
		const checkout = await createEnvironmentPrepareCheckout(
			profile.project.id,
			profile.name,
			profile.project.defaultBranch,
			auth?.env
		);
		const envVars = await prisma.projectEnvVar.findMany({
			where: { organizationId: profile.organizationId, projectId: profile.projectId, enabled: true },
			select: { key: true, valueEncrypted: true },
			orderBy: { key: 'asc' }
		});
		const envFile = envVars.map((envVar) => ({
			key: envVar.key,
			value: decryptProjectSecretValue(envVar.valueEncrypted)
		}));
		const secretValues = envFile.map((entry) => entry.value).filter((value) => value.length > 0);
		const scrub = (line: string) =>
			secretValues.reduce((scrubbed, secret) => scrubbed.split(secret).join('[redacted]'), line);
		await materializeProjectEnvFile(checkout.checkoutPath, envFile);
		const mounts = projectEnvironmentCacheMounts({
			root: workspaceRoot(),
			projectId: profile.projectId,
			profileName: profile.name,
			runtime: profile.runtime,
			packageManager: profile.packageManager
		});
		const args = buildRunArgs({
			image: RUNNER_IMAGE,
			name: prepareContainerName(profile.id),
			workspacePath: checkout.checkoutPath,
			entrypoint: '/bin/sh',
			command: ['-lc', profile.installCommand],
			mounts,
			env: {},
			network: privateEnv.RUNNER_NETWORK
		});
		const result = await runContainer(
			args,
			async (line) => {
				await appendPrepareEvent(profile, 'output', { text: scrub(line) });
			},
			{ timeoutMs: PREPARE_TIMEOUT_MS, name: prepareContainerName(profile.id) },
			(line) => {
				void appendPrepareEvent(profile, 'output', { stream: 'stderr', text: scrub(line) });
			}
		);
		if (result.timedOut) throw new ProjectEnvironmentPrepareError('Install command timed out');
		if (result.exitCode !== 0) {
			throw new ProjectEnvironmentPrepareError(`Install command failed with exit code ${result.exitCode}`);
		}
		await appendPrepareEvent(profile, 'result', { kind: 'environment_prepare_completed' });
		await prisma.projectEnvironmentProfile.updateMany({
			where: { id: profile.id, lastPrepareStatus: 'running' },
			data: {
				lastPrepareStatus: 'succeeded',
				lastPreparedAt: new Date(),
				lastPreparedFingerprint: profile.currentFingerprint,
				lastPrepareError: null
			}
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await appendPrepareEvent(profile, 'error', { kind: 'environment_prepare_failed', error: message });
		await prisma.projectEnvironmentProfile.updateMany({
			where: { id: profile.id },
			data: { lastPrepareStatus: 'failed', lastPrepareError: message }
		});
		throw new ProjectEnvironmentPrepareError(message);
	} finally {
		await auth?.cleanup();
	}
}
```

- [ ] **Step 5: Wire runner to the new queue**

Modify `src/runner/index.ts` imports:

```ts
import {
	makeBoss,
	RUN_QUEUE,
	PROJECT_ENVIRONMENT_PREPARE_QUEUE,
	ensureRunQueue,
	ensureProjectEnvironmentPrepareQueue
} from '$lib/server/queue';
import { executeProjectEnvironmentPrepare } from '$lib/server/project-environments/prepare';
```

After `await ensureRunQueue(boss);` add:

```ts
	await ensureProjectEnvironmentPrepareQueue(boss);
```

Before final `console.log`, add:

```ts
	await boss.work(PROJECT_ENVIRONMENT_PREPARE_QUEUE, { batchSize: 1 }, async ([job]) => {
		const data = job.data as { profileId: string; requestedById: string; force: boolean };
		console.log('[runner] preparing environment', data.profileId);
		await executeProjectEnvironmentPrepare(data);
		console.log('[runner] finished environment prepare', data.profileId);
	});
```

- [ ] **Step 6: Run prepare tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/project-environments/prepare.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/project-environments/prepare.ts src/lib/server/queue.ts src/runner/index.ts tests/unit/lib/server/project-environments/prepare.test.ts
git commit -m "feat(environment): queue standalone prepares"
```

---

### Task 6: Run Orchestrator Integration

**Files:**

- Modify: `src/lib/server/run-orchestrator.ts`
- Modify: `src/lib/server/project-environments/service.ts`
- Test: `tests/unit/lib/server/run-orchestrator.test.ts`
- Test: `tests/unit/lib/server/project-environments/service.test.ts`

- [ ] **Step 1: Write run orchestrator tests**

Add mocks to `tests/unit/lib/server/run-orchestrator.test.ts`:

```ts
	buildRunEnvironmentConfig: vi.fn(),
	prepareRunEnvironmentIfNeeded: vi.fn(),
```

Add mock module:

```ts
vi.mock('$lib/server/project-environments/service', () => ({
	buildRunEnvironmentConfig: mocks.buildRunEnvironmentConfig,
	prepareRunEnvironmentIfNeeded: mocks.prepareRunEnvironmentIfNeeded
}));
```

In `beforeEach`, add:

```ts
mocks.buildRunEnvironmentConfig.mockResolvedValue({
	snapshot: {
		enabled: true,
		profileId: 'env1',
		runtime: 'node',
		packageManager: 'bun',
		installCommand: 'bun install',
		currentFingerprint: 'fp1',
		needsPrepare: false
	},
	cacheMounts: []
});
mocks.prepareRunEnvironmentIfNeeded.mockResolvedValue(undefined);
```

Add tests:

```ts
it('prepares the project environment before launching the agent container', async () => {
	setupRun();
	mocks.buildRunEnvironmentConfig.mockResolvedValue({
		snapshot: {
			enabled: true,
			profileId: 'env1',
			runtime: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			currentFingerprint: 'fp1',
			needsPrepare: true
		},
		cacheMounts: [{ source: '/cache/bun', target: '/root/.bun/install/cache' }]
	});
	mocks.runContainer.mockResolvedValue({ exitCode: 0, timedOut: false });

	await executeRun(runId);

	expect(mocks.prepareRunEnvironmentIfNeeded).toHaveBeenCalledWith(
		expect.objectContaining({
			runId,
			checkoutPath: '/checkout',
			createdById: 'u1'
		})
	);
	expect(mocks.prepareRunEnvironmentIfNeeded.mock.invocationCallOrder[0]).toBeLessThan(
		mocks.runContainer.mock.invocationCallOrder[0]
	);
	expect(mocks.buildRunArgs).toHaveBeenCalledWith(
		expect.objectContaining({
			mounts: expect.arrayContaining([
				{ source: '/cache/bun', target: '/root/.bun/install/cache' }
			])
		})
	);
	expect(mocks.runUpdateMany).toHaveBeenCalledWith(
		expect.objectContaining({
			data: expect.objectContaining({
				environmentSnapshot: expect.objectContaining({ profileId: 'env1' })
			})
		})
	);
});

it('fails before the agent when environment preparation fails', async () => {
	setupRun();
	mocks.prepareRunEnvironmentIfNeeded.mockRejectedValue(new Error('Install command failed with exit code 1'));

	await executeRun(runId);

	expect(mocks.runContainer).not.toHaveBeenCalled();
	expectTransition(['queued', 'preparing', 'running', 'awaiting_input'], 'failed');
	expect(mocks.runUpdateMany).toHaveBeenCalledWith(
		expect.objectContaining({
			data: expect.objectContaining({ error: 'Install command failed with exit code 1' })
		})
	);
});
```

- [ ] **Step 2: Run orchestrator tests to verify failure**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/run-orchestrator.test.ts
```

Expected: FAIL until new service functions are implemented and orchestrator calls them.

- [ ] **Step 3: Add run environment config service functions**

Add to `src/lib/server/project-environments/service.ts`:

```ts
import { needsProjectEnvironmentPrepare } from '$lib/server/project-environments/fingerprint';
import { projectEnvironmentCacheMounts } from '$lib/server/project-environments/cache-paths';
import { executeProjectEnvironmentPrepare } from '$lib/server/project-environments/prepare';
import { workspaceRoot } from '$lib/server/workspace-paths';
import { appendRunEvent, getNextEventSeq } from '$lib/server/run-events';

export async function buildRunEnvironmentConfig(organizationId: string, projectId: string) {
	const profile = await prisma.projectEnvironmentProfile.findFirst({
		where: { organizationId, projectId, name: 'default' }
	});
	if (!profile) {
		return {
			cacheMounts: [],
			snapshot: {
				enabled: false,
				warning: 'No project environment profile configured'
			}
		};
	}
	if (profile.status === 'invalid') {
		throw new ProjectEnvironmentError('Environment profile default is invalid');
	}
	const needsPrepare = needsProjectEnvironmentPrepare({
		currentFingerprint: profile.currentFingerprint,
		lastPreparedFingerprint: profile.lastPreparedFingerprint,
		lastPrepareStatus: profile.lastPrepareStatus,
		installCommand: profile.installCommand
	});
	return {
		cacheMounts: projectEnvironmentCacheMounts({
			root: workspaceRoot(),
			projectId,
			profileName: profile.name,
			runtime: profile.runtime,
			packageManager: profile.packageManager
		}),
		snapshot: {
			enabled: true,
			profileId: profile.id,
			runtime: profile.runtime,
			packageManager: profile.packageManager,
			installCommand: profile.installCommand,
			currentFingerprint: profile.currentFingerprint,
			lastPreparedFingerprint: profile.lastPreparedFingerprint,
			lastPrepareStatus: profile.lastPrepareStatus,
			needsPrepare
		}
	};
}

export async function prepareRunEnvironmentIfNeeded(input: {
	runId: string;
	checkoutPath: string;
	createdById: string;
	environmentSnapshot: Record<string, unknown>;
}): Promise<void> {
	if (input.environmentSnapshot.enabled !== true) return;
	if (input.environmentSnapshot.needsPrepare !== true) return;
	const profileId = String(input.environmentSnapshot.profileId);
	let seq = await getNextEventSeq(input.runId);
	await appendRunEvent(input.runId, seq++, {
		type: 'system',
		subtype: 'environment_prepare_started',
		profileId
	});
	try {
		await executeProjectEnvironmentPrepare({
			profileId,
			requestedById: input.createdById,
			force: false
		});
		await appendRunEvent(input.runId, seq++, {
			type: 'system',
			subtype: 'environment_prepare_completed',
			profileId
		});
	} catch (error) {
		await appendRunEvent(input.runId, seq++, {
			type: 'system',
			subtype: 'environment_prepare_failed',
			profileId,
			error: error instanceof Error ? error.message : String(error)
		});
		throw error;
	}
}
```

- [ ] **Step 4: Integrate orchestrator**

Modify `src/lib/server/run-orchestrator.ts` imports:

```ts
import {
	buildRunEnvironmentConfig,
	prepareRunEnvironmentIfNeeded
} from '$lib/server/project-environments/service';
```

After `agentConfig` is built/materialized and before the `PREPARING -> RUNNING` transition:

```ts
			const environmentConfig = await buildRunEnvironmentConfig(run.organizationId, project.id);
			if (!isResume) {
				await prepareRunEnvironmentIfNeeded({
					runId,
					checkoutPath,
					createdById: run.createdById,
					environmentSnapshot: environmentConfig.snapshot as Record<string, unknown>
				});
			}
```

Update the transition to running:

```ts
					baseCommitSha: baseSha,
					agentConfigSnapshot: agentConfig.snapshot,
					environmentSnapshot: environmentConfig.snapshot
```

Before `buildRunArgs`, combine mounts:

```ts
			const environmentMounts = environmentConfig.cacheMounts ?? [];
```

Update `buildRunArgs` input:

```ts
				mounts: [...environmentMounts, ...mounts],
```

- [ ] **Step 5: Run orchestrator tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/run-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/run-orchestrator.ts src/lib/server/project-environments/service.ts tests/unit/lib/server/run-orchestrator.test.ts tests/unit/lib/server/project-environments/service.test.ts
git commit -m "feat(environment): prepare runs before agents"
```

---

### Task 7: Remote Functions

**Files:**

- Create: `src/lib/rfc/project-environments.remote.ts`
- Test: `tests/unit/lib/rfc/project-environments.remote.test.ts`

- [ ] **Step 1: Write remote tests**

Create `tests/unit/lib/rfc/project-environments.remote.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	class ProjectEnvironmentError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'ProjectEnvironmentError';
		}
	}
	return {
		getRequestEvent: vi.fn(),
		requireHeaders: vi.fn(),
		requireActiveOrg: vi.fn(),
		getGithubToken: vi.fn(),
		refresh: vi.fn(),
		getDefaultProjectEnvironmentForOrg: vi.fn(),
		detectProjectEnvironmentForOrg: vi.fn(),
		upsertProjectEnvironmentProfileForOrg: vi.fn(),
		listProjectEnvironmentPrepareEventsForOrg: vi.fn(),
		enqueueProjectEnvironmentPrepare: vi.fn(),
		ProjectEnvironmentError
	};
});

function remoteCommand<T extends (...args: never[]) => unknown>(handler: T): T {
	return vi.fn(handler) as unknown as T;
}

function remoteQuery<T extends (arg: never) => unknown>(handler: T) {
	const wrapped = vi.fn(() => ({ refresh: mocks.refresh })) as unknown as {
		__: { type: 'query' };
		serverHandler: T;
	};
	wrapped.__ = { type: 'query' };
	wrapped.serverHandler = handler;
	return wrapped;
}

vi.mock('$app/server', () => ({
	command: vi.fn((schemaOrHandler, maybeHandler) => remoteCommand(maybeHandler ?? schemaOrHandler)),
	query: vi.fn((schemaOrHandler, maybeHandler) => remoteQuery(maybeHandler ?? schemaOrHandler)),
	getRequestEvent: mocks.getRequestEvent
}));

vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));

vi.mock('$lib/server/utils', () => ({ requireHeaders: mocks.requireHeaders }));
vi.mock('$lib/server/org', () => ({ requireActiveOrg: mocks.requireActiveOrg }));
vi.mock('$lib/server/github', () => ({ getGithubToken: mocks.getGithubToken }));
vi.mock('$lib/server/queue', () => ({
	enqueueProjectEnvironmentPrepare: mocks.enqueueProjectEnvironmentPrepare
}));
vi.mock('$lib/server/project-environments/service', () => ({
	getDefaultProjectEnvironmentForOrg: mocks.getDefaultProjectEnvironmentForOrg,
	detectProjectEnvironmentForOrg: mocks.detectProjectEnvironmentForOrg,
	upsertProjectEnvironmentProfileForOrg: mocks.upsertProjectEnvironmentProfileForOrg,
	listProjectEnvironmentPrepareEventsForOrg: mocks.listProjectEnvironmentPrepareEventsForOrg,
	ProjectEnvironmentError: mocks.ProjectEnvironmentError
}));

import {
	detectProjectEnvironment,
	getProjectEnvironment,
	prepareProjectEnvironment,
	saveProjectEnvironment
} from '$lib/rfc/project-environments.remote';

const getProjectEnvironmentMock = getProjectEnvironment as typeof getProjectEnvironment & {
	serverHandler: (projectId: string) => Promise<unknown>;
};

describe('project-environments.remote', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.requireHeaders.mockReturnValue(new Headers());
		mocks.requireActiveOrg.mockResolvedValue('org1');
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'u1' } } });
		mocks.getGithubToken.mockResolvedValue('gh-token');
		mocks.refresh.mockResolvedValue(undefined);
		mocks.getDefaultProjectEnvironmentForOrg.mockResolvedValue({ id: 'env1' });
		mocks.detectProjectEnvironmentForOrg.mockResolvedValue({ id: 'env1' });
		mocks.upsertProjectEnvironmentProfileForOrg.mockResolvedValue({ id: 'env1' });
	});

	it('gets the default project environment for the active org', async () => {
		await expect(getProjectEnvironmentMock.serverHandler('p1')).resolves.toEqual({ id: 'env1' });
		expect(mocks.getDefaultProjectEnvironmentForOrg).toHaveBeenCalledWith('org1', 'p1');
	});

	it('detects and refreshes project environment', async () => {
		await detectProjectEnvironment({ projectId: 'p1' });
		expect(mocks.detectProjectEnvironmentForOrg).toHaveBeenCalledWith({
			organizationId: 'org1',
			userId: 'u1',
			projectId: 'p1',
			githubToken: 'gh-token'
		});
		expect(mocks.refresh).toHaveBeenCalled();
	});

	it('saves and refreshes project environment', async () => {
		await saveProjectEnvironment({
			projectId: 'p1',
			runtime: 'node',
			adapterId: 'node',
			packageManager: 'bun',
			installCommand: 'bun install',
			testCommand: '',
			buildCommand: '',
			devCommand: ''
		});
		expect(mocks.upsertProjectEnvironmentProfileForOrg).toHaveBeenCalled();
		expect(mocks.refresh).toHaveBeenCalled();
	});

	it('enqueues standalone prepare', async () => {
		await prepareProjectEnvironment({ projectId: 'p1', profileId: 'env1', force: true });
		expect(mocks.enqueueProjectEnvironmentPrepare).toHaveBeenCalledWith({
			profileId: 'env1',
			requestedById: 'u1',
			force: true
		});
		expect(mocks.refresh).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run remote tests to verify failure**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/rfc/project-environments.remote.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement remote functions**

Create `src/lib/rfc/project-environments.remote.ts`:

```ts
import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { getGithubToken } from '$lib/server/github';
import { requireActiveOrg } from '$lib/server/org';
import {
	detectProjectEnvironmentForOrg,
	getDefaultProjectEnvironmentForOrg,
	listProjectEnvironmentPrepareEventsForOrg,
	ProjectEnvironmentError,
	upsertProjectEnvironmentProfileForOrg
} from '$lib/server/project-environments/service';
import { enqueueProjectEnvironmentPrepare } from '$lib/server/queue';
import { requireHeaders } from '$lib/server/utils';
import {
	projectEnvironmentDetectSchema,
	projectEnvironmentPrepareSchema,
	projectEnvironmentProfileInputSchema
} from '$lib/schemas/project-environments';

async function context() {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const { locals } = getRequestEvent();
	return { headers, organizationId, userId: locals.user!.id };
}

function mapEnvironmentError(e: unknown): never {
	if (e instanceof ProjectEnvironmentError) error(e.message === 'Project not found' ? 404 : 400, e.message);
	throw e;
}

export const getProjectEnvironment = query(z.string(), async (projectId) => {
	const { organizationId } = await context();
	try {
		return await getDefaultProjectEnvironmentForOrg(organizationId, projectId);
	} catch (e) {
		mapEnvironmentError(e);
	}
});

export const getProjectEnvironmentPrepareEvents = query(
	z.object({ projectId: z.string().min(1), profileId: z.string().min(1) }),
	async ({ projectId, profileId }) => {
		const { organizationId } = await context();
		try {
			return await listProjectEnvironmentPrepareEventsForOrg(organizationId, projectId, profileId);
		} catch (e) {
			mapEnvironmentError(e);
		}
	}
);

export const detectProjectEnvironment = command(projectEnvironmentDetectSchema, async ({ projectId }) => {
	const { headers, organizationId, userId } = await context();
	const githubToken = await getGithubToken(headers);
	try {
		const result = await detectProjectEnvironmentForOrg({
			organizationId,
			userId,
			projectId,
			githubToken
		});
		await getProjectEnvironment(projectId).refresh();
		return result;
	} catch (e) {
		mapEnvironmentError(e);
	}
});

export const saveProjectEnvironment = command(projectEnvironmentProfileInputSchema, async (input) => {
	const { organizationId, userId } = await context();
	try {
		const result = await upsertProjectEnvironmentProfileForOrg(organizationId, userId, input);
		await getProjectEnvironment(input.projectId).refresh();
		return result;
	} catch (e) {
		mapEnvironmentError(e);
	}
});

export const prepareProjectEnvironment = command(
	projectEnvironmentPrepareSchema,
	async ({ projectId, profileId, force }) => {
		const { userId } = await context();
		await enqueueProjectEnvironmentPrepare({ profileId, requestedById: userId, force });
		await getProjectEnvironment(projectId).refresh();
		await getProjectEnvironmentPrepareEvents({ projectId, profileId }).refresh();
		return { queued: true };
	}
);
```

- [ ] **Step 4: Run remote tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/rfc/project-environments.remote.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rfc/project-environments.remote.ts tests/unit/lib/rfc/project-environments.remote.test.ts
git commit -m "feat(environment): expose environment remote functions"
```

---

### Task 8: Project Page UI

**Files:**

- Create: `src/lib/components/projects/EnvironmentPanel.svelte`
- Create: `src/lib/components/projects/EnvironmentEditor.svelte`
- Modify: `src/routes/(app)/projects/[id]/+page.svelte`
- Test: `tests/unit/lib/components/projects/environment-panel.svelte.test.ts`

- [ ] **Step 1: Write component test**

Create `tests/unit/lib/components/projects/environment-panel.svelte.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import EnvironmentPanel from '$lib/components/projects/EnvironmentPanel.svelte';

describe('EnvironmentPanel', () => {
	it('renders an unconfigured state with detect action', async () => {
		const screen = render(EnvironmentPanel, {
			projectId: 'p1',
			environment: null,
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare: vi.fn()
		});

		await expect.element(screen.getByText('Environment')).toBeInTheDocument();
		await expect.element(screen.getByText('Not configured')).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: /detect/i })).toBeInTheDocument();
	});

	it('renders a ready Node environment', async () => {
		const screen = render(EnvironmentPanel, {
			projectId: 'p1',
			environment: {
				id: 'env1',
				runtime: 'node',
				packageManager: 'bun',
				status: 'ready',
				lastPrepareStatus: 'succeeded',
				installCommand: 'bun install',
				testCommand: 'bun run test',
				buildCommand: '',
				devCommand: '',
				warnings: []
			},
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare: vi.fn()
		});

		await expect.element(screen.getByText('node')).toBeInTheDocument();
		await expect.element(screen.getByText('bun')).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: /prepare/i })).toBeInTheDocument();
	});
});
```

- [ ] **Step 2: Run component test to verify failure**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/components/projects/environment-panel.svelte.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement editor component**

Create `src/lib/components/projects/EnvironmentEditor.svelte`:

```svelte
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import type { ProjectEnvironmentProfileInput } from '$lib/schemas/project-environments';
	import { Save } from '@lucide/svelte';

	let {
		projectId,
		initial,
		onSave
	}: {
		projectId: string;
		initial: Partial<ProjectEnvironmentProfileInput> | null;
		onSave: (input: ProjectEnvironmentProfileInput) => Promise<unknown>;
	} = $props();

	type Runtime = ProjectEnvironmentProfileInput['runtime'];
	type PackageManager = ProjectEnvironmentProfileInput['packageManager'];

	let runtime = $state<Runtime>(initial?.runtime ?? 'node');
	let packageManager = $state<PackageManager>(initial?.packageManager ?? 'bun');
	let installCommand = $state(initial?.installCommand ?? 'bun install');
	let testCommand = $state(initial?.testCommand ?? '');
	let buildCommand = $state(initial?.buildCommand ?? '');
	let devCommand = $state(initial?.devCommand ?? '');
	let saving = $state(false);
	let error = $state<string | null>(null);

	const packageManagers = $derived.by(() => {
		if (runtime === 'node') return ['bun', 'npm', 'pnpm', 'yarn'] as const;
		if (runtime === 'python') return ['uv', 'pip', 'poetry'] as const;
		return ['custom'] as const;
	});

	function handleRuntimeChange(value: string | undefined) {
		runtime = value === 'python' ? 'python' : value === 'custom' ? 'custom' : 'node';
		if (!packageManagers.includes(packageManager as never)) {
			packageManager = packageManagers[0];
		}
	}

	async function save() {
		if (saving) return;
		error = null;
		saving = true;
		try {
			await onSave({
				projectId,
				runtime,
				adapterId: runtime,
				packageManager,
				installCommand,
				testCommand,
				buildCommand,
				devCommand
			});
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save environment';
		} finally {
			saving = false;
		}
	}
</script>

<form
	class="grid gap-3"
	onsubmit={(event) => {
		event.preventDefault();
		void save();
	}}
>
	{#if error}
		<p class="text-sm break-words text-destructive" role="alert">{error}</p>
	{/if}

	<div class="grid gap-3 md:grid-cols-2">
		<div class="space-y-1">
			<Label for="environment-runtime">Runtime</Label>
			<Select.Root type="single" value={runtime} onValueChange={handleRuntimeChange}>
				<Select.Trigger id="environment-runtime" class="w-full">{runtime}</Select.Trigger>
				<Select.Content>
					<Select.Item value="node" label="node" />
					<Select.Item value="python" label="python" />
					<Select.Item value="custom" label="custom" />
				</Select.Content>
			</Select.Root>
		</div>
		<div class="space-y-1">
			<Label for="environment-package-manager">Package manager</Label>
			<Select.Root
				type="single"
				value={packageManager}
				onValueChange={(value) => (packageManager = (value as PackageManager | undefined) ?? 'custom')}
			>
				<Select.Trigger id="environment-package-manager" class="w-full">{packageManager}</Select.Trigger>
				<Select.Content>
					{#each packageManagers as candidate (candidate)}
						<Select.Item value={candidate} label={candidate} />
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
	</div>

	<div class="grid gap-3 md:grid-cols-2">
		<div class="space-y-1">
			<Label for="environment-install">Install</Label>
			<Input id="environment-install" bind:value={installCommand} placeholder="bun install" />
		</div>
		<div class="space-y-1">
			<Label for="environment-test">Test</Label>
			<Input id="environment-test" bind:value={testCommand} placeholder="bun run test" />
		</div>
		<div class="space-y-1">
			<Label for="environment-build">Build</Label>
			<Input id="environment-build" bind:value={buildCommand} placeholder="bun run build" />
		</div>
		<div class="space-y-1">
			<Label for="environment-dev">Dev</Label>
			<Input id="environment-dev" bind:value={devCommand} placeholder="bun run dev" />
		</div>
	</div>

	<Button type="submit" disabled={saving} class="w-full md:w-fit">
		<Save />
		{saving ? 'Saving' : 'Save environment'}
	</Button>
</form>
```

- [ ] **Step 4: Implement panel component**

Create `src/lib/components/projects/EnvironmentPanel.svelte`:

```svelte
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import type { ProjectEnvironmentProfileInput } from '$lib/schemas/project-environments';
	import { LoaderCircle, Play, RefreshCw, Settings2 } from '@lucide/svelte';
	import EnvironmentEditor from './EnvironmentEditor.svelte';

	type Environment = {
		id: string;
		runtime: ProjectEnvironmentProfileInput['runtime'];
		packageManager: ProjectEnvironmentProfileInput['packageManager'];
		status: string;
		lastPrepareStatus: string;
		installCommand: string;
		testCommand: string;
		buildCommand: string;
		devCommand: string;
		warnings: unknown;
	};

	let {
		projectId,
		environment,
		onDetect,
		onSave,
		onPrepare
	}: {
		projectId: string;
		environment: Environment | null;
		onDetect: () => Promise<unknown>;
		onSave: (input: ProjectEnvironmentProfileInput) => Promise<unknown>;
		onPrepare: (input: { projectId: string; profileId: string; force: boolean }) => Promise<unknown>;
	} = $props();

	let editing = $state(false);
	let busy = $state<string | null>(null);
	let error = $state<string | null>(null);

	const warnings = $derived.by(() => {
		return Array.isArray(environment?.warnings) ? environment.warnings.map(String) : [];
	});

	async function runAction(key: string, action: () => Promise<unknown>) {
		if (busy) return;
		error = null;
		busy = key;
		try {
			await action();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Action failed';
		} finally {
			busy = null;
		}
	}
</script>

<Card.Root size="sm">
	<Card.Header>
		<div class="min-w-0">
			<Card.Title>Environment</Card.Title>
			<Card.Description>
				{#if environment}
					{environment.runtime} runtime with {environment.packageManager}
				{:else}
					Not configured
				{/if}
			</Card.Description>
		</div>
		<Card.Action>
			<div class="flex flex-wrap gap-2">
				<Button
					variant="outline"
					size="sm"
					disabled={busy !== null}
					onclick={() => void runAction('detect', onDetect)}
				>
					{#if busy === 'detect'}
						<LoaderCircle class="animate-spin" />
					{:else}
						<RefreshCw />
					{/if}
					Detect
				</Button>
				<Button variant="outline" size="sm" onclick={() => (editing = !editing)}>
					<Settings2 />
					{editing ? 'Close' : 'Edit'}
				</Button>
				{#if environment}
					<Button
						size="sm"
						disabled={busy !== null}
						onclick={() =>
							void runAction('prepare', () =>
								onPrepare({ projectId, profileId: environment.id, force: false })
							)}
					>
						{#if busy === 'prepare'}
							<LoaderCircle class="animate-spin" />
						{:else}
							<Play />
						{/if}
						Prepare
					</Button>
				{/if}
			</div>
		</Card.Action>
	</Card.Header>
	<Card.Content class="space-y-4">
		{#if error}
			<p class="text-sm break-words text-destructive" role="alert">{error}</p>
		{/if}

		{#if environment}
			<div class="flex flex-wrap gap-2">
				<Badge variant="outline">{environment.status}</Badge>
				<Badge variant="outline">{environment.runtime}</Badge>
				<Badge variant="outline">{environment.packageManager}</Badge>
				<Badge variant="outline">prepare: {environment.lastPrepareStatus}</Badge>
			</div>
			{#if warnings.length > 0}
				<ul class="space-y-1 text-sm text-muted-foreground">
					{#each warnings as warning (warning)}
						<li>{warning}</li>
					{/each}
				</ul>
			{/if}
		{:else}
			<p class="text-sm text-muted-foreground">Not configured</p>
		{/if}

		{#if editing}
			<EnvironmentEditor {projectId} initial={environment} {onSave} />
		{/if}
	</Card.Content>
</Card.Root>
```

- [ ] **Step 5: Run Svelte autofixer on both components**

Run `mcp__svelte.svelte_autofixer` with:

- filename `EnvironmentEditor.svelte`, desired Svelte version `5`, code from the new editor.
- filename `EnvironmentPanel.svelte`, desired Svelte version `5`, code from the new panel.

Expected: no issues or suggestions. If issues are returned, patch the component and run autofixer again until clean.

- [ ] **Step 6: Wire project page**

Modify `src/routes/(app)/projects/[id]/+page.svelte` imports:

```ts
	import EnvironmentPanel from '$lib/components/projects/EnvironmentPanel.svelte';
	import {
		detectProjectEnvironment,
		getProjectEnvironment,
		prepareProjectEnvironment,
		saveProjectEnvironment
	} from '$lib/rfc/project-environments.remote';
```

Add state:

```ts
	const environment = $derived(getProjectEnvironment(page.params.id!));
```

Render before `AgentConfigPanel`:

```svelte
		{#if environment.error}
			<p class="text-sm text-red-500">{environment.error.message}</p>
		{:else if environment.current !== undefined}
			<EnvironmentPanel
				projectId={page.params.id!}
				environment={environment.current}
				onDetect={() => detectProjectEnvironment({ projectId: page.params.id! })}
				onSave={saveProjectEnvironment}
				onPrepare={prepareProjectEnvironment}
			/>
		{:else}
			<p class="text-sm text-muted-foreground">Loading environment</p>
		{/if}
```

- [ ] **Step 7: Run component and Svelte checks**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/components/projects/environment-panel.svelte.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/components/projects/EnvironmentPanel.svelte src/lib/components/projects/EnvironmentEditor.svelte 'src/routes/(app)/projects/[id]/+page.svelte' tests/unit/lib/components/projects/environment-panel.svelte.test.ts
git commit -m "feat(environment): add project environment panel"
```

---

### Task 9: Runner Image Support And End-To-End Verification

**Files:**

- Modify: `docker/runner/Dockerfile`
- Modify: `.env.example`
- Modify: `README.md`
- Test: existing tests and manual runner smoke.

- [ ] **Step 1: Update runner image with baseline package managers**

Modify `docker/runner/Dockerfile` apt install line:

```dockerfile
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git curl ca-certificates ripgrep python3 python3-pip python3-venv \
	&& rm -rf /var/lib/apt/lists/*
```

Add after global Codex install:

```dockerfile
RUN corepack enable \
	&& npm install -g pnpm yarn \
	&& python3 -m pip install --break-system-packages uv poetry
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"
```

- [ ] **Step 2: Document new env var**

Add to `.env.example`:

```bash
# Optional timeout for project environment prepare jobs.
PROJECT_ENVIRONMENT_PREPARE_TIMEOUT_MS="600000"
```

Add to README runner env vars:

```markdown
- `PROJECT_ENVIRONMENT_PREPARE_TIMEOUT_MS` - optional timeout for standalone and pre-run dependency preparation.
```

- [ ] **Step 3: Run full unit checks**

Run:

```bash
bun run test:unit -- --run
bun run check
bun run lint
```

Expected: PASS.

- [ ] **Step 4: Build runner image**

Run:

```bash
bun run runner:build-image
```

Expected: Docker image builds successfully and includes `bun`, `npm`, `pnpm`, `yarn`, `python3`, `pip`, `uv`, and `poetry`.

- [ ] **Step 5: Verify package manager availability inside image**

Run:

```bash
docker run --rm --entrypoint /bin/sh dotweaver-runner -lc 'bun --version && npm --version && pnpm --version && yarn --version && python3 --version && pip --version && uv --version && poetry --version'
```

Expected: every command prints a version and exits 0.

- [ ] **Step 6: Commit**

```bash
git add docker/runner/Dockerfile .env.example README.md
git commit -m "build(runner): install environment package managers"
```

---

### Task 10: Final Verification And Regression Sweep

**Files:**

- Modify only files needed to fix test failures found during verification.

- [ ] **Step 1: Run focused project environment tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/schemas/project-environments.test.ts tests/unit/lib/server/project-environments/adapters.test.ts tests/unit/lib/server/project-environments/fingerprint.test.ts tests/unit/lib/server/project-environments/cache-paths.test.ts tests/unit/lib/server/project-environments/service.test.ts tests/unit/lib/server/project-environments/prepare.test.ts tests/unit/lib/rfc/project-environments.remote.test.ts tests/unit/lib/components/projects/environment-panel.svelte.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run affected existing tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/project-agent-config-service.test.ts tests/unit/lib/server/docker.test.ts tests/unit/lib/server/workspace.test.ts tests/unit/lib/server/run-orchestrator.test.ts tests/unit/lib/rfc/runs.remote.test.ts tests/unit/lib/rfc/projects.remote.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full quality gate**

Run:

```bash
bun run test:unit -- --run
bun run check
bun run lint
bun run build
```

Expected: PASS.

- [ ] **Step 4: Manual smoke**

Run the app and runner in two terminals:

```bash
bun run dev -- --host 0.0.0.0
bun run runner
```

Manual browser flow:

1. Open an imported project.
2. Click `Detect`.
3. Confirm a detected Node/Bun environment appears.
4. Click `Save environment`.
5. Click `Prepare`.
6. Confirm prepare status updates and no run is created.
7. Start a small agent run.
8. Confirm run reaches agent execution after environment preparation or skips prepare if already current.

- [ ] **Step 5: Inspect secret safety**

Run:

```bash
rg -n "DATABASE_URL|PROJECT_SECRET|valueEncrypted|postgres://" src tests docs/superpowers/plans/2026-06-23-project-environment-runtime.md
```

Expected: no real secret values. Test strings are allowed only when they are obviously fake.

- [ ] **Step 6: Commit final fixes**

If verification required fixes in environment files, stage the known feature surface:

```bash
git add prisma/schema.prisma docker/runner/Dockerfile .env.example README.md src/lib/domain/project-environment.ts src/lib/schemas/project-environments.ts src/lib/server/project-environments src/lib/rfc/project-environments.remote.ts src/lib/components/projects/EnvironmentPanel.svelte src/lib/components/projects/EnvironmentEditor.svelte 'src/routes/(app)/projects/[id]/+page.svelte' tests/unit/lib/schemas/project-environments.test.ts tests/unit/lib/server/project-environments tests/unit/lib/rfc/project-environments.remote.test.ts tests/unit/lib/components/projects/environment-panel.svelte.test.ts
git commit -m "fix(environment): complete runtime verification"
```

If no fixes were needed, do not create an empty commit.
