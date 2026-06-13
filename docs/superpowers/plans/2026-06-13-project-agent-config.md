# Project Agent Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-project Claude Code MCP servers, skills, and named secrets that dotWeaver injects into runs by default.

**Architecture:** Store project agent config in normalized Prisma tables, validate it through Zod schemas, and project it into the run checkout before Docker starts. Secrets are encrypted in the database, masked in UI queries, and injected only as Docker environment variables.

**Tech Stack:** SvelteKit remote functions, Svelte 5 runes, Prisma/PostgreSQL, Zod, Node crypto, Vitest, Docker runner, Claude Code Agent SDK.

---

## File Structure

- Modify: `prisma/schema.prisma`
  - Add `ProjectMcpTransport` and `ProjectSkillSource` enums.
  - Add `ProjectMcpServer`, `ProjectSkill`, and `ProjectSecret` models.
  - Add `Project` relation fields and `Run.useProjectAgentConfig` / `Run.agentConfigSnapshot`.
- Create: `prisma/migrations/20260613000000_add_project_agent_config/migration.sql`
  - SQL migration matching the Prisma schema.
- Create: `src/lib/schemas/project-agent-config.ts`
  - Zod schemas, name validation, sensitive key detection, skill markdown normalization.
- Modify: `src/lib/schemas/runs.ts`
  - Add `useProjectAgentConfig` to `startRunSchema`.
- Create: `tests/unit/lib/schemas/project-agent-config.test.ts`
  - Tests for schemas and normalization.
- Modify: `tests/unit/lib/schemas/runs.test.ts`
  - Tests for the run opt-out flag.
- Create: `src/lib/server/project-agent-config-encryption.ts`
  - AES-256-GCM encryption/decryption for project secrets.
- Create: `tests/unit/lib/server/project-agent-config-encryption.test.ts`
  - Tests for encryption, decryption, and missing key failures.
- Create: `src/lib/server/project-agent-config-service.ts`
  - Org-scoped CRUD, secret masking, runtime projection, file materialization.
- Create: `tests/unit/lib/server/project-agent-config-service.test.ts`
  - Service tests with mocked Prisma and tmpdir file generation.
- Modify: `src/lib/rfc/runs.remote.ts`
  - Validate active config on `startRun`, persist `useProjectAgentConfig`.
- Modify: `src/lib/server/run-orchestrator.ts`
  - Materialize config before Docker and inject resolved secret env.
- Modify: `tests/unit/lib/server/run-orchestrator.test.ts`
  - Tests for materialization, opt-out, env injection, and pre-Docker failure.
- Create: `src/lib/rfc/project-agent-config.remote.ts`
  - Remote query/commands for project config UI.
- Modify: `src/routes/(app)/projects/[id]/+page.svelte`
  - Add agent config panel and run opt-out toggle.
- Create: `src/lib/components/projects/AgentConfigPanel.svelte`
  - Compact panel for MCP servers, skills, and secrets.
- Create: `src/lib/components/projects/McpServerEditor.svelte`
  - Structured MCP editor.
- Create: `src/lib/components/projects/SkillEditor.svelte`
  - Markdown skill editor.
- Create: `src/lib/components/projects/SecretEditor.svelte`
  - Secret create/replace form.

---

### Task 1: Agent Config Schemas

**Files:**

- Create: `src/lib/schemas/project-agent-config.ts`
- Create: `tests/unit/lib/schemas/project-agent-config.test.ts`
- Modify: `src/lib/schemas/runs.ts`
- Modify: `tests/unit/lib/schemas/runs.test.ts`

- [ ] **Step 1: Write failing schema tests**

Create `tests/unit/lib/schemas/project-agent-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
	agentConfigNameSchema,
	isSensitiveConfigKey,
	normalizeSkillBody,
	projectMcpServerInputSchema,
	projectSkillInputSchema,
	projectSecretInputSchema
} from '$lib/schemas/project-agent-config';

describe('agent config names', () => {
	it('accepts letters, numbers, underscore and dash', () => {
		for (const name of ['linear', 'github_api', 'svelte-mcp', 'mcp2']) {
			expect(agentConfigNameSchema.safeParse(name).success).toBe(true);
		}
	});

	it('rejects spaces, path traversal, and reserved dotweaver name', () => {
		for (const name of ['linear api', '../secret', 'a/b', 'dotweaver']) {
			expect(agentConfigNameSchema.safeParse(name).success).toBe(false);
		}
	});
});

describe('projectMcpServerInputSchema', () => {
	it('accepts http and sse servers with urls', () => {
		expect(
			projectMcpServerInputSchema.safeParse({
				projectId: 'p1',
				name: 'linear',
				transport: 'http',
				enabled: true,
				url: 'https://mcp.linear.app/mcp',
				headers: { 'x-public-header': 'public' },
				env: { LINEAR_API_KEY: { secretName: 'linear_api_key' } }
			}).success
		).toBe(true);

		expect(
			projectMcpServerInputSchema.safeParse({
				projectId: 'p1',
				name: 'events',
				transport: 'sse',
				url: 'https://example.com/sse',
				env: {}
			}).success
		).toBe(true);
	});

	it('accepts stdio servers with command and args', () => {
		expect(
			projectMcpServerInputSchema.safeParse({
				projectId: 'p1',
				name: 'filesystem',
				transport: 'stdio',
				command: 'node',
				args: ['server.mjs'],
				env: {}
			}).success
		).toBe(true);
	});

	it('rejects missing url or command', () => {
		expect(
			projectMcpServerInputSchema.safeParse({
				projectId: 'p1',
				name: 'bad-http',
				transport: 'http',
				env: {}
			}).success
		).toBe(false);

		expect(
			projectMcpServerInputSchema.safeParse({
				projectId: 'p1',
				name: 'bad-stdio',
				transport: 'stdio',
				env: {}
			}).success
		).toBe(false);
	});

	it('rejects sensitive static headers', () => {
		const parsed = projectMcpServerInputSchema.safeParse({
			projectId: 'p1',
			name: 'github',
			transport: 'http',
			url: 'https://example.com/mcp',
			headers: { Authorization: 'Bearer abc' },
			env: {}
		});
		expect(parsed.success).toBe(false);
	});
});

describe('project skills and secrets', () => {
	it('normalizes skill markdown with frontmatter', () => {
		const body = normalizeSkillBody({
			name: 'review',
			description: 'Review code changes',
			body: '## Instructions\n\nReview the diff.'
		});
		expect(body).toContain('---\nname: review\n');
		expect(body).toContain('description: Review code changes');
		expect(body).toContain('Review the diff.');
	});

	it('accepts skill and secret inputs', () => {
		expect(
			projectSkillInputSchema.safeParse({
				projectId: 'p1',
				name: 'review',
				description: 'Review changes',
				body: '## Instructions\nReview changes.',
				enabled: true
			}).success
		).toBe(true);

		expect(
			projectSecretInputSchema.safeParse({
				projectId: 'p1',
				name: 'linear_api_key',
				value: 'lin_123'
			}).success
		).toBe(true);
	});
});

describe('sensitive key detection', () => {
	it('detects auth and token names', () => {
		for (const key of ['Authorization', 'x-api-key', 'access_token', 'client_secret']) {
			expect(isSensitiveConfigKey(key)).toBe(true);
		}
		expect(isSensitiveConfigKey('x-feature-flag')).toBe(false);
	});
});
```

Modify `tests/unit/lib/schemas/runs.test.ts`:

```ts
it('accepts useProjectAgentConfig when starting a run', () => {
	expect(
		startRunSchema.safeParse({
			projectId: 'p1',
			prompt: 'go',
			useProjectAgentConfig: false
		}).success
	).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/schemas/project-agent-config.test.ts tests/unit/lib/schemas/runs.test.ts
```

