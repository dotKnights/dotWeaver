# Project Environment Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add modular project environment services with Docker-provisioned Postgres and Redis, persisted per project, exposed through onboarding, and injected into prepared run environments.

**Architecture:** Add a new `project-environment-services` domain beside `project-environments`. Providers own Postgres/Redis defaults, Docker lifecycle, outputs and fingerprint data; the service layer owns org/project/profile scoping, persistence, events, queue orchestration and `.env` integration. The setup UI consumes remote functions and live state, while runs keep using the prepared template pipeline.

**Tech Stack:** TypeScript, Prisma, SvelteKit remote functions, Svelte 5 runes, PgBoss, Docker CLI, LISTEN/NOTIFY + SSE, Vitest unit/browser tests, Bun.

---

## Scope Check

This plan implements one connected feature from the approved spec:

- Postgres and Redis as first environment service providers;
- automatic Docker provisioning with persistent volumes;
- service outputs merged into project `.env`;
- fingerprint invalidation when active services change;
- onboarding UI for adding, viewing and managing services;
- live event stream for service provisioning.

It intentionally does not implement external service URLs, per-run isolated databases, host port exposure, backup/restore UI, or additional providers.

## File Structure

Create:

- `src/lib/domain/project-environment-service.ts` -- public enums/constants and lightweight types for service kind, status and event type.
- `src/lib/schemas/project-environment-services.ts` -- Zod schemas for remote command inputs and provider config.
- `src/lib/server/project-environment-services/types.ts` -- provider interfaces and internal output/runtime types.
- `src/lib/server/project-environment-services/docker.ts` -- Docker command helpers for service containers, volumes and exec healthchecks.
- `src/lib/server/project-environment-services/providers/postgres.ts` -- Postgres provider defaults, args, healthcheck, outputs and fingerprint payload.
- `src/lib/server/project-environment-services/providers/redis.ts` -- Redis provider defaults, args, healthcheck, outputs and fingerprint payload.
- `src/lib/server/project-environment-services/providers/index.ts` -- provider registry and `getEnvironmentServiceProvider`.
- `src/lib/server/project-environment-services/notifications.ts` -- LISTEN/NOTIFY payload parsing and notifier.
- `src/lib/server/project-environment-services/stream.ts` -- SSE stream helpers for service events.
- `src/lib/server/project-environment-services/service.ts` -- org-scoped CRUD, provisioning lifecycle, output merge, warnings and fingerprint inputs.
- `src/lib/rfc/project-environment-services.remote.ts` -- remote queries/commands for setup UI.
- `src/routes/api/projects/[id]/environment-services/[serviceId]/events/+server.ts` -- SSE endpoint.
- `src/lib/components/projects/ProjectEnvironmentServicesPanel.svelte` -- setup services UI.
- `src/lib/components/projects/project-environment-services-live.svelte.ts` -- reusable live state wrapper for service events.
- Tests matching each new server/domain/UI module.

Modify:

- `prisma/schema.prisma` -- add service enums/models and relations.
- `src/lib/server/project-environments/fingerprint.ts` -- include active service fingerprint inputs.
- `src/lib/server/project-environments/service.ts` -- load service state in environment snapshots and block runs when services are not consumable.
- `src/lib/server/project-environments/prepare.ts` -- materialize service outputs into the prepared template `.env`.
- `src/lib/server/project-agent-config-service.ts` -- accept extra generated env entries when materializing `.env`.
- `src/lib/server/queue.ts` -- add service provision queue.
- `src/runner/index.ts` -- work service provision jobs.
- `src/lib/components/projects/environment-setup-state.ts` -- compute service setup state from service summaries.
- `src/lib/components/projects/ProjectSetupChecklist.svelte` -- replace placeholder services card with the new panel.
- `src/routes/(app)/projects/[id]/setup/+page.svelte` -- wire service remote queries, commands and live state.

## Svelte Notes

Use the official Svelte docs consulted for this plan:

- `kit/routing`: add the SSE route under `src/routes/api/.../+server.ts`.
- `kit/remote-functions`: expose service queries/commands from `.remote.ts` and refresh affected queries after mutations.
- `svelte/$state`, `svelte/$derived`, `svelte/$props`: keep local component state and derived setup status in runes.
- `svelte/reactivity`: use `SvelteMap` or a simple reactive array wrapper for live event merging.
- `svelte/testing`: use browser component tests for `.svelte` UI and pure Vitest tests for helpers.

Run `mcp__svelte.svelte_autofixer` on each new or modified `.svelte` and `.svelte.ts` file before final verification.

---

### Task 1: Prisma Models And Domain Types

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260624130000_add_project_environment_services/migration.sql`
- Create: `src/lib/domain/project-environment-service.ts`
- Create: `src/lib/schemas/project-environment-services.ts`
- Test: `tests/unit/lib/schemas/project-environment-services.test.ts`

- [ ] **Step 1: Write schema/domain tests**

Create `tests/unit/lib/schemas/project-environment-services.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	PROJECT_ENVIRONMENT_SERVICE_KINDS,
	PROJECT_ENVIRONMENT_SERVICE_STATUSES
} from '$lib/domain/project-environment-service';
import {
	projectEnvironmentServiceCreateSchema,
	projectEnvironmentServiceMutationSchema
} from '$lib/schemas/project-environment-services';

describe('project environment service schemas', () => {
	it('defines the first supported service kinds and statuses', () => {
		expect(PROJECT_ENVIRONMENT_SERVICE_KINDS).toEqual(['postgres', 'redis']);
		expect(PROJECT_ENVIRONMENT_SERVICE_STATUSES).toEqual([
			'configured',
			'provisioning',
			'ready',
			'failed',
			'disabled'
		]);
	});

	it('accepts create input for postgres and redis', () => {
		expect(
			projectEnvironmentServiceCreateSchema.parse({
				projectId: 'p1',
				profileId: 'env1',
				kind: 'postgres'
			})
		).toEqual({
			projectId: 'p1',
			profileId: 'env1',
			kind: 'postgres',
			name: 'postgres'
		});
		expect(
			projectEnvironmentServiceCreateSchema.parse({
				projectId: 'p1',
				profileId: 'env1',
				kind: 'redis',
				name: 'cache'
			}).name
		).toBe('cache');
	});

	it('rejects unsafe service names', () => {
		expect(() =>
			projectEnvironmentServiceCreateSchema.parse({
				projectId: 'p1',
				profileId: 'env1',
				kind: 'postgres',
				name: '../db'
			})
		).toThrow();
	});

	it('validates mutation ids', () => {
		expect(
			projectEnvironmentServiceMutationSchema.parse({
				projectId: 'p1',
				profileId: 'env1',
				serviceId: 'svc1'
			})
		).toEqual({ projectId: 'p1', profileId: 'env1', serviceId: 'svc1' });
	});
});
```

- [ ] **Step 2: Run schema tests to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/lib/schemas/project-environment-services.test.ts --run
```

Expected: FAIL because the domain and schema files do not exist.

- [ ] **Step 3: Add domain constants**

Create `src/lib/domain/project-environment-service.ts`:

```ts
export const PROJECT_ENVIRONMENT_SERVICE_KINDS = ['postgres', 'redis'] as const;
export type ProjectEnvironmentServiceKind = (typeof PROJECT_ENVIRONMENT_SERVICE_KINDS)[number];

export const PROJECT_ENVIRONMENT_SERVICE_STATUSES = [
	'configured',
	'provisioning',
	'ready',
	'failed',
	'disabled'
] as const;
export type ProjectEnvironmentServiceStatus =
	(typeof PROJECT_ENVIRONMENT_SERVICE_STATUSES)[number];

export const PROJECT_ENVIRONMENT_SERVICE_EVENT_TYPES = [
	'system',
	'output',
	'error',
	'result'
] as const;
export type ProjectEnvironmentServiceEventType =
	(typeof PROJECT_ENVIRONMENT_SERVICE_EVENT_TYPES)[number];
```

- [ ] **Step 4: Add Zod schemas**

Create `src/lib/schemas/project-environment-services.ts`:

```ts
import { z } from 'zod';
import { PROJECT_ENVIRONMENT_SERVICE_KINDS } from '$lib/domain/project-environment-service';

const serviceNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(40)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Use letters, numbers, dashes or underscores');

export const projectEnvironmentServiceKindSchema = z.enum(PROJECT_ENVIRONMENT_SERVICE_KINDS);

export const projectEnvironmentServiceCreateSchema = z
	.object({
		projectId: z.string().min(1),
		profileId: z.string().min(1),
		kind: projectEnvironmentServiceKindSchema,
		name: serviceNameSchema.optional()
	})
	.transform((input) => ({
		...input,
		name: input.name ?? input.kind
	}));

export const projectEnvironmentServiceMutationSchema = z.object({
	projectId: z.string().min(1),
	profileId: z.string().min(1),
	serviceId: z.string().min(1)
});

export const projectEnvironmentServiceEnabledSchema =
	projectEnvironmentServiceMutationSchema.extend({
		enabled: z.boolean()
	});
```

- [ ] **Step 5: Add Prisma schema models**

Modify `prisma/schema.prisma`:

```prisma
enum ProjectEnvironmentServiceKind {
  postgres
  redis
}

enum ProjectEnvironmentServiceStatus {
  configured
  provisioning
  ready
  failed
  disabled
}

enum ProjectEnvironmentServiceEventType {
  system
  output
  error
  result
}
```

Add relations:

```prisma
model User {
  // existing fields
  projectEnvironmentServices ProjectEnvironmentService[]
}

model Project {
  // existing fields
  environmentServices ProjectEnvironmentService[]
}

model ProjectEnvironmentProfile {
  // existing fields
  services ProjectEnvironmentService[]
}
```