Expected: FAIL because `src/lib/schemas/project-agent-config.ts` does not exist and `useProjectAgentConfig` is not in `startRunSchema`.

- [ ] **Step 3: Implement schemas**

Create `src/lib/schemas/project-agent-config.ts`:

```ts
import { z } from 'zod';

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const SENSITIVE_KEY_RE = /(authorization|token|api[-_]?key|secret|password)/i;
const RESERVED_NAMES = new Set(['dotweaver']);

export const agentConfigNameSchema = z
	.string()
	.min(1)
	.max(80)
	.regex(NAME_RE, 'Use only letters, numbers, underscores and dashes')
	.refine((name) => !RESERVED_NAMES.has(name), 'This name is reserved');

export function isSensitiveConfigKey(key: string): boolean {
	return SENSITIVE_KEY_RE.test(key);
}

export const mcpSecretRefSchema = z.object({
	secretName: agentConfigNameSchema
});

const publicHeadersSchema = z.record(z.string().min(1), z.string()).default({});
const envRefsSchema = z.record(z.string().min(1), mcpSecretRefSchema).default({});

const baseMcpSchema = z.object({
	id: z.string().min(1).optional(),
	projectId: z.string().min(1),
	name: agentConfigNameSchema,
	enabled: z.boolean().default(true),
	env: envRefsSchema
});

const httpMcpSchema = baseMcpSchema.extend({
	transport: z.literal('http'),
	url: z.string().url(),
	headers: publicHeadersSchema
});

const sseMcpSchema = baseMcpSchema.extend({
	transport: z.literal('sse'),
	url: z.string().url(),
	headers: publicHeadersSchema
});

const stdioMcpSchema = baseMcpSchema.extend({
	transport: z.literal('stdio'),
	command: z.string().min(1),
	args: z.array(z.string()).default([])
});

export const projectMcpServerInputSchema = z
	.discriminatedUnion('transport', [httpMcpSchema, sseMcpSchema, stdioMcpSchema])
	.superRefine((input, ctx) => {
		if (input.transport === 'stdio') return;
		for (const key of Object.keys(input.headers)) {
			if (isSensitiveConfigKey(key)) {
				ctx.addIssue({
					code: 'custom',
					path: ['headers', key],
					message: 'Sensitive headers must be stored as project secrets'
				});
			}
		}
	});

export type ProjectMcpServerInput = z.infer<typeof projectMcpServerInputSchema>;

export const projectSkillInputSchema = z.object({
	id: z.string().min(1).optional(),
	projectId: z.string().min(1),
	name: agentConfigNameSchema,
	enabled: z.boolean().default(true),
	description: z.string().min(1).max(300),
	body: z.string().min(1)
});

export type ProjectSkillInput = z.infer<typeof projectSkillInputSchema>;

export const projectSecretInputSchema = z.object({
	projectId: z.string().min(1),
	name: agentConfigNameSchema,
	value: z.string().min(1)
});

export type ProjectSecretInput = z.infer<typeof projectSecretInputSchema>;

export const projectConfigIdSchema = z.object({
	projectId: z.string().min(1),
	id: z.string().min(1)
});

export const projectConfigEnabledSchema = projectConfigIdSchema.extend({
	enabled: z.boolean()
});

export const importProjectMcpJsonSchema = z.object({
	projectId: z.string().min(1),
	json: z.string().min(1)
});

export const importProjectSkillMarkdownSchema = z.object({
	projectId: z.string().min(1),
	name: agentConfigNameSchema.optional(),
	markdown: z.string().min(1)
});

export function normalizeSkillBody(input: {
	name: string;
	description: string;
	body: string;
}): string {
	const trimmed = input.body.trim();
	if (trimmed.startsWith('---')) return `${trimmed}\n`;
	return [
		'---',
		`name: ${input.name}`,
		`description: ${input.description}`,
		'---',
		'',
		trimmed,
		''
	].join('\n');
}
```

Modify `src/lib/schemas/runs.ts`:

```ts
export const startRunSchema = z.object({
	projectId: z.string().min(1, 'Project is required'),
	prompt: z.string().min(1, 'A prompt is required'),
	model: runModelSchema.optional(),
	useProjectAgentConfig: z.boolean().default(true)
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/schemas/project-agent-config.test.ts tests/unit/lib/schemas/runs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schemas/project-agent-config.ts src/lib/schemas/runs.ts tests/unit/lib/schemas/project-agent-config.test.ts tests/unit/lib/schemas/runs.test.ts
git commit -m "feat(agent): add project agent config schemas"
```

---

### Task 2: Prisma Models and Migration

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260613000000_add_project_agent_config/migration.sql`

- [ ] **Step 1: Update Prisma schema**

Add enums after `RunInteractionStatus`:

```prisma
enum ProjectMcpTransport {
  http
  sse
  stdio
}

enum ProjectSkillSource {
  manual
  imported
  synced
}
```

Add relation fields to `User`:

```prisma
  projectSecrets ProjectSecret[]
```

Add relation fields to `Project`:

```prisma
  mcpServers     ProjectMcpServer[]
  skills         ProjectSkill[]
  secrets        ProjectSecret[]
```

Add fields to `Run`:

```prisma
  useProjectAgentConfig Boolean @default(true)
  agentConfigSnapshot   Json?
```

Add models after `Project`:

```prisma
model ProjectMcpServer {
  id             String              @id @default(cuid())
  projectId      String
  project        Project             @relation(fields: [projectId], references: [id], onDelete: Cascade)
  organizationId String
  name           String
  transport      ProjectMcpTransport
  enabled        Boolean             @default(true)
  config         Json
  env            Json                @default("{}")
  createdAt      DateTime            @default(now())
  updatedAt      DateTime            @updatedAt

  @@unique([projectId, name])
  @@index([organizationId, projectId])
  @@map("project_mcp_server")
}

model ProjectSkill {
  id             String             @id @default(cuid())
  projectId      String
  project        Project            @relation(fields: [projectId], references: [id], onDelete: Cascade)
  organizationId String
  name           String
  enabled        Boolean            @default(true)
  description    String
  body           String
  source         ProjectSkillSource @default(manual)
  createdAt      DateTime           @default(now())
  updatedAt      DateTime           @updatedAt

  @@unique([projectId, name])
  @@index([organizationId, projectId])
  @@map("project_skill")
}

model ProjectSecret {
  id             String   @id @default(cuid())
  projectId      String
  project        Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  organizationId String
  name           String
  valueEncrypted String
  createdById    String
  createdBy      User     @relation(fields: [createdById], references: [id], onDelete: Cascade)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([projectId, name])
  @@index([organizationId, projectId])
  @@map("project_secret")
}
```

- [ ] **Step 2: Write migration SQL**

Create `prisma/migrations/20260613000000_add_project_agent_config/migration.sql`:

```sql
CREATE TYPE "ProjectMcpTransport" AS ENUM ('http', 'sse', 'stdio');

CREATE TYPE "ProjectSkillSource" AS ENUM ('manual', 'imported', 'synced');

ALTER TABLE "run"
ADD COLUMN "useProjectAgentConfig" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "agentConfigSnapshot" JSONB;

CREATE TABLE "project_mcp_server" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "transport" "ProjectMcpTransport" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL,
    "env" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_mcp_server_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_skill" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "source" "ProjectSkillSource" NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_skill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_secret" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "valueEncrypted" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_secret_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_mcp_server_projectId_name_key" ON "project_mcp_server"("projectId", "name");
CREATE INDEX "project_mcp_server_organizationId_projectId_idx" ON "project_mcp_server"("organizationId", "projectId");

CREATE UNIQUE INDEX "project_skill_projectId_name_key" ON "project_skill"("projectId", "name");
CREATE INDEX "project_skill_organizationId_projectId_idx" ON "project_skill"("organizationId", "projectId");

CREATE UNIQUE INDEX "project_secret_projectId_name_key" ON "project_secret"("projectId", "name");
CREATE INDEX "project_secret_organizationId_projectId_idx" ON "project_secret"("organizationId", "projectId");

ALTER TABLE "project_mcp_server"
ADD CONSTRAINT "project_mcp_server_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_skill"
ADD CONSTRAINT "project_skill_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_secret"
ADD CONSTRAINT "project_secret_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_secret"
ADD CONSTRAINT "project_secret_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "user"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Generate Prisma client**

Run:

```bash
bunx prisma generate
```

Expected: Prisma client generation succeeds.

- [ ] **Step 4: Run schema tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/schemas/project-agent-config.test.ts tests/unit/lib/schemas/runs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260613000000_add_project_agent_config/migration.sql
git commit -m "feat(agent): add project agent config models"
```

---

### Task 3: Project Secret Encryption

**Files:**

- Create: `src/lib/server/project-agent-config-encryption.ts`
- Create: `tests/unit/lib/server/project-agent-config-encryption.test.ts`

- [ ] **Step 1: Write failing encryption tests**

Create `tests/unit/lib/server/project-agent-config-encryption.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
	decryptProjectSecretValue,
	encryptProjectSecretValue,
	ProjectSecretEncryptionError
} from '$lib/server/project-agent-config-encryption';

const env = {
	PROJECT_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64')
};

describe('project secret encryption', () => {
	it('encrypts and decrypts a value', () => {
		const encrypted = encryptProjectSecretValue('secret-value', env);
		expect(encrypted).toMatch(/^v1:/);
		expect(encrypted).not.toContain('secret-value');
		expect(decryptProjectSecretValue(encrypted, env)).toBe('secret-value');
	});

	it('uses a random iv for each encryption', () => {
		const first = encryptProjectSecretValue('secret-value', env);
		const second = encryptProjectSecretValue('secret-value', env);
		expect(first).not.toBe(second);
	});

	it('throws a clear error when the key is missing', () => {
		expect(() => encryptProjectSecretValue('secret-value', {})).toThrow(
			ProjectSecretEncryptionError
		);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/project-agent-config-encryption.test.ts
```

Expected: FAIL because the encryption module does not exist.

- [ ] **Step 3: Implement encryption helper**

Create `src/lib/server/project-agent-config-encryption.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env as privateEnv } from '$env/dynamic/private';

type EnvLike = Record<string, string | undefined>;

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

export class ProjectSecretEncryptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectSecretEncryptionError';
	}
}

function getKey(env: EnvLike = privateEnv): Buffer {
	const value = env.PROJECT_SECRET_ENCRYPTION_KEY;
	if (!value) {
		throw new ProjectSecretEncryptionError('PROJECT_SECRET_ENCRYPTION_KEY is required');
	}
	const key = Buffer.from(value, 'base64');
	if (key.length !== 32) {
		throw new ProjectSecretEncryptionError(
			'PROJECT_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key'
		);
	}
	return key;
}

export function encryptProjectSecretValue(value: string, env: EnvLike = privateEnv): string {
	const key = getKey(env);
	const iv = randomBytes(12);
	const cipher = createCipheriv(ALGORITHM, key, iv);
	const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [
		VERSION,
		iv.toString('base64'),
		tag.toString('base64'),
		encrypted.toString('base64')
	].join(':');
}

export function decryptProjectSecretValue(encrypted: string, env: EnvLike = privateEnv): string {
	const [version, ivRaw, tagRaw, ciphertextRaw] = encrypted.split(':');
	if (version !== VERSION || !ivRaw || !tagRaw || !ciphertextRaw) {
		throw new ProjectSecretEncryptionError('Invalid project secret ciphertext');
	}
	const decipher = createDecipheriv(ALGORITHM, getKey(env), Buffer.from(ivRaw, 'base64'));
	decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
	return Buffer.concat([
		decipher.update(Buffer.from(ciphertextRaw, 'base64')),
		decipher.final()
	]).toString('utf8');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/project-agent-config-encryption.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/project-agent-config-encryption.ts tests/unit/lib/server/project-agent-config-encryption.test.ts
git commit -m "feat(agent): encrypt project config secrets"
```

---

### Task 4: Config Service CRUD and Projection

**Files:**

- Create: `src/lib/server/project-agent-config-service.ts`
- Create: `tests/unit/lib/server/project-agent-config-service.test.ts`

- [ ] **Step 1: Write failing service tests**

Create `tests/unit/lib/server/project-agent-config-service.test.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	projectFindFirst: vi.fn(),
	mcpFindMany: vi.fn(),
	skillFindMany: vi.fn(),
	secretFindMany: vi.fn(),
	secretUpsert: vi.fn(),
	mcpUpsert: vi.fn(),
	skillUpsert: vi.fn()
}));

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		project: { findFirst: mocks.projectFindFirst },
		projectMcpServer: { findMany: mocks.mcpFindMany, upsert: mocks.mcpUpsert },
		projectSkill: { findMany: mocks.skillFindMany, upsert: mocks.skillUpsert },
		projectSecret: { findMany: mocks.secretFindMany, upsert: mocks.secretUpsert }
	}
}));