Add models:

```prisma
model ProjectEnvironmentService {
  id             String                          @id @default(cuid())
  projectId      String
  project        Project                         @relation(fields: [projectId, organizationId], references: [id, organizationId], onDelete: Cascade)
  organizationId String
  profileId      String
  profile        ProjectEnvironmentProfile       @relation(fields: [profileId], references: [id], onDelete: Cascade)
  kind           ProjectEnvironmentServiceKind
  name           String
  enabled        Boolean                         @default(true)
  status         ProjectEnvironmentServiceStatus @default(configured)
  config         Json                            @default("{}")
  outputs        Json                            @default("[]")
  runtime        Json                            @default("{}")
  lastError      String?
  lastReadyAt    DateTime?
  createdById    String
  createdBy      User                            @relation(fields: [createdById], references: [id], onDelete: Cascade)
  createdAt      DateTime                        @default(now())
  updatedAt      DateTime                        @updatedAt
  events         ProjectEnvironmentServiceEvent[]

  @@unique([projectId, name])
  @@index([organizationId, projectId, profileId])
  @@map("project_environment_service")
}

model ProjectEnvironmentServiceEvent {
  id             String                             @id @default(cuid())
  serviceId      String
  service        ProjectEnvironmentService          @relation(fields: [serviceId], references: [id], onDelete: Cascade)
  projectId      String
  organizationId String
  seq            Int
  type           ProjectEnvironmentServiceEventType
  payload        Json
  createdAt      DateTime                           @default(now())

  @@unique([serviceId, seq])
  @@index([organizationId, projectId, serviceId])
  @@map("project_environment_service_event")
}
```

- [ ] **Step 6: Add SQL migration**

Create `prisma/migrations/20260624130000_add_project_environment_services/migration.sql`:

```sql
CREATE TYPE "ProjectEnvironmentServiceKind" AS ENUM ('postgres', 'redis');
CREATE TYPE "ProjectEnvironmentServiceStatus" AS ENUM (
  'configured',
  'provisioning',
  'ready',
  'failed',
  'disabled'
);
CREATE TYPE "ProjectEnvironmentServiceEventType" AS ENUM (
  'system',
  'output',
  'error',
  'result'
);

CREATE TABLE "project_environment_service" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "kind" "ProjectEnvironmentServiceKind" NOT NULL,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "status" "ProjectEnvironmentServiceStatus" NOT NULL DEFAULT 'configured',
  "config" JSONB NOT NULL DEFAULT '{}',
  "outputs" JSONB NOT NULL DEFAULT '[]',
  "runtime" JSONB NOT NULL DEFAULT '{}',
  "lastError" TEXT,
  "lastReadyAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "project_environment_service_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_environment_service_event" (
  "id" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "type" "ProjectEnvironmentServiceEventType" NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_environment_service_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_environment_service_projectId_name_key"
  ON "project_environment_service"("projectId", "name");
CREATE INDEX "project_environment_service_organizationId_projectId_profileId_idx"
  ON "project_environment_service"("organizationId", "projectId", "profileId");
CREATE UNIQUE INDEX "project_environment_service_event_serviceId_seq_key"
  ON "project_environment_service_event"("serviceId", "seq");
CREATE INDEX "project_environment_service_event_organizationId_projectId_serviceId_idx"
  ON "project_environment_service_event"("organizationId", "projectId", "serviceId");

ALTER TABLE "project_environment_service"
  ADD CONSTRAINT "project_environment_service_projectId_organizationId_fkey"
  FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_environment_service"
  ADD CONSTRAINT "project_environment_service_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "project_environment_profile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_environment_service"
  ADD CONSTRAINT "project_environment_service_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "user"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_environment_service_event"
  ADD CONSTRAINT "project_environment_service_event_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "project_environment_service"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 7: Verify schema task**

Run:

```bash
bun run prisma:generate
bun run test:unit -- tests/unit/lib/schemas/project-environment-services.test.ts --run
```

Expected: Prisma generate succeeds and schema tests PASS.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260624130000_add_project_environment_services/migration.sql src/lib/domain/project-environment-service.ts src/lib/schemas/project-environment-services.ts tests/unit/lib/schemas/project-environment-services.test.ts
git commit -m "feat(services): add environment service schema"
```

---

### Task 2: Docker Helpers And Providers

**Files:**

- Create: `src/lib/server/project-environment-services/types.ts`
- Create: `src/lib/server/project-environment-services/docker.ts`
- Create: `src/lib/server/project-environment-services/providers/postgres.ts`
- Create: `src/lib/server/project-environment-services/providers/redis.ts`
- Create: `src/lib/server/project-environment-services/providers/index.ts`
- Test: `tests/unit/lib/server/project-environment-services/docker.test.ts`
- Test: `tests/unit/lib/server/project-environment-services/providers.test.ts`

- [ ] **Step 1: Write provider and docker tests**

Create `tests/unit/lib/server/project-environment-services/providers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { postgresProvider } from '$lib/server/project-environment-services/providers/postgres';
import { redisProvider } from '$lib/server/project-environment-services/providers/redis';
import { getEnvironmentServiceProvider } from '$lib/server/project-environment-services/providers';

const baseInput = {
	projectId: 'p1',
	serviceId: 'svc1',
	name: 'postgres',
	networkAlias: 'dotweaver-p-p1-svc-postgres'
};

describe('environment service providers', () => {
	it('registers postgres and redis providers', () => {
		expect(getEnvironmentServiceProvider('postgres')).toBe(postgresProvider);
		expect(getEnvironmentServiceProvider('redis')).toBe(redisProvider);
	});

	it('builds postgres defaults and outputs', () => {
		const config = postgresProvider.defaultConfig({ projectId: 'p1', name: 'postgres' });
		expect(config).toEqual({
			image: 'postgres:17-alpine',
			database: 'app',
			user: 'dotweaver',
			password: expect.any(String),
			port: 5432
		});
		const outputs = postgresProvider.buildOutputs({ ...baseInput, config });
		expect(outputs.map((output) => output.key)).toEqual([
			'DATABASE_URL',
			'POSTGRES_HOST',
			'POSTGRES_PORT',
			'POSTGRES_DB',
			'POSTGRES_USER',
			'POSTGRES_PASSWORD'
		]);
		expect(outputs.find((output) => output.key === 'DATABASE_URL')).toMatchObject({
			sensitive: true
		});
	});

	it('builds redis defaults and outputs', () => {
		const config = redisProvider.defaultConfig({ projectId: 'p1', name: 'redis' });
		expect(config).toEqual({
			image: 'redis:7-alpine',
			password: expect.any(String),
			port: 6379,
			appendOnly: true
		});
		const outputs = redisProvider.buildOutputs({
			projectId: 'p1',
			serviceId: 'svc2',
			name: 'redis',
			networkAlias: 'dotweaver-p-p1-svc-redis',
			config
		});
		expect(outputs.map((output) => output.key)).toEqual([
			'REDIS_URL',
			'REDIS_HOST',
			'REDIS_PORT',
			'REDIS_PASSWORD'
		]);
		expect(outputs.find((output) => output.key === 'REDIS_URL')).toMatchObject({
			sensitive: true
		});
	});
});
```

Create `tests/unit/lib/server/project-environment-services/docker.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

import {
	buildServiceContainerName,
	buildServiceNetworkAlias,
	buildServiceRunArgs,
	buildServiceVolumeName,
	runDockerCommand
} from '$lib/server/project-environment-services/docker';

function fakeChild(code: number) {
	const child = new EventEmitter();
	child.on('newListener', (event) => {
		if (event === 'close') queueMicrotask(() => child.emit('close', code));
	});
	return child;
}

describe('environment service docker helpers', () => {
	beforeEach(() => spawn.mockReset());

	it('sanitizes docker names deterministically', () => {
		expect(buildServiceContainerName('Project_1234567890', 'postgres/main')).toBe(
			'dotweaver-p-Project_1234567890-svc-postgres-main'
		);
		expect(buildServiceVolumeName('p1', 'postgres')).toBe('dotweaver-p-p1-vol-postgres');
		expect(buildServiceNetworkAlias('p1', 'redis')).toBe('dotweaver-p-p1-svc-redis');
	});

	it('builds service run args without host ports', () => {
		const args = buildServiceRunArgs({
			image: 'postgres:17-alpine',
			containerName: 'dotweaver-p-p1-svc-postgres',
			network: 'coolify',
			networkAlias: 'dotweaver-p-p1-svc-postgres',
			volumeName: 'dotweaver-p-p1-vol-postgres',
			volumeTarget: '/var/lib/postgresql/data',
			env: {
				POSTGRES_DB: 'app',
				POSTGRES_USER: 'dotweaver',
				POSTGRES_PASSWORD: 'secret'
			},
			command: []
		});
		expect(args).toEqual(expect.arrayContaining(['run', '-d', '--restart', 'unless-stopped']));
		expect(args).toEqual(expect.arrayContaining(['--network', 'coolify']));
		expect(args).toEqual(expect.arrayContaining(['--network-alias', 'dotweaver-p-p1-svc-postgres']));
		expect(args).toEqual(
			expect.arrayContaining(['-v', 'dotweaver-p-p1-vol-postgres:/var/lib/postgresql/data'])
		);
		expect(args).not.toContain('-p');
		expect(args[args.length - 1]).toBe('postgres:17-alpine');
	});

	it('runs docker commands and rejects non-zero exits', async () => {
		spawn.mockReturnValueOnce(fakeChild(0));
		await expect(runDockerCommand(['volume', 'create', 'v1'])).resolves.toBeUndefined();
		spawn.mockReturnValueOnce(fakeChild(1));
		await expect(runDockerCommand(['inspect', 'missing'])).rejects.toThrow(
			'docker inspect missing failed'
		);
	});
});
```