vi.mock('$env/dynamic/private', () => ({
	env: { PROJECT_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') }
}));

import { encryptProjectSecretValue } from '$lib/server/project-agent-config-encryption';
import {
	buildRunAgentConfig,
	listProjectAgentConfigForOrg,
	materializeRunAgentConfig,
	ProjectAgentConfigError
} from '$lib/server/project-agent-config-service';

let tempDir: string | undefined;

describe('project-agent-config-service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.projectFindFirst.mockResolvedValue({ id: 'p1', organizationId: 'org1' });
		mocks.mcpFindMany.mockResolvedValue([]);
		mocks.skillFindMany.mockResolvedValue([]);
		mocks.secretFindMany.mockResolvedValue([]);
	});

	afterEach(async () => {
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it('lists config scoped to an organization and masks secrets', async () => {
		mocks.secretFindMany.mockResolvedValue([
			{ id: 's1', projectId: 'p1', organizationId: 'org1', name: 'linear_api_key' }
		]);

		const result = await listProjectAgentConfigForOrg('org1', 'p1');

		expect(mocks.projectFindFirst).toHaveBeenCalledWith({
			where: { id: 'p1', organizationId: 'org1' },
			select: { id: true }
		});
		expect(result.secrets).toEqual([{ id: 's1', name: 'linear_api_key', hasValue: true }]);
	});

	it('returns an empty runtime projection when config is disabled for the run', async () => {
		const result = await buildRunAgentConfig('org1', 'p1', {
			useProjectAgentConfig: false
		});
		expect(result.mcpJson).toEqual({ mcpServers: {} });
		expect(result.secretEnv).toEqual({});
		expect(result.snapshot).toEqual({ enabled: false, mcpServers: [], skills: [] });
	});

	it('builds a runtime projection with decrypted secret env and non-secret snapshot', async () => {
		mocks.mcpFindMany.mockResolvedValue([
			{
				id: 'm1',
				name: 'linear',
				transport: 'http',
				enabled: true,
				config: { url: 'https://mcp.linear.app/mcp', headers: { 'x-public': 'yes' } },
				env: { LINEAR_API_KEY: { secretName: 'linear_api_key' } }
			}
		]);
		mocks.skillFindMany.mockResolvedValue([
			{
				id: 'sk1',
				name: 'review',
				description: 'Review changes',
				body: '---\nname: review\ndescription: Review changes\n---\n\nReview changes.',
				enabled: true
			}
		]);
		mocks.secretFindMany.mockResolvedValue([
			{
				id: 's1',
				name: 'linear_api_key',
				valueEncrypted: encryptProjectSecretValue('lin_123')
			}
		]);

		const result = await buildRunAgentConfig('org1', 'p1', {
			useProjectAgentConfig: true
		});

		expect(result.mcpJson.mcpServers.linear).toEqual({
			type: 'http',
			url: 'https://mcp.linear.app/mcp',
			headers: { 'x-public': 'yes' },
			env: { LINEAR_API_KEY: 'lin_123' }
		});
		expect(result.secretEnv).toEqual({ LINEAR_API_KEY: 'lin_123' });
		expect(JSON.stringify(result.snapshot)).not.toContain('lin_123');
		expect(result.settings.enabledMcpjsonServers).toEqual(['linear']);
		expect(result.skills).toHaveLength(1);
	});

	it('fails closed when a referenced secret is missing', async () => {
		mocks.mcpFindMany.mockResolvedValue([
			{
				id: 'm1',
				name: 'linear',
				transport: 'http',
				enabled: true,
				config: { url: 'https://mcp.linear.app/mcp', headers: {} },
				env: { LINEAR_API_KEY: { secretName: 'linear_api_key' } }
			}
		]);

		await expect(
			buildRunAgentConfig('org1', 'p1', { useProjectAgentConfig: true })
		).rejects.toThrow(ProjectAgentConfigError);
	});

	it('materializes mcp settings and skills without writing secret values into files', async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'dw-agent-config-'));
		await materializeRunAgentConfig(tempDir, {
			mcpJson: {
				mcpServers: {
					linear: {
						type: 'http',
						url: 'https://mcp.linear.app/mcp',
						env: { LINEAR_API_KEY: 'lin_123' }
					}
				}
			},
			settings: { enabledMcpjsonServers: ['linear'] },
			skills: [
				{
					name: 'review',
					body: '---\nname: review\ndescription: Review changes\n---\n\nReview changes.'
				}
			],
			secretEnv: { LINEAR_API_KEY: 'lin_123' },
			snapshot: { enabled: true, mcpServers: [], skills: [] }
		});

		const mcpJson = await readFile(join(tempDir, '.mcp.json'), 'utf8');
		const settings = await readFile(join(tempDir, '.claude/settings.json'), 'utf8');
		const skill = await readFile(join(tempDir, '.claude/skills/review/SKILL.md'), 'utf8');

		expect(mcpJson).not.toContain('lin_123');
		expect(mcpJson).toContain('"LINEAR_API_KEY"');
		expect(settings).toContain('enabledMcpjsonServers');
		expect(skill).toContain('Review changes.');
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/project-agent-config-service.test.ts
```

Expected: FAIL because the service module does not exist.

- [ ] **Step 3: Implement service types and helpers**

Create `src/lib/server/project-agent-config-service.ts` with these exported types and helper functions:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prisma } from '$lib/server/prisma';
import {
	decryptProjectSecretValue,
	encryptProjectSecretValue
} from './project-agent-config-encryption';
import {
	normalizeSkillBody,
	type ProjectMcpServerInput,
	type ProjectSecretInput,
	type ProjectSkillInput
} from '$lib/schemas/project-agent-config';

export class ProjectAgentConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectAgentConfigError';
	}
}

type McpJsonServer = Record<string, unknown>;

export interface RuntimeAgentConfig {
	mcpJson: { mcpServers: Record<string, McpJsonServer> };
	settings: { enabledMcpjsonServers: string[] };
	skills: Array<{ name: string; body: string }>;
	secretEnv: Record<string, string>;
	snapshot: {
		enabled: boolean;
		mcpServers: Array<{ id: string; name: string; transport: string }>;
		skills: Array<{ id: string; name: string }>;
	};
}

async function requireProjectInOrg(organizationId: string, projectId: string) {
	const project = await prisma.project.findFirst({
		where: { id: projectId, organizationId },
		select: { id: true }
	});
	if (!project) throw new ProjectAgentConfigError('Project not found');
	return project;
}

function assertSafeName(name: string) {
	if (name === 'dotweaver' || name.includes('/') || name.includes('..')) {
		throw new ProjectAgentConfigError(`Invalid agent config name: ${name}`);
	}
}
```

- [ ] **Step 4: Implement list and upsert functions**

Add to `src/lib/server/project-agent-config-service.ts`:

```ts
export async function listProjectAgentConfigForOrg(organizationId: string, projectId: string) {
	await requireProjectInOrg(organizationId, projectId);
	const [mcpServers, skills, secrets] = await Promise.all([
		prisma.projectMcpServer.findMany({
			where: { organizationId, projectId },
			orderBy: { name: 'asc' }
		}),
		prisma.projectSkill.findMany({
			where: { organizationId, projectId },
			orderBy: { name: 'asc' }
		}),
		prisma.projectSecret.findMany({
			where: { organizationId, projectId },
			orderBy: { name: 'asc' },
			select: { id: true, name: true }
		})
	]);

	return {
		mcpServers,
		skills,
		secrets: secrets.map((secret) => ({
			id: secret.id,
			name: secret.name,
			hasValue: true
		}))
	};
}

export async function upsertProjectMcpServerForOrg(
	organizationId: string,
	input: ProjectMcpServerInput
) {
	await requireProjectInOrg(organizationId, input.projectId);
	assertSafeName(input.name);
	const config =
		input.transport === 'stdio'
			? { command: input.command, args: input.args }
			: { url: input.url, headers: input.headers };
	return prisma.projectMcpServer.upsert({
		where: { projectId_name: { projectId: input.projectId, name: input.name } },
		create: {
			projectId: input.projectId,
			organizationId,
			name: input.name,
			transport: input.transport,
			enabled: input.enabled,
			config,
			env: input.env
		},
		update: {
			transport: input.transport,
			enabled: input.enabled,
			config,
			env: input.env
		}
	});
}

export async function upsertProjectSkillForOrg(organizationId: string, input: ProjectSkillInput) {
	await requireProjectInOrg(organizationId, input.projectId);
	assertSafeName(input.name);
	const body = normalizeSkillBody({
		name: input.name,
		description: input.description,
		body: input.body
	});
	return prisma.projectSkill.upsert({
		where: { projectId_name: { projectId: input.projectId, name: input.name } },
		create: {
			projectId: input.projectId,
			organizationId,
			name: input.name,
			enabled: input.enabled,
			description: input.description,
			body,
			source: 'manual'
		},
		update: {
			enabled: input.enabled,
			description: input.description,
			body
		}
	});
}

export async function upsertProjectSecretForOrg(
	organizationId: string,
	createdById: string,
	input: ProjectSecretInput
) {
	await requireProjectInOrg(organizationId, input.projectId);
	assertSafeName(input.name);
	return prisma.projectSecret.upsert({
		where: { projectId_name: { projectId: input.projectId, name: input.name } },
		create: {
			projectId: input.projectId,
			organizationId,
			name: input.name,
			valueEncrypted: encryptProjectSecretValue(input.value),
			createdById
		},
		update: {
			valueEncrypted: encryptProjectSecretValue(input.value)
		}
	});
}
```

- [ ] **Step 5: Implement runtime projection**

Add to `src/lib/server/project-agent-config-service.ts`:

```ts
function envPlaceholders(envRefs: unknown): Record<string, string> {
	return Object.fromEntries(
		Object.keys((envRefs as Record<string, unknown>) ?? {}).map((key) => [key, `$${key}`])
	);
}

function buildMcpJsonServer(server: {
	transport: string;
	config: unknown;
	env: unknown;
	name: string;
}): McpJsonServer {
	const config = server.config as Record<string, unknown>;
	if (server.transport === 'stdio') {
		return {
			type: 'stdio',
			command: config.command,
			args: config.args,
			env: envPlaceholders(server.env)
		};
	}
	return {
		type: server.transport,
		url: config.url,
		headers: config.headers ?? {},
		env: envPlaceholders(server.env)
	};
}

export async function buildRunAgentConfig(
	organizationId: string,
	projectId: string,
	options: { useProjectAgentConfig: boolean }
): Promise<RuntimeAgentConfig> {
	if (!options.useProjectAgentConfig) {
		return {
			mcpJson: { mcpServers: {} },
			settings: { enabledMcpjsonServers: [] },
			skills: [],
			secretEnv: {},
			snapshot: { enabled: false, mcpServers: [], skills: [] }
		};
	}

	await requireProjectInOrg(organizationId, projectId);
	const [mcpServers, skills, secrets] = await Promise.all([
		prisma.projectMcpServer.findMany({ where: { organizationId, projectId, enabled: true } }),
		prisma.projectSkill.findMany({ where: { organizationId, projectId, enabled: true } }),
		prisma.projectSecret.findMany({ where: { organizationId, projectId } })
	]);
	const secretByName = new Map(secrets.map((secret) => [secret.name, secret]));
	const secretEnv: Record<string, string> = {};

	for (const server of mcpServers) {
		const envRefs = server.env as Record<string, { secretName: string }>;
		for (const [envName, ref] of Object.entries(envRefs ?? {})) {
			const secret = secretByName.get(ref.secretName);
			if (!secret) {
				throw new ProjectAgentConfigError(
					`MCP \`${server.name}\` references missing secret \`${ref.secretName}\``
				);
			}
			secretEnv[envName] = decryptProjectSecretValue(secret.valueEncrypted);
		}
	}

	const mcpJson = {
		mcpServers: Object.fromEntries(
			mcpServers.map((server) => [server.name, buildMcpJsonServer(server)])
		)
	};
	return {
		mcpJson,
		settings: { enabledMcpjsonServers: mcpServers.map((server) => server.name) },
		skills: skills.map((skill) => ({ name: skill.name, body: skill.body })),
		secretEnv,
		snapshot: {
			enabled: true,
			mcpServers: mcpServers.map((server) => ({
				id: server.id,
				name: server.name,
				transport: server.transport
			})),
			skills: skills.map((skill) => ({ id: skill.id, name: skill.name }))
		}
	};
}
```

- [ ] **Step 6: Implement file materialization**

Add to `src/lib/server/project-agent-config-service.ts`:

```ts
function scrubMcpJsonSecrets(config: RuntimeAgentConfig['mcpJson']): RuntimeAgentConfig['mcpJson'] {
	return {
		mcpServers: Object.fromEntries(
			Object.entries(config.mcpServers).map(([name, server]) => {
				const copy = { ...server };
				if ('env' in copy) {
					const envObject = copy.env as Record<string, unknown>;
					copy.env = Object.fromEntries(Object.keys(envObject).map((key) => [key, `$${key}`]));
				}
				return [name, copy];
			})
		)
	};
}