- [ ] **Step 2: Run provider tests to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/project-environment-services/providers.test.ts tests/unit/lib/server/project-environment-services/docker.test.ts --run
```

Expected: FAIL because server provider modules do not exist.

- [ ] **Step 3: Add provider types**

Create `src/lib/server/project-environment-services/types.ts`:

```ts
import type { ProjectEnvironmentServiceKind } from '$lib/domain/project-environment-service';

export type ServiceOutput =
	| { key: string; value: string; sensitive: false; description?: string }
	| { key: string; valueEncrypted: string; sensitive: true; description?: string };

export type PlainServiceOutput = {
	key: string;
	value: string;
	sensitive: boolean;
	description?: string;
};

export type ProviderDefaultsInput = {
	projectId: string;
	name: string;
};

export type ProviderRuntimeInput = {
	projectId: string;
	serviceId: string;
	name: string;
	networkAlias: string;
	config: Record<string, unknown>;
};

export type ProviderValidation = {
	warnings: string[];
	errors: string[];
};

export type ProvisionServiceResult = {
	runtime: Record<string, unknown>;
	outputs: PlainServiceOutput[];
};

export type EnvironmentServiceProvider = {
	kind: ProjectEnvironmentServiceKind;
	version: string;
	defaultName: string;
	defaultConfig(input: ProviderDefaultsInput): Record<string, unknown>;
	validateConfig(config: unknown): ProviderValidation;
	container(input: ProviderRuntimeInput): {
		image: string;
		env: Record<string, string>;
		volumeTarget: string;
		command: string[];
	};
	healthcheck(input: ProviderRuntimeInput): string[];
	buildOutputs(input: ProviderRuntimeInput): PlainServiceOutput[];
	fingerprint(input: ProviderRuntimeInput): Record<string, unknown>;
};
```

- [ ] **Step 4: Add Docker helper implementation**

Create `src/lib/server/project-environment-services/docker.ts`:

```ts
import { spawn } from 'node:child_process';

function sanitizeDockerPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

export function buildServiceContainerName(projectId: string, serviceName: string): string {
	return `dotweaver-p-${sanitizeDockerPart(projectId)}-svc-${sanitizeDockerPart(serviceName)}`;
}

export function buildServiceVolumeName(projectId: string, serviceName: string): string {
	return `dotweaver-p-${sanitizeDockerPart(projectId)}-vol-${sanitizeDockerPart(serviceName)}`;
}

export function buildServiceNetworkAlias(projectId: string, serviceName: string): string {
	return buildServiceContainerName(projectId, serviceName);
}

export function buildServiceRunArgs(input: {
	image: string;
	containerName: string;
	network: string;
	networkAlias: string;
	volumeName: string;
	volumeTarget: string;
	env: Record<string, string>;
	command: string[];
}): string[] {
	const args = [
		'run',
		'-d',
		'--restart',
		'unless-stopped',
		'--name',
		input.containerName,
		'--network',
		input.network,
		'--network-alias',
		input.networkAlias,
		'-v',
		`${input.volumeName}:${input.volumeTarget}`
	];
	for (const [key, value] of Object.entries(input.env)) {
		args.push('-e', `${key}=${value}`);
	}
	args.push(input.image);
	args.push(...input.command);
	return args;
}

export function runDockerCommand(args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', args, { stdio: 'ignore' });
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`docker ${args.join(' ')} failed with exit code ${code}`));
		});
	});
}
```

- [ ] **Step 5: Add provider implementations**

Create `src/lib/server/project-environment-services/providers/postgres.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type {
	EnvironmentServiceProvider,
	ProviderRuntimeInput
} from '$lib/server/project-environment-services/types';

function password() {
	return randomBytes(24).toString('base64url');
}

function postgresConfig(config: Record<string, unknown>) {
	return {
		image: typeof config.image === 'string' ? config.image : 'postgres:17-alpine',
		database: typeof config.database === 'string' ? config.database : 'app',
		user: typeof config.user === 'string' ? config.user : 'dotweaver',
		password: typeof config.password === 'string' ? config.password : password(),
		port: typeof config.port === 'number' ? config.port : 5432
	};
}

export const postgresProvider: EnvironmentServiceProvider = {
	kind: 'postgres',
	version: '1',
	defaultName: 'postgres',
	defaultConfig() {
		return postgresConfig({});
	},
	validateConfig(config) {
		const parsed = postgresConfig(typeof config === 'object' && config ? config : {});
		return {
			warnings: [],
			errors:
				parsed.database.length === 0 || parsed.user.length === 0 || parsed.password.length === 0
					? ['Postgres database, user and password are required']
					: []
		};
	},
	container(input: ProviderRuntimeInput) {
		const config = postgresConfig(input.config);
		return {
			image: config.image,
			env: {
				POSTGRES_DB: config.database,
				POSTGRES_USER: config.user,
				POSTGRES_PASSWORD: config.password
			},
			volumeTarget: '/var/lib/postgresql/data',
			command: []
		};
	},
	healthcheck(input) {
		const config = postgresConfig(input.config);
		return ['exec', input.networkAlias, 'pg_isready', '-U', config.user, '-d', config.database];
	},
	buildOutputs(input) {
		const config = postgresConfig(input.config);
		const host = input.networkAlias;
		const url = `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(
			config.password
		)}@${host}:${config.port}/${encodeURIComponent(config.database)}`;
		return [
			{ key: 'DATABASE_URL', value: url, sensitive: true },
			{ key: 'POSTGRES_HOST', value: host, sensitive: false },
			{ key: 'POSTGRES_PORT', value: String(config.port), sensitive: false },
			{ key: 'POSTGRES_DB', value: config.database, sensitive: false },
			{ key: 'POSTGRES_USER', value: config.user, sensitive: false },
			{ key: 'POSTGRES_PASSWORD', value: config.password, sensitive: true }
		];
	},
	fingerprint(input) {
		const config = postgresConfig(input.config);
		return {
			kind: 'postgres',
			version: this.version,
			image: config.image,
			database: config.database,
			user: config.user,
			port: config.port
		};
	}
};
```

Create `src/lib/server/project-environment-services/providers/redis.ts` with the same pattern:

```ts
import { randomBytes } from 'node:crypto';
import type {
	EnvironmentServiceProvider,
	ProviderRuntimeInput
} from '$lib/server/project-environment-services/types';

function password() {
	return randomBytes(24).toString('base64url');
}

function redisConfig(config: Record<string, unknown>) {
	return {
		image: typeof config.image === 'string' ? config.image : 'redis:7-alpine',
		password: typeof config.password === 'string' ? config.password : password(),
		port: typeof config.port === 'number' ? config.port : 6379,
		appendOnly: typeof config.appendOnly === 'boolean' ? config.appendOnly : true
	};
}

export const redisProvider: EnvironmentServiceProvider = {
	kind: 'redis',
	version: '1',
	defaultName: 'redis',
	defaultConfig() {
		return redisConfig({});
	},
	validateConfig(config) {
		const parsed = redisConfig(typeof config === 'object' && config ? config : {});
		return {
			warnings: [],
			errors: parsed.password.length === 0 ? ['Redis password is required'] : []
		};
	},
	container(input: ProviderRuntimeInput) {
		const config = redisConfig(input.config);
		return {
			image: config.image,
			env: {},
			volumeTarget: '/data',
			command: [
				'redis-server',
				'--appendonly',
				config.appendOnly ? 'yes' : 'no',
				'--requirepass',
				config.password
			]
		};
	},
	healthcheck(input) {
		const config = redisConfig(input.config);
		return ['exec', input.networkAlias, 'redis-cli', '-a', config.password, 'ping'];
	},
	buildOutputs(input: ProviderRuntimeInput) {
		const config = redisConfig(input.config);
		const host = input.networkAlias;
		const url = `redis://:${encodeURIComponent(config.password)}@${host}:${config.port}`;
		return [
			{ key: 'REDIS_URL', value: url, sensitive: true },
			{ key: 'REDIS_HOST', value: host, sensitive: false },
			{ key: 'REDIS_PORT', value: String(config.port), sensitive: false },
			{ key: 'REDIS_PASSWORD', value: config.password, sensitive: true }
		];
	},
	fingerprint(input) {
		const config = redisConfig(input.config);
		return {
			kind: 'redis',
			version: this.version,
			image: config.image,
			port: config.port,
			appendOnly: config.appendOnly
		};
	}
};
```

Create `src/lib/server/project-environment-services/providers/index.ts`:

```ts
import type { ProjectEnvironmentServiceKind } from '$lib/domain/project-environment-service';
import type { EnvironmentServiceProvider } from '$lib/server/project-environment-services/types';
import { postgresProvider } from './postgres';
import { redisProvider } from './redis';

const providers = new Map<ProjectEnvironmentServiceKind, EnvironmentServiceProvider>([
	['postgres', postgresProvider],
	['redis', redisProvider]
]);

export function getEnvironmentServiceProvider(kind: ProjectEnvironmentServiceKind) {
	return providers.get(kind) ?? null;
}

export function listEnvironmentServiceProviders() {
	return [...providers.values()];
}
```

- [ ] **Step 6: Verify provider task**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/project-environment-services/providers.test.ts tests/unit/lib/server/project-environment-services/docker.test.ts --run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/project-environment-services tests/unit/lib/server/project-environment-services
git commit -m "feat(services): add postgres and redis providers"
```

---

### Task 3: Service Events, Notifications And Provisioning Lifecycle

**Files:**

- Create: `src/lib/server/project-environment-services/notifications.ts`
- Create: `src/lib/server/project-environment-services/service.ts`
- Test: `tests/unit/lib/server/project-environment-services/notifications.test.ts`
- Test: `tests/unit/lib/server/project-environment-services/service.test.ts`

- [ ] **Step 1: Write notification tests**

Create `tests/unit/lib/server/project-environment-services/notifications.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
	PROJECT_ENVIRONMENT_SERVICE_CHANNEL,
	notifyProjectEnvironmentService,
	parseProjectEnvironmentServiceNotification
} from '$lib/server/project-environment-services/notifications';

describe('project environment service notifications', () => {
	it('parses valid service notifications', () => {
		expect(
			parseProjectEnvironmentServiceNotification(
				JSON.stringify({
					organizationId: 'org1',
					projectId: 'p1',
					profileId: 'env1',
					serviceId: 'svc1',
					kind: 'event',
					seq: 2
				})
			)
		).toEqual({
			organizationId: 'org1',
			projectId: 'p1',
			profileId: 'env1',
			serviceId: 'svc1',
			kind: 'event',
			seq: 2
		});
	});

	it('rejects invalid notifications', () => {
		expect(parseProjectEnvironmentServiceNotification('not-json')).toBeNull();
		expect(parseProjectEnvironmentServiceNotification(JSON.stringify({ kind: 'event' }))).toBeNull();
	});

	it('emits pg_notify payloads', async () => {
		const db = { $executeRaw: vi.fn().mockResolvedValue(undefined) };
		await notifyProjectEnvironmentService(
			{
				organizationId: 'org1',
				projectId: 'p1',
				profileId: 'env1',
				serviceId: 'svc1',
				kind: 'service'
			},
			db
		);
		const [strings, channel, payload] = db.$executeRaw.mock.calls[0];
		expect(strings.raw.join('?')).toContain('pg_notify');
		expect(channel).toBe(PROJECT_ENVIRONMENT_SERVICE_CHANNEL);
		expect(JSON.parse(payload)).toMatchObject({ serviceId: 'svc1', kind: 'service' });
	});
});
```

- [ ] **Step 2: Write service lifecycle tests**

Create `tests/unit/lib/server/project-environment-services/service.test.ts` with mocked Prisma, Docker and providers:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	projectFindFirst: vi.fn(),
	profileFindFirst: vi.fn(),
	serviceFindMany: vi.fn(),
	serviceFindFirst: vi.fn(),
	serviceCreate: vi.fn(),
	serviceUpdate: vi.fn(),
	serviceUpdateMany: vi.fn(),
	eventCreate: vi.fn(),
	eventFindMany: vi.fn(),
	eventAggregate: vi.fn(),
	runDockerCommand: vi.fn(),
	notify: vi.fn(),
	encrypt: vi.fn((value: string) => `enc:${value}`),
	decrypt: vi.fn((value: string) => value.replace(/^enc:/, ''))
}));

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		project: { findFirst: mocks.projectFindFirst },
		projectEnvironmentProfile: { findFirst: mocks.profileFindFirst },
		projectEnvironmentService: {
			findMany: mocks.serviceFindMany,
			findFirst: mocks.serviceFindFirst,
			create: mocks.serviceCreate,
			update: mocks.serviceUpdate,
			updateMany: mocks.serviceUpdateMany
		},
		projectEnvironmentServiceEvent: {
			create: mocks.eventCreate,
			findMany: mocks.eventFindMany,
			aggregate: mocks.eventAggregate
		}
	}
}));

vi.mock('$lib/server/project-environment-services/docker', () => ({
	buildServiceContainerName: (projectId: string, name: string) => `container-${projectId}-${name}`,
	buildServiceVolumeName: (projectId: string, name: string) => `volume-${projectId}-${name}`,
	buildServiceNetworkAlias: (projectId: string, name: string) => `alias-${projectId}-${name}`,
	buildServiceRunArgs: () => ['run', 'service'],
	runDockerCommand: mocks.runDockerCommand
}));

vi.mock('$lib/server/project-environment-services/notifications', () => ({
	notifyProjectEnvironmentService: mocks.notify
}));

vi.mock('$lib/server/project-agent-config-encryption', () => ({
	encryptProjectSecretValue: mocks.encrypt,
	decryptProjectSecretValue: mocks.decrypt
}));

vi.mock('$env/dynamic/private', () => ({
	env: { RUNNER_NETWORK: 'coolify' }
}));

import {
	ProjectEnvironmentServiceError,
	createProjectEnvironmentServiceForOrg,
	executeProjectEnvironmentServiceProvision,
	listProjectEnvironmentServicesForOrg,
	setProjectEnvironmentServiceEnabledForOrg
} from '$lib/server/project-environment-services/service';

describe('project environment service lifecycle', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.projectFindFirst.mockResolvedValue({ id: 'p1' });
		mocks.profileFindFirst.mockResolvedValue({ id: 'env1', projectId: 'p1' });
		mocks.serviceFindMany.mockResolvedValue([]);
		mocks.serviceFindFirst.mockResolvedValue({
			id: 'svc1',
			projectId: 'p1',
			organizationId: 'org1',
			profileId: 'env1',
			kind: 'postgres',
			name: 'postgres',
			enabled: true,
			status: 'configured',
			config: {
				image: 'postgres:17-alpine',
				database: 'app',
				user: 'dotweaver',
				password: 'pw',
				port: 5432
			},
			outputs: [],
			runtime: {}
		});
		mocks.serviceCreate.mockResolvedValue({ id: 'svc1', name: 'postgres' });
		mocks.serviceUpdate.mockResolvedValue({ id: 'svc1', status: 'ready' });
		mocks.serviceUpdateMany.mockResolvedValue({ count: 1 });
		mocks.eventAggregate.mockResolvedValue({ _max: { seq: 0 } });
		mocks.eventCreate.mockResolvedValue({ id: 'event1', seq: 1 });
		mocks.runDockerCommand.mockResolvedValue(undefined);
	});

	it('lists services scoped to org, project and profile', async () => {
		await listProjectEnvironmentServicesForOrg('org1', 'p1', 'env1');
		expect(mocks.projectFindFirst).toHaveBeenCalledWith({
			where: { id: 'p1', organizationId: 'org1' },
			select: { id: true }
		});
		expect(mocks.serviceFindMany).toHaveBeenCalledWith({
			where: { organizationId: 'org1', projectId: 'p1', profileId: 'env1' },
			orderBy: { createdAt: 'asc' }
		});
	});

	it('creates a configured service with provider defaults', async () => {
		await createProjectEnvironmentServiceForOrg('org1', 'user1', {
			projectId: 'p1',
			profileId: 'env1',
			kind: 'redis',
			name: 'redis'
		});
		expect(mocks.serviceCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				projectId: 'p1',
				organizationId: 'org1',
				profileId: 'env1',
				kind: 'redis',
				name: 'redis',
				status: 'configured',
				createdById: 'user1'
			})
		});
	});

	it('provisions a service and stores encrypted sensitive outputs', async () => {
		await executeProjectEnvironmentServiceProvision({ serviceId: 'svc1' });
		expect(mocks.runDockerCommand).toHaveBeenCalledWith(['volume', 'create', 'volume-p1-postgres']);
		expect(mocks.runDockerCommand).toHaveBeenCalledWith(['run', 'service']);
		expect(mocks.serviceUpdate).toHaveBeenLastCalledWith({
			where: { id: 'svc1' },
			data: expect.objectContaining({
				status: 'ready',
				lastError: null,
				outputs: expect.arrayContaining([
					expect.objectContaining({ key: 'DATABASE_URL', valueEncrypted: expect.stringContaining('enc:') })
				])
			})
		});
	});

	it('marks failed when provisioning throws', async () => {
		mocks.runDockerCommand.mockRejectedValueOnce(new Error('docker unavailable'));
		await expect(executeProjectEnvironmentServiceProvision({ serviceId: 'svc1' })).rejects.toThrow(
			'docker unavailable'
		);
		expect(mocks.serviceUpdate).toHaveBeenLastCalledWith({
			where: { id: 'svc1' },
			data: expect.objectContaining({
				status: 'failed',
				lastError: 'docker unavailable'
			})
		});
	});

	it('toggles enabled status through updateMany scoping', async () => {
		await setProjectEnvironmentServiceEnabledForOrg('org1', {
			projectId: 'p1',
			profileId: 'env1',
			serviceId: 'svc1',
			enabled: false
		});
		expect(mocks.serviceUpdateMany).toHaveBeenCalledWith({
			where: { id: 'svc1', organizationId: 'org1', projectId: 'p1', profileId: 'env1' },
			data: { enabled: false, status: 'disabled' }
		});
	});

	it('throws scoped errors when service updates miss', async () => {
		mocks.serviceUpdateMany.mockResolvedValueOnce({ count: 0 });
		await expect(
			setProjectEnvironmentServiceEnabledForOrg('org1', {
				projectId: 'p1',
				profileId: 'env1',
				serviceId: 'missing',
				enabled: true
			})
		).rejects.toBeInstanceOf(ProjectEnvironmentServiceError);
	});
});
```

- [ ] **Step 3: Run lifecycle tests to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/project-environment-services/notifications.test.ts tests/unit/lib/server/project-environment-services/service.test.ts --run
```

Expected: FAIL because notifications and service modules do not exist.

- [ ] **Step 4: Implement notifications**

Create `src/lib/server/project-environment-services/notifications.ts` using the same shape as `project-environments/notifications.ts`, with:

```ts
export const PROJECT_ENVIRONMENT_SERVICE_CHANNEL = 'project_environment_service';

export type ProjectEnvironmentServiceNotification = {
	organizationId: string;
	projectId: string;
	profileId: string;
	serviceId: string;
	kind: 'event' | 'service';
	seq?: number;
};
```