export async function materializeRunAgentConfig(
	checkoutPath: string,
	config: RuntimeAgentConfig
): Promise<void> {
	const claudeDir = join(checkoutPath, '.claude');
	await mkdir(claudeDir, { recursive: true });
	await writeFile(
		join(checkoutPath, '.mcp.json'),
		`${JSON.stringify(scrubMcpJsonSecrets(config.mcpJson), null, 2)}\n`
	);
	await writeFile(
		join(claudeDir, 'settings.json'),
		`${JSON.stringify(config.settings, null, 2)}\n`
	);
	for (const skill of config.skills) {
		assertSafeName(skill.name);
		const skillDir = join(claudeDir, 'skills', skill.name);
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			join(skillDir, 'SKILL.md'),
			skill.body.endsWith('\n') ? skill.body : `${skill.body}\n`
		);
	}
}
```

- [ ] **Step 7: Run service tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/project-agent-config-service.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/server/project-agent-config-service.ts tests/unit/lib/server/project-agent-config-service.test.ts
git commit -m "feat(agent): project agent config service"
```

---

### Task 5: Start Run Integration

**Files:**

- Modify: `src/lib/rfc/runs.remote.ts`
- Modify: `tests/unit/lib/schemas/runs.test.ts`

- [ ] **Step 1: Add run schema assertions**

Extend `tests/unit/lib/schemas/runs.test.ts`:

```ts
it('defaults useProjectAgentConfig to true', () => {
	const parsed = startRunSchema.parse({ projectId: 'p1', prompt: 'go' });
	expect(parsed.useProjectAgentConfig).toBe(true);
});
```

- [ ] **Step 2: Update `startRun` to persist the flag and validate config**

Modify imports in `src/lib/rfc/runs.remote.ts`:

```ts
import {
	buildRunAgentConfig,
	ProjectAgentConfigError
} from '$lib/server/project-agent-config-service';
```

Modify the command signature:

```ts
export const startRun = command(
	startRunSchema,
	async ({ projectId, prompt, model, useProjectAgentConfig }) => {
```

After the project lookup and before `crypto.randomUUID()`:

```ts
if (useProjectAgentConfig) {
	try {
		await buildRunAgentConfig(organizationId, projectId, { useProjectAgentConfig: true });
	} catch (e) {
		if (e instanceof ProjectAgentConfigError) error(400, e.message);
		throw e;
	}
}
```

Add the field to `prisma.run.create`:

```ts
				useProjectAgentConfig,
```

Close the extra wrapper at the end of the command.

- [ ] **Step 3: Run checks**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/schemas/runs.test.ts
bun run check
```

Expected: both commands pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/rfc/runs.remote.ts tests/unit/lib/schemas/runs.test.ts
git commit -m "feat(runs): persist project agent config opt-out"
```

---

### Task 6: Orchestrator Runtime Projection

**Files:**

- Modify: `src/lib/server/run-orchestrator.ts`
- Modify: `tests/unit/lib/server/run-orchestrator.test.ts`

- [ ] **Step 1: Add failing orchestrator tests**

In `tests/unit/lib/server/run-orchestrator.test.ts`, extend `mocks`:

```ts
	buildRunAgentConfig: vi.fn(),
	materializeRunAgentConfig: vi.fn()
```

Add mock module:

```ts
vi.mock('$lib/server/project-agent-config-service', () => ({
	buildRunAgentConfig: mocks.buildRunAgentConfig,
	materializeRunAgentConfig: mocks.materializeRunAgentConfig
}));
```

Change `setupRun()` to accept overrides and add fields:

```ts
function setupRun(overrides: Record<string, unknown> = {}) {
	const row = {
		id: runId,
		projectId: 'p1',
		organizationId: 'org1',
		createdById: 'u1',
		prompt: 'do it',
		model: null,
		sessionId: null,
		timeoutAt: new Date(Date.now() + 60_000),
		useProjectAgentConfig: true,
		agentConfigSnapshot: null,
		project: {
			id: 'p1',
			cloneUrl: 'https://github.com/acme/repo.git',
			defaultBranch: 'main'
		},
		...overrides
	};
	mocks.runFindUnique.mockResolvedValue(row);
	mocks.runUpdateMany.mockResolvedValue({ count: 1 });
	mocks.getGithubTokenForUser.mockResolvedValue(null);
	mocks.ensureMirror.mockResolvedValue(undefined);
	mocks.createRunCheckout.mockResolvedValue({ checkoutPath: '/checkout', baseSha: 'base' });
	mocks.getHeadSha.mockResolvedValue('head');
	mocks.appendRunEvent.mockResolvedValue(undefined);
	mocks.cancelPendingRunInteractions.mockResolvedValue({ count: 1 });
}
```

In `beforeEach`, add:

```ts
mocks.buildRunAgentConfig.mockResolvedValue({
	mcpJson: { mcpServers: {} },
	settings: { enabledMcpjsonServers: [] },
	skills: [],
	secretEnv: {},
	snapshot: { enabled: true, mcpServers: [], skills: [] }
});
mocks.materializeRunAgentConfig.mockResolvedValue(undefined);
```

Add tests:

```ts
it('materializes project agent config before docker and injects secret env', async () => {
	setupRun();
	mocks.buildRunAgentConfig.mockResolvedValue({
		mcpJson: { mcpServers: {} },
		settings: { enabledMcpjsonServers: ['linear'] },
		skills: [],
		secretEnv: { LINEAR_API_KEY: 'lin_123' },
		snapshot: { enabled: true, mcpServers: [{ id: 'm1', name: 'linear' }], skills: [] }
	});
	mocks.runContainer.mockResolvedValue({ exitCode: 0, timedOut: false });

	await executeRun(runId);

	expect(mocks.buildRunAgentConfig).toHaveBeenCalledWith('org1', 'p1', {
		useProjectAgentConfig: true
	});
	expect(mocks.materializeRunAgentConfig).toHaveBeenCalledWith(
		'/checkout',
		expect.objectContaining({ secretEnv: { LINEAR_API_KEY: 'lin_123' } })
	);
	expect(mocks.buildRunArgs).toHaveBeenCalledWith(
		expect.objectContaining({
			env: expect.objectContaining({ LINEAR_API_KEY: 'lin_123' })
		})
	);
});

it('does not materialize config when the run opts out', async () => {
	setupRun({ useProjectAgentConfig: false });
	mocks.runContainer.mockResolvedValue({ exitCode: 0, timedOut: false });

	await executeRun(runId);

	expect(mocks.buildRunAgentConfig).toHaveBeenCalledWith('org1', 'p1', {
		useProjectAgentConfig: false
	});
});

it('fails before docker when agent config projection fails', async () => {
	setupRun();
	mocks.buildRunAgentConfig.mockRejectedValue(new Error('missing secret'));

	await executeRun(runId);

	expect(mocks.runContainer).not.toHaveBeenCalled();
	expectTransition(['queued', 'preparing', 'running', 'awaiting_input'], 'failed');
});
```

If the second test cannot call the mock result inside `mockResolvedValue`, create a local `baseRun` object in `setupRun()` and reuse it.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/run-orchestrator.test.ts
```

Expected: FAIL because the orchestrator does not call the project agent config service.

- [ ] **Step 3: Implement orchestrator integration**

Modify imports in `src/lib/server/run-orchestrator.ts`:

```ts
import {
	buildRunAgentConfig,
	materializeRunAgentConfig
} from '$lib/server/project-agent-config-service';
```

After the `createRunCheckout` call and before the transition to `RUNNING`:

```ts
const agentConfig = await buildRunAgentConfig(run.organizationId, project.id, {
	useProjectAgentConfig: run.useProjectAgentConfig
});
await materializeRunAgentConfig(checkoutPath, agentConfig);
```

When transitioning to `RUNNING`, also store the snapshot:

```ts
					agentConfigSnapshot: agentConfig.snapshot,
					baseCommitSha: baseSha
```

When building `env`, merge the secret env:

```ts
const env: Record<string, string> = {
	RUN_PROMPT: run.prompt,
	CLAUDE_CODE_OAUTH_TOKEN: privateEnv.CLAUDE_CODE_OAUTH_TOKEN ?? '',
	...agentConfig.secretEnv
};
```

- [ ] **Step 4: Run orchestrator tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/run-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/run-orchestrator.ts tests/unit/lib/server/run-orchestrator.test.ts
git commit -m "feat(runs): inject project agent config into runs"
```

---

### Task 7: Remote Functions for Agent Config

**Files:**

- Create: `src/lib/rfc/project-agent-config.remote.ts`

- [ ] **Step 1: Implement remote query and commands**

Create `src/lib/rfc/project-agent-config.remote.ts`:

```ts
import { query, command, getRequestEvent } from '$app/server';
import { z } from 'zod';
import { error } from '@sveltejs/kit';
import { requireHeaders } from '$lib/server/utils';
import { requireActiveOrg } from '$lib/server/org';
import {
	projectConfigEnabledSchema,
	projectConfigIdSchema,
	projectMcpServerInputSchema,
	projectSecretInputSchema,
	projectSkillInputSchema,
	importProjectMcpJsonSchema,
	importProjectSkillMarkdownSchema
} from '$lib/schemas/project-agent-config';
import {
	listProjectAgentConfigForOrg,
	upsertProjectMcpServerForOrg,
	upsertProjectSecretForOrg,
	upsertProjectSkillForOrg,
	ProjectAgentConfigError
} from '$lib/server/project-agent-config-service';
import { prisma } from '$lib/server/prisma';

export const getProjectAgentConfig = query(z.string(), async (projectId) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	try {
		return await listProjectAgentConfigForOrg(organizationId, projectId);
	} catch (e) {
		if (e instanceof ProjectAgentConfigError) error(404, e.message);
		throw e;
	}
});

export const upsertProjectMcpServer = command(projectMcpServerInputSchema, async (input) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	await upsertProjectMcpServerForOrg(organizationId, input);
	await getProjectAgentConfig(input.projectId).refresh();
	return { ok: true };
});

export const upsertProjectSkill = command(projectSkillInputSchema, async (input) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	await upsertProjectSkillForOrg(organizationId, input);
	await getProjectAgentConfig(input.projectId).refresh();
	return { ok: true };
});

export const upsertProjectSecret = command(projectSecretInputSchema, async (input) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const { locals } = getRequestEvent();
	await upsertProjectSecretForOrg(organizationId, locals.user!.id, input);
	await getProjectAgentConfig(input.projectId).refresh();
	return { ok: true };
});

export const deleteProjectMcpServer = command(projectConfigIdSchema, async ({ projectId, id }) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	await prisma.projectMcpServer.deleteMany({ where: { id, projectId, organizationId } });
	await getProjectAgentConfig(projectId).refresh();
	return { ok: true };
});

export const deleteProjectSkill = command(projectConfigIdSchema, async ({ projectId, id }) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	await prisma.projectSkill.deleteMany({ where: { id, projectId, organizationId } });
	await getProjectAgentConfig(projectId).refresh();
	return { ok: true };
});

export const deleteProjectSecret = command(projectConfigIdSchema, async ({ projectId, id }) => {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	await prisma.projectSecret.deleteMany({ where: { id, projectId, organizationId } });
	await getProjectAgentConfig(projectId).refresh();
	return { ok: true };
});

export const setProjectMcpServerEnabled = command(
	projectConfigEnabledSchema,
	async ({ projectId, id, enabled }) => {
		const headers = requireHeaders();
		const organizationId = await requireActiveOrg(headers);
		await prisma.projectMcpServer.updateMany({
			where: { id, projectId, organizationId },
			data: { enabled }
		});
		await getProjectAgentConfig(projectId).refresh();
		return { ok: true };
	}
);

export const setProjectSkillEnabled = command(
	projectConfigEnabledSchema,
	async ({ projectId, id, enabled }) => {
		const headers = requireHeaders();
		const organizationId = await requireActiveOrg(headers);
		await prisma.projectSkill.updateMany({
			where: { id, projectId, organizationId },
			data: { enabled }
		});
		await getProjectAgentConfig(projectId).refresh();
		return { ok: true };
	}
);
```

Add import command stubs that parse and create records:

```ts
export const importProjectMcpJson = command(
	importProjectMcpJsonSchema,
	async ({ projectId, json }) => {
		const parsed = JSON.parse(json) as { mcpServers?: Record<string, Record<string, unknown>> };
		const headers = requireHeaders();
		const organizationId = await requireActiveOrg(headers);
		for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
			const transport = String(server.type ?? 'http');
			if (transport === 'stdio') {
				await upsertProjectMcpServerForOrg(organizationId, {
					projectId,
					name,
					transport,
					enabled: true,
					command: String(server.command ?? ''),
					args: Array.isArray(server.args) ? server.args.map(String) : [],
					env: {}
				});
			} else {
				await upsertProjectMcpServerForOrg(organizationId, {
					projectId,
					name,
					transport: transport === 'sse' ? 'sse' : 'http',
					enabled: true,
					url: String(server.url ?? ''),
					headers: {},
					env: {}
				});
			}
		}
		await getProjectAgentConfig(projectId).refresh();
		return { ok: true };
	}
);

export const importProjectSkillMarkdown = command(
	importProjectSkillMarkdownSchema,
	async ({ projectId, name, markdown }) => {
		const headers = requireHeaders();
		const organizationId = await requireActiveOrg(headers);
		const skillName = name ?? 'imported-skill';
		await upsertProjectSkillForOrg(organizationId, {
			projectId,
			name: skillName,
			description: `Imported skill ${skillName}`,
			body: markdown,
			enabled: true
		});
		await getProjectAgentConfig(projectId).refresh();
		return { ok: true };
	}
);
```

If `JSON.parse` errors, catch it and call `error(400, 'Invalid .mcp.json')`.

- [ ] **Step 2: Run checks**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/rfc/project-agent-config.remote.ts
git commit -m "feat(agent): expose project agent config remotes"
```

---

### Task 8: Project Agent Config UI

**Files:**

- Modify: `src/routes/(app)/projects/[id]/+page.svelte`
- Create: `src/lib/components/projects/AgentConfigPanel.svelte`
- Create: `src/lib/components/projects/McpServerEditor.svelte`
- Create: `src/lib/components/projects/SkillEditor.svelte`
- Create: `src/lib/components/projects/SecretEditor.svelte`

- [ ] **Step 1: Create editor components**

Create `src/lib/components/projects/McpServerEditor.svelte`:

```svelte
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';

	type Transport = 'http' | 'sse' | 'stdio';

	let { projectId, onSave }: { projectId: string; onSave: (input: unknown) => Promise<void> } =
		$props();

	let name = $state('');
	let transport = $state<Transport>('http');
	let url = $state('');
	let command = $state('');
	let args = $state('');
	let envName = $state('');
	let secretName = $state('');
	let error = $state<string | null>(null);
	let saving = $state(false);

	async function save() {
		error = null;
		saving = true;
		try {
			const env = envName && secretName ? { [envName]: { secretName } } : {};
			await onSave(
				transport === 'stdio'
					? {
							projectId,
							name,
							transport,
							command,
							args: args.split(' ').filter(Boolean),
							env,
							enabled: true
						}
					: { projectId, name, transport, url, headers: {}, env, enabled: true }
			);
			name = '';
			url = '';
			command = '';
			args = '';
			envName = '';
			secretName = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save MCP server';
		} finally {
			saving = false;
		}
	}
</script>

<form
	class="space-y-3"
	onsubmit={(e) => {
		e.preventDefault();
		void save();
	}}