Validate every string field is non-empty, `kind` is `event` or `service`, and `seq` is a non-negative integer when present. `notifyProjectEnvironmentService` must call:

```ts
await db.$executeRaw`SELECT pg_notify(${PROJECT_ENVIRONMENT_SERVICE_CHANNEL}, ${JSON.stringify(notification)})`;
```

- [ ] **Step 5: Implement service lifecycle**

Create `src/lib/server/project-environment-services/service.ts` with these exported functions:

```ts
export class ProjectEnvironmentServiceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectEnvironmentServiceError';
	}
}

export async function listProjectEnvironmentServicesForOrg(
	organizationId: string,
	projectId: string,
	profileId: string
) { /* scoped findMany */ }

export async function createProjectEnvironmentServiceForOrg(
	organizationId: string,
	createdById: string,
	input: z.infer<typeof projectEnvironmentServiceCreateSchema>
) { /* provider defaults + prisma create + event */ }

export async function executeProjectEnvironmentServiceProvision(input: {
	serviceId: string;
}) { /* load service, provider, docker lifecycle, outputs, status transitions */ }

export async function setProjectEnvironmentServiceEnabledForOrg(
	organizationId: string,
	input: z.infer<typeof projectEnvironmentServiceEnabledSchema>
) { /* updateMany scoped status disabled/configured */ }
```

Use helper functions inside the file:

```ts
function asJson(value: unknown): Prisma.InputJsonValue {
	return value as Prisma.InputJsonValue;
}

function outputRows(outputs: PlainServiceOutput[]): ServiceOutput[] {
	return outputs.map((output) =>
		output.sensitive
			? { key: output.key, valueEncrypted: encryptProjectSecretValue(output.value), sensitive: true }
			: { key: output.key, value: output.value, sensitive: false }
	);
}
```

Provisioning sequence:

```ts
await updateStatus('provisioning', null);
await appendServiceEvent(service, 'system', { text: `Provisioning ${service.kind} service` });
await runDockerCommand(['volume', 'create', volumeName]);
await runDockerCommand(['rm', '-f', containerName]).catch(() => {});
await runDockerCommand(buildServiceRunArgs(containerSpec));
await runDockerCommand(provider.healthcheck(providerInput));
await updateStatus('ready', null, { runtime, outputs, lastReadyAt: new Date() });
await appendServiceEvent(service, 'result', { status: 'ready' });
```

If an error occurs, write an `error` event, set `status = failed`, set `lastError`, notify, then rethrow.

- [ ] **Step 6: Verify lifecycle task**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/project-environment-services/notifications.test.ts tests/unit/lib/server/project-environment-services/service.test.ts --run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/project-environment-services/notifications.ts src/lib/server/project-environment-services/service.ts tests/unit/lib/server/project-environment-services/notifications.test.ts tests/unit/lib/server/project-environment-services/service.test.ts
git commit -m "feat(services): provision environment services"
```

---

### Task 4: Queue Worker And Remote Functions

**Files:**

- Modify: `src/lib/server/queue.ts`
- Modify: `src/runner/index.ts`
- Create: `src/lib/rfc/project-environment-services.remote.ts`
- Test: `tests/unit/lib/server/queue.test.ts`
- Test: `tests/unit/lib/rfc/project-environment-services.remote.test.ts`

- [ ] **Step 1: Extend queue tests**

Add tests to `tests/unit/lib/server/queue.test.ts`:

```ts
it('creates the project environment service provision queue without retries', async () => {
	const boss = { createQueue: vi.fn().mockResolvedValue(undefined) } as unknown as PgBoss;
	await ensureProjectEnvironmentServiceProvisionQueue(boss);
	expect(boss.createQueue).toHaveBeenCalledWith(PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE, {
		retryLimit: 0
	});
});

it('enqueues project environment service provision jobs without retries', async () => {
	const boss = {
		start: vi.fn().mockResolvedValue(undefined),
		createQueue: vi.fn().mockResolvedValue(undefined),
		send: vi.fn().mockResolvedValue(undefined)
	} as unknown as PgBoss;
	mocks.makeBoss.mockReturnValueOnce(boss);
	await enqueueProjectEnvironmentServiceProvision({ serviceId: 'svc1' });
	expect(boss.send).toHaveBeenCalledWith(
		PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE,
		{ serviceId: 'svc1' },
		{ retryLimit: 0 }
	);
});
```

- [ ] **Step 2: Write remote function tests**

Create `tests/unit/lib/rfc/project-environment-services.remote.test.ts` mocking auth context and service functions. Cover:

```ts
it('lists services for the active organization', async () => {
	mocks.listServices.mockResolvedValue([{ id: 'svc1', kind: 'postgres' }]);
	await expect(getProjectEnvironmentServices({ projectId: 'p1', profileId: 'env1' })).resolves.toEqual([
		{ id: 'svc1', kind: 'postgres' }
	]);
});

it('creates a service, enqueues provisioning and refreshes queries', async () => {
	mocks.createService.mockResolvedValue({ id: 'svc1', projectId: 'p1', profileId: 'env1' });
	await expect(
		createProjectEnvironmentService({ projectId: 'p1', profileId: 'env1', kind: 'postgres' })
	).resolves.toEqual({ id: 'svc1', projectId: 'p1', profileId: 'env1' });
	expect(mocks.enqueueProvision).toHaveBeenCalledWith({ serviceId: 'svc1' });
});

it('maps service errors to 400 responses', async () => {
	mocks.createService.mockRejectedValue(new ProjectEnvironmentServiceError('bad service'));
	await expect(
		createProjectEnvironmentService({ projectId: 'p1', profileId: 'env1', kind: 'postgres' })
	).rejects.toMatchObject({ status: 400 });
});
```

- [ ] **Step 3: Run queue/remote tests to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/queue.test.ts tests/unit/lib/rfc/project-environment-services.remote.test.ts --run
```

Expected: FAIL because exports/remotes are missing.

- [ ] **Step 4: Add queue exports**

Modify `src/lib/server/queue.ts`:

```ts
export const PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE =
	'project-environment-service-provision';
export const PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE_OPTIONS = { retryLimit: 0 } as const;

export async function ensureProjectEnvironmentServiceProvisionQueue(boss: PgBoss): Promise<void> {
	await ensureQueue(
		boss,
		PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE,
		PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE_OPTIONS
	);
}

export async function enqueueProjectEnvironmentServiceProvision(input: {
	serviceId: string;
}): Promise<void> {
	const boss = await ensureSender();
	await boss.send(
		PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE,
		input,
		PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE_OPTIONS
	);
}
```

Call `ensureProjectEnvironmentServiceProvisionQueue(sender)` inside `ensureSender`.

- [ ] **Step 5: Add runner worker**

Modify `src/runner/index.ts`:

```ts
import {
	PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE,
	ensureProjectEnvironmentServiceProvisionQueue
} from '$lib/server/queue';
import { executeProjectEnvironmentServiceProvision } from '$lib/server/project-environment-services/service';
```

After the existing queue ensures:

```ts
await ensureProjectEnvironmentServiceProvisionQueue(boss);
```

Add worker:

```ts
await boss.work(PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE, { batchSize: 1 }, async ([job]) => {
	const input = job.data as { serviceId: string };
	console.log('[runner] provisioning project environment service', input.serviceId);
	try {
		await executeProjectEnvironmentServiceProvision(input);
		console.log('[runner] finished project environment service provision', input.serviceId);
	} catch (error) {
		console.error('[runner] project environment service provision failed', input.serviceId, error);
		throw error;
	}
});
```

- [ ] **Step 6: Add remote functions**

Create `src/lib/rfc/project-environment-services.remote.ts`:

```ts
import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireActiveOrg } from '$lib/server/org';
import { requireHeaders } from '$lib/server/utils';
import { enqueueProjectEnvironmentServiceProvision } from '$lib/server/queue';
import {
	ProjectEnvironmentServiceError,
	createProjectEnvironmentServiceForOrg,
	listProjectEnvironmentServicesForOrg,
	setProjectEnvironmentServiceEnabledForOrg
} from '$lib/server/project-environment-services/service';
import {
	projectEnvironmentServiceCreateSchema,
	projectEnvironmentServiceEnabledSchema,
	projectEnvironmentServiceMutationSchema
} from '$lib/schemas/project-environment-services';
import { getProjectEnvironment } from '$lib/rfc/project-environments.remote';

async function context() {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const { locals } = getRequestEvent();
	return { organizationId, userId: locals.user!.id };
}

function mapServiceError(e: unknown): never {
	if (e instanceof ProjectEnvironmentServiceError) error(400, e.message);
	throw e;
}

export const getProjectEnvironmentServices = query(
	z.object({ projectId: z.string().min(1), profileId: z.string().min(1) }),
	async ({ projectId, profileId }) => {
		const { organizationId } = await context();
		try {
			return await listProjectEnvironmentServicesForOrg(organizationId, projectId, profileId);
		} catch (e) {
			mapServiceError(e);
		}
	}
);

export const createProjectEnvironmentService = command(
	projectEnvironmentServiceCreateSchema,
	async (input) => {
		const { organizationId, userId } = await context();
		try {
			const service = await createProjectEnvironmentServiceForOrg(organizationId, userId, input);
			await enqueueProjectEnvironmentServiceProvision({ serviceId: service.id });
			await getProjectEnvironmentServices({
				projectId: input.projectId,
				profileId: input.profileId
			}).refresh();
			await getProjectEnvironment(input.projectId).refresh();
			return service;
		} catch (e) {
			mapServiceError(e);
		}
	}
);

export const provisionProjectEnvironmentService = command(
	projectEnvironmentServiceMutationSchema,
	async (input) => {
		await context();
		await enqueueProjectEnvironmentServiceProvision({ serviceId: input.serviceId });
		await getProjectEnvironmentServices({
			projectId: input.projectId,
			profileId: input.profileId
		}).refresh();
		return { queued: true };
	}
);

export const setProjectEnvironmentServiceEnabled = command(
	projectEnvironmentServiceEnabledSchema,
	async (input) => {
		const { organizationId } = await context();
		try {
			await setProjectEnvironmentServiceEnabledForOrg(organizationId, input);
			await getProjectEnvironmentServices({
				projectId: input.projectId,
				profileId: input.profileId
			}).refresh();
			await getProjectEnvironment(input.projectId).refresh();
			return { updated: true };
		} catch (e) {
			mapServiceError(e);
		}
	}
);
```