>
	{#if error}<p class="text-sm text-red-500">{error}</p>{/if}
	<div class="grid gap-2 md:grid-cols-2">
		<Label>
			Name
			<Input bind:value={name} placeholder="linear" />
		</Label>
		<Label>
			Transport
			<Select.Root
				type="single"
				value={transport}
				onValueChange={(v) => (transport = (v as Transport) ?? 'http')}
			>
				<Select.Trigger>{transport}</Select.Trigger>
				<Select.Content>
					<Select.Item value="http" label="http" />
					<Select.Item value="sse" label="sse" />
					<Select.Item value="stdio" label="stdio" />
				</Select.Content>
			</Select.Root>
		</Label>
	</div>

	{#if transport === 'stdio'}
		<Label>
			Command
			<Input bind:value={command} placeholder="node" />
		</Label>
		<Label>
			Args
			<Input bind:value={args} placeholder="server.mjs --flag" />
		</Label>
	{:else}
		<Label>
			URL
			<Input bind:value={url} placeholder="https://example.com/mcp" />
		</Label>
	{/if}

	<div class="grid gap-2 md:grid-cols-2">
		<Label>
			Env name
			<Input bind:value={envName} placeholder="LINEAR_API_KEY" />
		</Label>
		<Label>
			Secret name
			<Input bind:value={secretName} placeholder="linear_api_key" />
		</Label>
	</div>

	<Button type="submit" disabled={saving || !name.trim()}>{saving ? 'Saving' : 'Add MCP'}</Button>
</form>
```

Create `src/lib/components/projects/SkillEditor.svelte`:

```svelte
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';

	let { projectId, onSave }: { projectId: string; onSave: (input: unknown) => Promise<void> } =
		$props();
	let name = $state('');
	let description = $state('');
	let body = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);

	async function save() {
		error = null;
		saving = true;
		try {
			await onSave({ projectId, name, description, body, enabled: true });
			name = '';
			description = '';
			body = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save skill';
		} finally {
			saving = false;
		}
	}
</script>

<form
	class="space-y-3"
	onsubmit={(e) => {
		e.preventDefault();
		void save();
	}}
>
	{#if error}<p class="text-sm text-red-500">{error}</p>{/if}
	<Label>
		Name
		<Input bind:value={name} placeholder="review" />
	</Label>
	<Label>
		Description
		<Input bind:value={description} placeholder="Review code changes" />
	</Label>
	<Label>
		SKILL.md
		<textarea
			bind:value={body}
			rows="7"
			class="w-full rounded-md border border-input bg-transparent p-2 text-sm"
		></textarea>
	</Label>
	<Button type="submit" disabled={saving || !name.trim() || !description.trim() || !body.trim()}>
		{saving ? 'Saving' : 'Add skill'}
	</Button>
</form>
```

Create `src/lib/components/projects/SecretEditor.svelte`:

```svelte
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';

	let { projectId, onSave }: { projectId: string; onSave: (input: unknown) => Promise<void> } =
		$props();
	let name = $state('');
	let value = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);

	async function save() {
		error = null;
		saving = true;
		try {
			await onSave({ projectId, name, value });
			name = '';
			value = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save secret';
		} finally {
			saving = false;
		}
	}
</script>

<form
	class="space-y-3"
	onsubmit={(e) => {
		e.preventDefault();
		void save();
	}}
>
	{#if error}<p class="text-sm text-red-500">{error}</p>{/if}
	<Label>
		Name
		<Input bind:value={name} placeholder="linear_api_key" />
	</Label>
	<Label>
		Value
		<Input bind:value type="password" placeholder="Stored encrypted" />
	</Label>
	<Button type="submit" disabled={saving || !name.trim() || !value}>
		{saving ? 'Saving' : 'Save secret'}
	</Button>
</form>
```

- [ ] **Step 2: Create `AgentConfigPanel.svelte`**

Create `src/lib/components/projects/AgentConfigPanel.svelte`:

```svelte
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import McpServerEditor from './McpServerEditor.svelte';
	import SkillEditor from './SkillEditor.svelte';
	import SecretEditor from './SecretEditor.svelte';
	import {
		deleteProjectMcpServer,
		deleteProjectSecret,
		deleteProjectSkill,
		setProjectMcpServerEnabled,
		setProjectSkillEnabled,
		upsertProjectMcpServer,
		upsertProjectSecret,
		upsertProjectSkill
	} from '$lib/rfc/project-agent-config.remote';

	type AgentConfig = {
		mcpServers: Array<{ id: string; name: string; transport: string; enabled: boolean }>;
		skills: Array<{ id: string; name: string; description: string; enabled: boolean }>;
		secrets: Array<{ id: string; name: string; hasValue: boolean }>;
	};

	let { projectId, config }: { projectId: string; config: AgentConfig } = $props();
	let section = $state<'mcp' | 'skills' | 'secrets'>('mcp');
</script>

<section class="space-y-3">
	<div class="flex items-center justify-between">
		<h2 class="text-lg font-medium">Agent config</h2>
		<div class="flex gap-2">
			<Button variant={section === 'mcp' ? 'default' : 'outline'} onclick={() => (section = 'mcp')}
				>MCP</Button
			>
			<Button
				variant={section === 'skills' ? 'default' : 'outline'}
				onclick={() => (section = 'skills')}>Skills</Button
			>
			<Button
				variant={section === 'secrets' ? 'default' : 'outline'}
				onclick={() => (section = 'secrets')}>Secrets</Button
			>
		</div>
	</div>

	{#if section === 'mcp'}
		<Card.Root>
			<Card.Header><Card.Title>MCP servers</Card.Title></Card.Header>
			<Card.Content class="space-y-4">
				<ul class="divide-y">
					{#each config.mcpServers as server (server.id)}
						<li class="flex items-center justify-between py-2 text-sm">
							<span
								>{server.name} <span class="text-muted-foreground">{server.transport}</span></span
							>
							<span class="flex gap-2">
								<Button
									variant="outline"
									onclick={() =>
										setProjectMcpServerEnabled({
											projectId,
											id: server.id,
											enabled: !server.enabled
										})}
								>
									{server.enabled ? 'Disable' : 'Enable'}
								</Button>
								<Button
									variant="outline"
									onclick={() => deleteProjectMcpServer({ projectId, id: server.id })}
									>Delete</Button
								>
							</span>
						</li>
					{/each}
				</ul>
				<McpServerEditor {projectId} onSave={upsertProjectMcpServer} />
			</Card.Content>
		</Card.Root>
	{:else if section === 'skills'}
		<Card.Root>
			<Card.Header><Card.Title>Skills</Card.Title></Card.Header>
			<Card.Content class="space-y-4">
				<ul class="divide-y">
					{#each config.skills as skill (skill.id)}
						<li class="flex items-center justify-between py-2 text-sm">
							<span
								>{skill.name} <span class="text-muted-foreground">{skill.description}</span></span
							>
							<span class="flex gap-2">
								<Button
									variant="outline"
									onclick={() =>
										setProjectSkillEnabled({ projectId, id: skill.id, enabled: !skill.enabled })}
								>
									{skill.enabled ? 'Disable' : 'Enable'}
								</Button>
								<Button
									variant="outline"
									onclick={() => deleteProjectSkill({ projectId, id: skill.id })}>Delete</Button
								>
							</span>
						</li>
					{/each}
				</ul>
				<SkillEditor {projectId} onSave={upsertProjectSkill} />
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root>
			<Card.Header><Card.Title>Secrets</Card.Title></Card.Header>
			<Card.Content class="space-y-4">
				<ul class="divide-y">
					{#each config.secrets as secret (secret.id)}
						<li class="flex items-center justify-between py-2 text-sm">
							<span>{secret.name}</span>
							<Button
								variant="outline"
								onclick={() => deleteProjectSecret({ projectId, id: secret.id })}>Delete</Button
							>
						</li>
					{/each}
				</ul>
				<SecretEditor {projectId} onSave={upsertProjectSecret} />
			</Card.Content>
		</Card.Root>
	{/if}
</section>
```

- [ ] **Step 3: Wire page project**

Modify `src/routes/(app)/projects/[id]/+page.svelte` imports:

```svelte
import {getProjectAgentConfig} from '$lib/rfc/project-agent-config.remote'; import AgentConfigPanel from
'$lib/components/projects/AgentConfigPanel.svelte';
```

Add query and state:

```svelte
const agentConfig = $derived(getProjectAgentConfig(page.params.id!)); let useProjectAgentConfig =
$state(true);
```

Change `handleStart`:

```ts
await startRun({
	projectId: page.params.id!,
	prompt,
	model: model || undefined,
	useProjectAgentConfig
});
```

Render panel after the repo metadata:

```svelte
		{#if agentConfig.error}
			<p class="text-sm text-red-500">{agentConfig.error.message}</p>
		{:else if agentConfig.current}
			<AgentConfigPanel projectId={page.params.id!} config={agentConfig.current} />
		{/if}
```

Add toggle near the model select:

```svelte
<label class="flex items-center gap-2 text-sm">
	<input type="checkbox" bind:checked={useProjectAgentConfig} />
	Use project agent config
</label>
```

- [ ] **Step 4: Run Svelte autofixer**

Use the Svelte MCP `svelte-autofixer` on each new or modified Svelte component:

- `src/routes/(app)/projects/[id]/+page.svelte`
- `AgentConfigPanel.svelte`
- `McpServerEditor.svelte`
- `SkillEditor.svelte`
- `SecretEditor.svelte`

Expected: repeat fixes until the autofixer returns no issues or suggestions.

- [ ] **Step 5: Run checks**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/routes/(app)/projects/[id]/+page.svelte" src/lib/components/projects/AgentConfigPanel.svelte src/lib/components/projects/McpServerEditor.svelte src/lib/components/projects/SkillEditor.svelte src/lib/components/projects/SecretEditor.svelte
git commit -m "feat(agent): add project agent config UI"
```

---

### Task 9: Full Verification

**Files:**

- No new files.

- [ ] **Step 1: Run targeted unit tests**

Run:

```bash
bun run test:unit -- --run tests/unit/lib/schemas/project-agent-config.test.ts tests/unit/lib/schemas/runs.test.ts tests/unit/lib/server/project-agent-config-encryption.test.ts tests/unit/lib/server/project-agent-config-service.test.ts tests/unit/lib/server/run-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run all unit tests**

Run:

```bash
bun run test:unit -- --run
```

Expected: PASS.

- [ ] **Step 3: Run SvelteKit check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 4: Manual smoke test**

Run:

```bash
bun run dev
```

In the browser:

1. Open a project page.
2. Add secret `linear_api_key`.
3. Add HTTP MCP `linear` with env `LINEAR_API_KEY -> linear_api_key`.
4. Add skill `review` with a minimal `SKILL.md`.
5. Start a run with `Use project agent config` enabled.
6. Confirm the run starts and does not expose the secret in events.
7. Start another run with the checkbox disabled and confirm it still starts.

Expected: both runs enqueue; enabled run materializes config; disabled run skips project config.

- [ ] **Step 5: Confirm clean status**

Run:

```bash
git status --short
```

Expected: no unstaged or uncommitted files unless the implementation deliberately continues into
another task.

---

## Self-Review

Spec coverage:

- Per-project MCP, skills, secrets: Tasks 1, 2, 4, 7, 8.
- Secrets encrypted and masked: Tasks 3, 4.
- Runtime projection into checkout: Tasks 4, 6.
- Default activation with run opt-out: Tasks 1, 5, 6, 8.
- Remote + stdio MCP support: Tasks 1, 4, 8.
- Svelte remote functions and UI: Tasks 7, 8.
- Tests and verification: Tasks 1 through 9.

Placeholder scan:

- No task relies on unnamed files.
- No step asks for unspecified validation or generic error handling.
- Code snippets define concrete function and schema names used by later tasks.

Type consistency:

- Schema names match remote function imports.
- Service function names match orchestrator and remote imports.
- Prisma model names match mocked Prisma delegates.