- [ ] **Step 7: Verify queue/remote task**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/queue.test.ts tests/unit/lib/rfc/project-environment-services.remote.test.ts --run
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/server/queue.ts src/runner/index.ts src/lib/rfc/project-environment-services.remote.ts tests/unit/lib/server/queue.test.ts tests/unit/lib/rfc/project-environment-services.remote.test.ts
git commit -m "feat(services): enqueue service provisioning"
```

---

### Task 5: Service Outputs, Fingerprint And Prepared `.env`

**Files:**

- Modify: `src/lib/server/project-environment-services/service.ts`
- Modify: `src/lib/server/project-environments/fingerprint.ts`
- Modify: `src/lib/server/project-environments/service.ts`
- Modify: `src/lib/server/project-environments/prepare.ts`
- Modify: `src/lib/server/project-agent-config-service.ts`
- Test: `tests/unit/lib/server/project-environments/fingerprint.test.ts`
- Test: `tests/unit/lib/server/project-environments/service.test.ts`
- Test: `tests/unit/lib/server/project-environments/prepare.test.ts`
- Test: `tests/unit/lib/server/project-agent-config-service.test.ts`

- [ ] **Step 1: Add output merge tests**

In `tests/unit/lib/server/project-agent-config-service.test.ts`, add:

```ts
it('materializes generated service env vars without overwriting manual values', async () => {
	mocks.readFile.mockResolvedValue('DATABASE_URL=manual\nAPP_ENV=local\n');
	await materializeProjectEnvFile(
		'/checkout',
		[{ key: 'APP_ENV', value: 'project' }],
		['.env'],
		[
			{ key: 'DATABASE_URL', value: 'postgresql://service', sensitive: true },
			{ key: 'REDIS_URL', value: 'redis://service', sensitive: true }
		]
	);
	expect(mocks.writeFile).toHaveBeenCalledWith(
		'/checkout/.env',
		expect.stringContaining('DATABASE_URL=manual')
	);
	expect(mocks.writeFile).toHaveBeenCalledWith(
		'/checkout/.env',
		expect.stringContaining('REDIS_URL=redis://service')
	);
});
```

- [ ] **Step 2: Add fingerprint tests**

In `tests/unit/lib/server/project-environments/fingerprint.test.ts`, add:

```ts
it('changes when active service fingerprint inputs change', () => {
	const base = {
		adapterId: 'node',
		adapterVersion: '1',
		runtime: 'node' as const,
		packageManager: 'bun' as const,
		installCommand: 'bun install',
		lockfiles: [],
		envKeys: ['DATABASE_URL'],
		services: [
			{
				kind: 'postgres',
				name: 'postgres',
				enabled: true,
				status: 'ready',
				providerVersion: '1',
				config: { image: 'postgres:17-alpine' },
				outputKeys: ['DATABASE_URL'],
				outputValueHashes: ['hash-a']
			}
		]
	};
	expect(buildProjectEnvironmentFingerprint(base)).not.toBe(
		buildProjectEnvironmentFingerprint({
			...base,
			services: [{ ...base.services[0], outputValueHashes: ['hash-b'] }]
		})
	);
});
```

- [ ] **Step 3: Add run environment service gate tests**

In `tests/unit/lib/server/project-environments/service.test.ts`, extend mocks with `projectEnvironmentService.findMany`. Add:

```ts
it('blocks run environments when an active service is not ready', async () => {
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
	mocks.serviceFindMany.mockResolvedValue([{ id: 'svc1', enabled: true, status: 'failed' }]);
	await expect(buildRunEnvironmentConfig('org1', 'p1')).rejects.toThrow(
		'Project environment service is not ready'
	);
});
```

- [ ] **Step 4: Run output/fingerprint tests to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/project-agent-config-service.test.ts tests/unit/lib/server/project-environments/fingerprint.test.ts tests/unit/lib/server/project-environments/service.test.ts tests/unit/lib/server/project-environments/prepare.test.ts --run
```

Expected: FAIL because service outputs are not wired into these modules.

- [ ] **Step 5: Extend env materialization**

Modify `materializeProjectEnvFile` in `src/lib/server/project-agent-config-service.ts`:

```ts
export type GeneratedEnvFileEntry = { key: string; value: string; sensitive?: boolean };

export async function materializeProjectEnvFile(
	checkoutPath: string,
	envFile: RuntimeAgentConfig['envFile'],
	generatedPaths: string[] = [],
	generatedEnvFile: GeneratedEnvFileEntry[] = []
): Promise<void> {
	const entries = [...generatedEnvFile, ...envFile];
	if (entries.length === 0) return;
	const envPath = join(checkoutPath, '.env');
	let existing = '';
	try {
		existing = await readFile(envPath, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
	await writeFile(envPath, mergeDotenv(existing, entries));
	generatedPaths.push('.env');
	await protectGeneratedAgentConfigFiles(checkoutPath, generatedPaths);
}
```

Manual values already present in `.env` win through `mergeDotenv`; pass generated service entries before manual project entries so project env vars overwrite generated entries when both are generated in the same call.

- [ ] **Step 6: Add service output builders**

In `src/lib/server/project-environment-services/service.ts`, export:

```ts
export async function buildProjectEnvironmentServiceOutputsForOrg(
	organizationId: string,
	projectId: string,
	profileId: string
): Promise<{
	env: Array<{ key: string; value: string; sensitive: boolean }>;
	warnings: string[];
	fingerprintInputs: ProjectEnvironmentServiceFingerprintInput[];
}> { /* ready enabled services only, decrypted sensitive outputs */ }
```

Rules:

- enabled + `ready` outputs are returned;
- enabled + non-ready services produce a warning and are not returned;
- disabled services are ignored for `.env` but included in UI list;
- decrypt `valueEncrypted` with `decryptProjectSecretValue`;
- fingerprint input uses provider version, config payload, output keys and SHA-256 hashes of output values.

- [ ] **Step 7: Extend fingerprint input**

Modify `buildProjectEnvironmentFingerprint`:

```ts
services?: Array<{
	kind: string;
	name: string;
	enabled: boolean;
	status: string;
	providerVersion: string;
	config: Record<string, unknown>;
	outputKeys: string[];
	outputValueHashes: string[];
}>;
```

Include sorted `services` in the JSON payload. Sort by `kind:name`.

- [ ] **Step 8: Wire service outputs into detect/save/prepare**

In `detectProjectEnvironmentForOrg` and `upsertProjectEnvironmentProfileForOrg`, include service fingerprint inputs:

```ts
const serviceOutputs = await buildProjectEnvironmentServiceOutputsForOrg(
	organizationId,
	projectId,
	profileId
);
const currentFingerprint = buildProjectEnvironmentFingerprint({
	/* existing fields */
	envKeys: [...envKeys, ...serviceOutputs.env.map((entry) => entry.key)],
	services: serviceOutputs.fingerprintInputs
});
```

In `executeProjectEnvironmentPrepare`, before `materializeProjectEnvFile`, load service outputs and pass them as `generatedEnvFile`.

- [ ] **Step 9: Block non-ready active services before runs**

In `buildRunEnvironmentConfig`, query active services for the default profile. If any `enabled` service has status not equal to `ready`, throw:

```ts
throw new ProjectEnvironmentError('Project environment service is not ready');
```

Add a `services` summary to the environment snapshot:

```ts
services: readyServices.map((service) => ({
	id: service.id,
	kind: service.kind,
	name: service.name,
	status: service.status
}))
```

- [ ] **Step 10: Verify env/fingerprint task**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/project-agent-config-service.test.ts tests/unit/lib/server/project-environments/fingerprint.test.ts tests/unit/lib/server/project-environments/service.test.ts tests/unit/lib/server/project-environments/prepare.test.ts --run
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/lib/server/project-environment-services/service.ts src/lib/server/project-environments/fingerprint.ts src/lib/server/project-environments/service.ts src/lib/server/project-environments/prepare.ts src/lib/server/project-agent-config-service.ts tests/unit/lib/server/project-environments/fingerprint.test.ts tests/unit/lib/server/project-environments/service.test.ts tests/unit/lib/server/project-environments/prepare.test.ts tests/unit/lib/server/project-agent-config-service.test.ts
git commit -m "feat(services): inject service outputs into environments"
```

---

### Task 6: Service Event Stream

**Files:**

- Create: `src/lib/server/project-environment-services/stream.ts`
- Create: `src/routes/api/projects/[id]/environment-services/[serviceId]/events/+server.ts`
- Test: `tests/unit/lib/server/project-environment-services/stream.test.ts`

- [ ] **Step 1: Write stream tests**

Create `tests/unit/lib/server/project-environment-services/stream.test.ts` modeled after `project-environments/stream.test.ts`. Cover:

```ts
it('yields existing events then live service events', async () => {
	// mock prisma.projectEnvironmentServiceEvent.findMany -> [{ seq: 1, type: 'system' }]
	// mock pg notification payload seq 2
	const stream = streamProjectEnvironmentServiceEvents({
		organizationId: 'org1',
		projectId: 'p1',
		profileId: 'env1',
		serviceId: 'svc1',
		signal: new AbortController().signal
	});
	await expect(stream.next()).resolves.toMatchObject({
		value: { kind: 'event', event: expect.objectContaining({ seq: 1 }) }
	});
	emitNotification({ serviceId: 'svc1', kind: 'event', seq: 2 });
	await expect(stream.next()).resolves.toMatchObject({
		value: { kind: 'event', event: expect.objectContaining({ seq: 2 }) }
	});
});

it('ignores notifications for other services', async () => {
	// emit serviceId svc2 and assert no event is yielded before abort
});
```

- [ ] **Step 2: Run stream tests to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/project-environment-services/stream.test.ts --run
```

Expected: FAIL because stream module does not exist.

- [ ] **Step 3: Implement stream module**

Create `src/lib/server/project-environment-services/stream.ts` using the same pattern as `project-environments/stream.ts`:

```ts
export type ProjectEnvironmentServiceStreamItem =
	| { kind: 'event'; event: ProjectEnvironmentServiceEvent }
	| { kind: 'service'; service: ProjectEnvironmentService }
	| { kind: 'ping' };

export async function* streamProjectEnvironmentServiceEvents(input: {
	organizationId: string;
	projectId: string;
	profileId: string;
	serviceId: string;
	signal: AbortSignal;
}): AsyncGenerator<ProjectEnvironmentServiceStreamItem> {
	// load existing events ordered by seq
	// subscribe to PROJECT_ENVIRONMENT_SERVICE_CHANNEL
	// filter org/project/profile/service
	// yield event or service refresh payloads
	// emit ping on interval to keep SSE alive
}
```

Reuse the existing pg client/listen helper style from `project-environments/stream.ts`; keep channel names separate.

- [ ] **Step 4: Implement SSE endpoint**

Create `src/routes/api/projects/[id]/environment-services/[serviceId]/events/+server.ts`:

```ts
import { error } from '@sveltejs/kit';
import { requireActiveOrg } from '$lib/server/org';
import { requireProjectEnvironmentServiceForOrg } from '$lib/server/project-environment-services/service';
import { streamProjectEnvironmentServiceEvents } from '$lib/server/project-environment-services/stream';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, request }) => {
	const organizationId = await requireActiveOrg(request.headers);
	const service = await requireProjectEnvironmentServiceForOrg(
		organizationId,
		params.id,
		params.serviceId
	);
	if (!service) error(404, 'Project environment service not found');

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			try {
				for await (const item of streamProjectEnvironmentServiceEvents({
					organizationId,
					projectId: params.id,
					profileId: service.profileId,
					serviceId: params.serviceId,
					signal: request.signal
				})) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
				}
			} finally {
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		}
	});
};
```

- [ ] **Step 5: Verify stream task**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/project-environment-services/stream.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/project-environment-services/stream.ts src/routes/api/projects/[id]/environment-services/[serviceId]/events/+server.ts tests/unit/lib/server/project-environment-services/stream.test.ts
git commit -m "feat(services): stream service provisioning updates"
```

---

### Task 7: Setup State And Services UI

**Files:**

- Modify: `src/lib/components/projects/environment-setup-state.ts`
- Create: `src/lib/components/projects/project-environment-services-live.svelte.ts`
- Create: `src/lib/components/projects/ProjectEnvironmentServicesPanel.svelte`
- Modify: `src/lib/components/projects/ProjectSetupChecklist.svelte`
- Modify: `src/routes/(app)/projects/[id]/setup/+page.svelte`
- Test: `tests/unit/lib/components/projects/environment-setup-state.test.ts`
- Test: `tests/unit/lib/components/projects/project-environment-services-panel.svelte.test.ts`
- Test: `tests/unit/routes/project-setup-page.svelte.test.ts`

- [ ] **Step 1: Add setup state tests**

Extend `tests/unit/lib/components/projects/environment-setup-state.test.ts`:

```ts
it('marks services ready when no services exist', () => {
	expect(computeEnvironmentServicesSetupState([])).toEqual({
		status: 'ready',
		label: 'No services configured',
		canOpenProject: true
	});
});

it('blocks setup while a service is provisioning or failed', () => {
	expect(
		computeEnvironmentServicesSetupState([{ id: 'svc1', enabled: true, status: 'provisioning' }])
	).toMatchObject({ status: 'running', canOpenProject: false });
	expect(
		computeEnvironmentServicesSetupState([{ id: 'svc1', enabled: true, status: 'failed' }])
	).toMatchObject({ status: 'failed', canOpenProject: false });
});

it('warns but does not block for disabled services', () => {
	expect(
		computeEnvironmentServicesSetupState([{ id: 'svc1', enabled: false, status: 'disabled' }])
	).toMatchObject({ status: 'warning', canOpenProject: true });
});
```

- [ ] **Step 2: Write panel component test**

Create `tests/unit/lib/components/projects/project-environment-services-panel.svelte.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ProjectEnvironmentServicesPanel from '$lib/components/projects/ProjectEnvironmentServicesPanel.svelte';

describe('ProjectEnvironmentServicesPanel', () => {
	it('adds postgres and redis services', async () => {
		const onCreate = vi.fn().mockResolvedValue({ id: 'svc1' });
		const screen = render(ProjectEnvironmentServicesPanel, {
			projectId: 'p1',
			profileId: 'env1',
			services: [],
			onCreate,
			onProvision: vi.fn(),
			onSetEnabled: vi.fn()
		});
		await screen.getByRole('button', { name: /add postgres/i }).click();
		await screen.getByRole('button', { name: /add redis/i }).click();
		expect(onCreate).toHaveBeenCalledWith({ projectId: 'p1', profileId: 'env1', kind: 'postgres' });
		expect(onCreate).toHaveBeenCalledWith({ projectId: 'p1', profileId: 'env1', kind: 'redis' });
	});

	it('renders service status and masked sensitive outputs', async () => {
		const screen = render(ProjectEnvironmentServicesPanel, {
			projectId: 'p1',
			profileId: 'env1',
			services: [
				{
					id: 'svc1',
					kind: 'postgres',
					name: 'postgres',
					enabled: true,
					status: 'ready',
					outputs: [
						{ key: 'DATABASE_URL', sensitive: true },
						{ key: 'POSTGRES_HOST', value: 'host', sensitive: false }
					]
				}
			],
			onCreate: vi.fn(),
			onProvision: vi.fn(),
			onSetEnabled: vi.fn()
		});
		await expect.element(screen.getByText('postgres')).toBeInTheDocument();
		await expect.element(screen.getByText('ready')).toBeInTheDocument();
		await expect.element(screen.getByText('DATABASE_URL')).toBeInTheDocument();
		await expect.element(screen.getByText('masked')).toBeInTheDocument();
	});
});
```

- [ ] **Step 3: Run UI tests to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/lib/components/projects/environment-setup-state.test.ts tests/unit/lib/components/projects/project-environment-services-panel.svelte.test.ts tests/unit/routes/project-setup-page.svelte.test.ts --run
```

Expected: FAIL because services UI helpers and component are missing.

- [ ] **Step 4: Extend setup state helpers**

Modify `src/lib/components/projects/environment-setup-state.ts`:

```ts
export type EnvironmentServiceSummary = {
	id?: string | null;
	kind?: string | null;
	name?: string | null;
	enabled?: boolean | null;
	status?: string | null;
	lastError?: string | null;
	outputs?: unknown;
};

export function computeEnvironmentServicesSetupState(services: EnvironmentServiceSummary[]) {
	const active = services.filter((service) => service.enabled !== false);
	if (services.length === 0) {
		return { status: 'ready' as const, label: 'No services configured', canOpenProject: true };
	}
	if (active.some((service) => service.status === 'failed')) {
		return { status: 'failed' as const, label: 'A service failed to provision', canOpenProject: false };
	}
	if (active.some((service) => service.status === 'provisioning')) {
		return { status: 'running' as const, label: 'Provisioning services', canOpenProject: false };
	}
	if (active.some((service) => service.status === 'configured')) {
		return { status: 'todo' as const, label: 'Provision services before opening', canOpenProject: false };
	}
	if (services.some((service) => service.enabled === false)) {
		return { status: 'warning' as const, label: 'Some services are disabled', canOpenProject: true };
	}
	return { status: 'ready' as const, label: 'Services ready', canOpenProject: true };
}
```

Update `computeEnvironmentSetupState(profile, services = [])` so `canOpenProject` requires both prepare readiness and `servicesState.canOpenProject`.

- [ ] **Step 5: Add services live wrapper**

Create `src/lib/components/projects/project-environment-services-live.svelte.ts`:

```ts
import { browser } from '$app/environment';
import { SvelteMap } from 'svelte/reactivity';
import type { EnvironmentServiceSummary, PrepareEvent } from './environment-setup-state';

const liveServices = new SvelteMap<string, EnvironmentServiceSummary>();
const liveEvents = new SvelteMap<string, PrepareEvent[]>();

function serviceKey(projectId: string, serviceId: string) {
	return `${projectId}:${serviceId}`;
}

export function createProjectEnvironmentServicesLiveState(input: {
	projectId: () => string;
	profileId: () => string;
	services: () => EnvironmentServiceSummary[];
}) {
	$effect(() => {
		if (!browser) return;
		for (const service of input.services()) {
			if (!service.id) continue;
			const key = serviceKey(input.projectId(), service.id);
			const source = new EventSource(
				`/api/projects/${encodeURIComponent(input.projectId())}/environment-services/${encodeURIComponent(service.id)}/events`
			);
			source.onmessage = (event) => {
				const item = JSON.parse(event.data);
				if (item.kind === 'service') liveServices.set(key, item.service);
				if (item.kind === 'event') liveEvents.set(key, [...(liveEvents.get(key) ?? []), item.event]);
			};
			return () => source.close();
		}
	});

	return {
		get services() {
			return input.services().map((service) =>
				service.id ? (liveServices.get(serviceKey(input.projectId(), service.id)) ?? service) : service
			);
		},
		events(serviceId: string) {
			return liveEvents.get(serviceKey(input.projectId(), serviceId)) ?? [];
		}
	};
}
```

- [ ] **Step 6: Add services panel component**

Create `src/lib/components/projects/ProjectEnvironmentServicesPanel.svelte` with typed props:

```svelte
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Database, LoaderCircle, Plus, RotateCcw, Server, ToggleLeft, ToggleRight } from '@lucide/svelte';
	import type { ProjectEnvironmentServiceKind } from '$lib/domain/project-environment-service';
	import type { EnvironmentServiceSummary } from './environment-setup-state';

	type Props = {
		projectId: string;
		profileId: string;
		services: EnvironmentServiceSummary[];
		onCreate: (input: { projectId: string; profileId: string; kind: ProjectEnvironmentServiceKind }) => Promise<unknown>;
		onProvision: (input: { projectId: string; profileId: string; serviceId: string }) => Promise<unknown>;
		onSetEnabled: (input: { projectId: string; profileId: string; serviceId: string; enabled: boolean }) => Promise<unknown>;
	};

	let { projectId, profileId, services, onCreate, onProvision, onSetEnabled }: Props = $props();
	let busy = $state<string | null>(null);
	let error = $state<string | null>(null);

	async function runAction(key: string, action: () => Promise<unknown>) {
		if (busy) return;
		busy = key;
		error = null;
		try {
			await action();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Service action failed';
		} finally {
			busy = null;
		}
	}
</script>

<Card.Root size="sm">
	<Card.Header>
		<Card.Title>Services</Card.Title>
		<Card.Description>Persistent project services injected into prepared environments.</Card.Description>
		<Card.Action><Database class="size-4 text-muted-foreground" /></Card.Action>
	</Card.Header>
	<Card.Content class="space-y-3">
		{#if error}
			<p class="text-sm text-destructive" role="alert">{error}</p>
		{/if}
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" onclick={() => void runAction('create-postgres', () => onCreate({ projectId, profileId, kind: 'postgres' }))} disabled={!profileId || !!busy}>
				{#if busy === 'create-postgres'}<LoaderCircle class="animate-spin" />{:else}<Plus />{/if}
				Add Postgres
			</Button>
			<Button variant="outline" onclick={() => void runAction('create-redis', () => onCreate({ projectId, profileId, kind: 'redis' }))} disabled={!profileId || !!busy}>
				{#if busy === 'create-redis'}<LoaderCircle class="animate-spin" />{:else}<Plus />{/if}
				Add Redis
			</Button>
		</div>
		{#if services.length === 0}
			<p class="text-sm text-muted-foreground">No services configured.</p>
		{:else}
			<div class="space-y-2">
				{#each services as service (service.id)}
					<div class="rounded-md border border-border p-3">
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0">
								<p class="truncate text-sm font-medium">{service.name ?? service.kind}</p>
								<p class="text-xs text-muted-foreground">{service.kind}</p>
							</div>
							<Badge variant={service.status === 'failed' ? 'destructive' : 'outline'}>{service.status}</Badge>
						</div>
						<div class="mt-3 flex flex-wrap gap-2">
							<Button size="sm" variant="outline" onclick={() => service.id && void runAction(`provision-${service.id}`, () => onProvision({ projectId, profileId, serviceId: service.id! }))} disabled={!service.id || !!busy}>
								<RotateCcw />
								Provision
							</Button>
							<Button size="sm" variant="outline" onclick={() => service.id && void runAction(`enabled-${service.id}`, () => onSetEnabled({ projectId, profileId, serviceId: service.id!, enabled: service.enabled === false }))} disabled={!service.id || !!busy}>
								{#if service.enabled === false}<ToggleLeft />{:else}<ToggleRight />{/if}
								{service.enabled === false ? 'Enable' : 'Disable'}
							</Button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</Card.Content>
</Card.Root>
```

Add output rendering from the test before finalizing:

```svelte
{#if Array.isArray(service.outputs) && service.outputs.length > 0}
	<ul class="mt-3 space-y-1 text-xs text-muted-foreground">
		{#each service.outputs as output}
			<li>{output.key}: {output.sensitive ? 'masked' : output.value}</li>
		{/each}
	</ul>
{/if}
```

- [ ] **Step 7: Wire setup page and checklist**

Modify `ProjectSetupChecklist.svelte`:

- add `services` prop;
- pass services to `computeEnvironmentSetupState(environment, services)`;
- replace the placeholder Services card with `ProjectEnvironmentServicesPanel`.

Modify `src/routes/(app)/projects/[id]/setup/+page.svelte`:

```ts
import {
	createProjectEnvironmentService,
	getProjectEnvironmentServices,
	provisionProjectEnvironmentService,
	setProjectEnvironmentServiceEnabled
} from '$lib/rfc/project-environment-services.remote';
import { createProjectEnvironmentServicesLiveState } from '$lib/components/projects/project-environment-services-live.svelte';

const services = $derived(
	environmentProfileId
		? getProjectEnvironmentServices({ projectId, profileId: environmentProfileId })
		: undefined
);
const liveServices = createProjectEnvironmentServicesLiveState({
	projectId: () => projectId,
	profileId: () => environmentProfileId,
	services: () => services?.current ?? []
});
```

Pass `services={liveServices.services}` and the three service action handlers into `ProjectSetupChecklist`.

- [ ] **Step 8: Run Svelte autofixer**

Run `mcp__svelte.svelte_autofixer` on:

- `ProjectEnvironmentServicesPanel.svelte`
- `ProjectSetupChecklist.svelte`
- `+page.svelte`
- `project-environment-services-live.svelte.ts`

Apply fixes until there are no issues.

- [ ] **Step 9: Verify UI task**

Run:

```bash
bun run test:unit -- tests/unit/lib/components/projects/environment-setup-state.test.ts tests/unit/lib/components/projects/project-environment-services-panel.svelte.test.ts tests/unit/routes/project-setup-page.svelte.test.ts --run
bun run check
```

Expected: tests PASS and `svelte-check` reports 0 errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/components/projects/environment-setup-state.ts src/lib/components/projects/project-environment-services-live.svelte.ts src/lib/components/projects/ProjectEnvironmentServicesPanel.svelte src/lib/components/projects/ProjectSetupChecklist.svelte src/routes/(app)/projects/[id]/setup/+page.svelte tests/unit/lib/components/projects/environment-setup-state.test.ts tests/unit/lib/components/projects/project-environment-services-panel.svelte.test.ts tests/unit/routes/project-setup-page.svelte.test.ts
git commit -m "feat(services): add setup services panel"
```

---

### Task 8: Final Verification And Manual Smoke Path

**Files:**

- Modify tests only if verification exposes a real issue.

- [ ] **Step 1: Run focused unit suites**

Run:

```bash
bun run test:unit -- tests/unit/lib/schemas/project-environment-services.test.ts tests/unit/lib/server/project-environment-services/providers.test.ts tests/unit/lib/server/project-environment-services/docker.test.ts tests/unit/lib/server/project-environment-services/notifications.test.ts tests/unit/lib/server/project-environment-services/service.test.ts tests/unit/lib/server/project-environment-services/stream.test.ts tests/unit/lib/rfc/project-environment-services.remote.test.ts tests/unit/lib/components/projects/project-environment-services-panel.svelte.test.ts tests/unit/routes/project-setup-page.svelte.test.ts --run
```

Expected: all focused tests PASS.

- [ ] **Step 2: Run full checks**

Run:

```bash
bun run check
bun run test:unit -- --run
```

Expected: `svelte-check` has 0 errors and the full unit suite exits 0.

- [ ] **Step 3: Build runner image if Docker-related scripts changed**

Run:

```bash
RUNNER_IMAGE=dotweaver-runner bun run runner:build-image
```

Expected: image builds successfully. If the output includes Docker legacy builder warnings, note them as non-blocking.

- [ ] **Step 4: Manual smoke with Docker**

With the app and runner running, test:

```bash
docker ps --format '{{.Names}}'
```

Expected after adding services from setup:

```text
dotweaver-p-<projectId>-svc-postgres
dotweaver-p-<projectId>-svc-redis
```

Then launch a run asking the agent:

```text
Check that DATABASE_URL and REDIS_URL exist, do not print their full values, and try a basic connection to Postgres and Redis.
```

Expected: the agent sees both variables and can connect.

- [ ] **Step 5: Restart persistence smoke**

Restart the dotWeaver server and runner, then run:

```bash
docker ps --format '{{.Names}}'
```

Expected: service containers still exist or restart automatically. A new run still receives `DATABASE_URL` and `REDIS_URL`.

- [ ] **Step 6: Commit verification fixes if needed**

If verification exposes a defect in one of the feature files from this plan,
stage the exact corrected file paths from the relevant task and commit with:

```bash
git commit -m "fix(services): stabilize environment service flow"
```

If no fixes were required, do not create an empty commit.

---

## Self-Review Notes

Spec coverage:

- Postgres/Redis providers: Tasks 2 and 3.
- Docker volumes and network lifecycle: Tasks 2 and 3.
- Outputs and `.env` injection: Task 5.
- Fingerprint invalidation: Task 5.
- Queue-backed provisioning: Task 4.
- Live updates: Task 6.
- Setup UI: Task 7.
- Tests and manual smoke: Task 8.

The plan keeps external URLs, per-run services, backup/restore, host ports and additional providers outside the implementation, matching the approved v1 scope.
