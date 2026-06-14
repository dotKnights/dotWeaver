# Project `.env` Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project define encrypted `.env` variables that are merged into a `.env` file at the checkout root at run time, never committed or pushed.

**Architecture:** A new `ProjectEnvVar` model (encrypted values, reusing the existing AES-256-GCM secret encryption) sits alongside MCP/Skills/Secrets in the project agent config. A small isolated `dotenv` module parses and merges `.env` text. `buildRunAgentConfig` loads enabled vars into a new `envFile` field; `materializeRunAgentConfig` merges them into the checkout `.env` and reuses the existing git-exclude + `skip-worktree` protection so the file never leaks into the run diff/PR.

**Tech Stack:** SvelteKit (Svelte 5 runes), TypeScript, Prisma, Zod, Vitest, bun.

---

## File Structure

- Create: `src/lib/server/dotenv.ts` — `parseDotenv` + `mergeDotenv` (pure, isolated).
- Create: `src/lib/components/projects/EnvVarEditor.svelte` — add/edit form.
- Modify: `prisma/schema.prisma` — `ProjectEnvVar` model + relations.
- Create: `prisma/migrations/<ts>_add_project_env_var/migration.sql` (via prisma migrate).
- Modify: `src/lib/schemas/project-agent-config.ts` — env var schemas.
- Modify: `src/lib/server/project-agent-config-service.ts` — projection, CRUD, build, materialize.
- Modify: `src/lib/rfc/project-agent-config.remote.ts` — remote commands.
- Modify: `src/lib/components/projects/AgentConfigPanel.svelte` — env section + import.
- Tests: `tests/unit/lib/server/dotenv.test.ts`, and additions to
  `tests/unit/lib/schemas/project-agent-config.test.ts`,
  `tests/unit/lib/server/project-agent-config-service.test.ts`,
  `tests/unit/lib/rfc/project-agent-config.remote.test.ts`,
  `tests/unit/lib/server/run-orchestrator.test.ts`.

**Run all unit tests with:** `bun run test:unit -- --run`
**Run a single file with:** `bun run test:unit -- --run tests/unit/lib/server/dotenv.test.ts`

(Confirm the script name first with `cat package.json`; if it differs, use `bunx vitest run <file>`.)

---

## Task 1: dotenv parse + merge module

**Files:**
- Create: `src/lib/server/dotenv.ts`
- Test: `tests/unit/lib/server/dotenv.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lib/server/dotenv.test.ts
import { describe, expect, it } from 'vitest';
import { parseDotenv, mergeDotenv } from '$lib/server/dotenv';

describe('parseDotenv', () => {
	it('parses simple key=value pairs', () => {
		expect(parseDotenv('FOO=bar\nBAZ=qux')).toEqual([
			{ key: 'FOO', value: 'bar' },
			{ key: 'BAZ', value: 'qux' }
		]);
	});

	it('ignores blank lines and # comments', () => {
		expect(parseDotenv('\n# a comment\nFOO=bar\n')).toEqual([{ key: 'FOO', value: 'bar' }]);
	});

	it('strips the export prefix', () => {
		expect(parseDotenv('export FOO=bar')).toEqual([{ key: 'FOO', value: 'bar' }]);
	});

	it('strips surrounding single and double quotes', () => {
		expect(parseDotenv('A="one"\nB=\'two\'')).toEqual([
			{ key: 'A', value: 'one' },
			{ key: 'B', value: 'two' }
		]);
	});

	it('keeps the full value when it contains = signs', () => {
		expect(parseDotenv('URL=postgres://u:p@h/db?x=1')).toEqual([
			{ key: 'URL', value: 'postgres://u:p@h/db?x=1' }
		]);
	});

	it('skips lines with invalid keys', () => {
		expect(parseDotenv('1BAD=x\nGOOD=y')).toEqual([{ key: 'GOOD', value: 'y' }]);
	});
});

describe('mergeDotenv', () => {
	it('replaces an existing managed key in place', () => {
		expect(mergeDotenv('FOO=old\nBAR=keep', [{ key: 'FOO', value: 'new' }])).toBe(
			'FOO=new\nBAR=keep\n'
		);
	});

	it('appends new keys under a managed block', () => {
		expect(mergeDotenv('BAR=keep', [{ key: 'FOO', value: 'new' }])).toBe(
			'BAR=keep\n\n# dotWeaver managed\nFOO=new\n'
		);
	});

	it('quotes values that contain spaces or #', () => {
		expect(mergeDotenv('', [{ key: 'A', value: 'two words' }])).toBe(
			'\n# dotWeaver managed\nA="two words"\n'
		);
	});

	it('returns only the managed block when there is no existing content', () => {
		expect(mergeDotenv('', [{ key: 'A', value: 'b' }])).toBe('\n# dotWeaver managed\nA=b\n');
	});

	it('preserves comments and unmanaged lines', () => {
		expect(mergeDotenv('# header\nKEEP=1\n', [{ key: 'NEW', value: '2' }])).toBe(
			'# header\nKEEP=1\n\n# dotWeaver managed\nNEW=2\n'
		);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- --run tests/unit/lib/server/dotenv.test.ts`
Expected: FAIL — cannot resolve `$lib/server/dotenv`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/server/dotenv.ts
export interface DotenvEntry {
	key: string;
	value: string;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function unquote(raw: string): string {
	const v = raw.trim();
	if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
		return v.slice(1, -1);
	}
	return v;
}

/** Parse `.env` text into entries. Invalid keys, blank lines and `#` comments are dropped. */
export function parseDotenv(text: string): DotenvEntry[] {
	const entries: DotenvEntry[] = [];
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith('#')) continue;
		const withoutExport = line.startsWith('export ') ? line.slice('export '.length) : line;
		const eq = withoutExport.indexOf('=');
		if (eq === -1) continue;
		const key = withoutExport.slice(0, eq).trim();
		if (!KEY_RE.test(key)) continue;
		entries.push({ key, value: unquote(withoutExport.slice(eq + 1)) });
	}
	return entries;
}

function serializeValue(value: string): string {
	return /[\s#"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/**
 * Merge managed entries into existing `.env` text. Managed keys present in the
 * file are replaced in place; missing keys are appended under a managed block.
 * Comments and unmanaged lines are preserved. Always returns text ending in `\n`.
 */
export function mergeDotenv(existing: string, managed: DotenvEntry[]): string {
	const byKey = new Map(managed.map((entry) => [entry.key, entry.value]));
	const seen = new Set<string>();
	const lines = existing.length === 0 ? [] : existing.replace(/\n+$/, '').split('\n');
	const out = lines.map((line) => {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith('#')) return line;
		const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed;
		const eq = body.indexOf('=');
		if (eq === -1) return line;
		const key = body.slice(0, eq).trim();
		if (!byKey.has(key)) return line;
		seen.add(key);
		return `${key}=${serializeValue(byKey.get(key)!)}`;
	});

	const appended = managed.filter((entry) => !seen.has(entry.key));
	if (appended.length > 0) {
		out.push('', '# dotWeaver managed');
		for (const entry of appended) out.push(`${entry.key}=${serializeValue(entry.value)}`);
	}
	return `${out.join('\n')}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- --run tests/unit/lib/server/dotenv.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/dotenv.ts tests/unit/lib/server/dotenv.test.ts
git commit -m "feat(env): add dotenv parse and merge module"
```

---

## Task 2: Prisma model + migration

**Files:**
- Modify: `prisma/schema.prisma` (Project model ~line 187, User model ~line 25, add new model after `ProjectSecret` ~line 268)

- [ ] **Step 1: Add the relation to `Project`**

In `model Project`, after `secrets ProjectSecret[]` (line 187) add:

```prisma
  envVars        ProjectEnvVar[]
```

- [ ] **Step 2: Add the relation to `User`**

In `model User`, next to the existing `projectSecrets ProjectSecret[]` (line 25) add:

```prisma
  projectEnvVars ProjectEnvVar[]
```

- [ ] **Step 3: Add the model**

After `model ProjectSecret { ... }` (ends ~line 268) add:

```prisma
model ProjectEnvVar {
  id             String   @id @default(cuid())
  projectId      String
  project        Project  @relation(fields: [projectId, organizationId], references: [id, organizationId], onDelete: Cascade)
  organizationId String
  key            String
  valueEncrypted String
  sensitive      Boolean  @default(true)
  enabled        Boolean  @default(true)
  createdById    String
  createdBy      User     @relation(fields: [createdById], references: [id], onDelete: Cascade)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @default(now()) @updatedAt

  @@unique([projectId, key])
  @@index([organizationId, projectId])
  @@map("project_env_var")
}
```

- [ ] **Step 4: Generate the migration + client**

Run: `bunx prisma migrate dev --name add_project_env_var`
Expected: a new folder `prisma/migrations/<ts>_add_project_env_var/migration.sql` and a regenerated client. (If the dev DB is unavailable, use `bunx prisma migrate diff` to author the SQL and `bunx prisma generate`.)

- [ ] **Step 5: Verify types compile**

Run: `bunx tsc --noEmit`
Expected: no errors referencing `ProjectEnvVar`.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(env): add ProjectEnvVar prisma model"
```

---

## Task 3: Schemas

**Files:**
- Modify: `src/lib/schemas/project-agent-config.ts` (add after `projectSecretInputSchema` ~line 121)
- Test: `tests/unit/lib/schemas/project-agent-config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/lib/schemas/project-agent-config.test.ts`:

```ts
import {
	envVarKeySchema,
	projectEnvVarInputSchema,
	importProjectEnvFileSchema
} from '$lib/schemas/project-agent-config';

describe('envVarKeySchema', () => {
	it('accepts POSIX-style names', () => {
		expect(envVarKeySchema.safeParse('DATABASE_URL').success).toBe(true);
		expect(envVarKeySchema.safeParse('_x9').success).toBe(true);
	});
	it('rejects names starting with a digit or with dashes', () => {
		expect(envVarKeySchema.safeParse('9X').success).toBe(false);
		expect(envVarKeySchema.safeParse('A-B').success).toBe(false);
	});
});

describe('projectEnvVarInputSchema', () => {
	it('accepts a valid input', () => {
		const parsed = projectEnvVarInputSchema.parse({
			projectId: 'p1',
			key: 'API_KEY',
			value: 'secret'
		});
		expect(parsed.key).toBe('API_KEY');
	});
	it('rejects an empty value', () => {
		expect(
			projectEnvVarInputSchema.safeParse({ projectId: 'p1', key: 'A', value: '' }).success
		).toBe(false);
	});
});

describe('importProjectEnvFileSchema', () => {
	it('requires non-empty content', () => {
		expect(importProjectEnvFileSchema.safeParse({ projectId: 'p1', content: '' }).success).toBe(
			false
		);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- --run tests/unit/lib/schemas/project-agent-config.test.ts`
Expected: FAIL — exports not found.

- [ ] **Step 3: Add the schemas**

In `src/lib/schemas/project-agent-config.ts`, add near the top with the other regexes:

```ts
const ENV_VAR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
```

After `export type ProjectSecretInput = ...` (~line 121) add:

```ts
export const envVarKeySchema = z
	.string()
	.min(1)
	.max(128)
	.regex(ENV_VAR_KEY_RE, 'Use a valid environment variable name (letters, digits, underscore)');

export const projectEnvVarInputSchema = z.object({
	projectId: z.string().min(1),
	key: envVarKeySchema,
	value: z.string().min(1),
	sensitive: z.boolean().optional()
});

export type ProjectEnvVarInput = z.infer<typeof projectEnvVarInputSchema>;

export const setProjectEnvVarSensitiveSchema = projectConfigIdSchema.extend({
	sensitive: z.boolean()
});

export const importProjectEnvFileSchema = z.object({
	projectId: z.string().min(1),
	content: z.string().min(1)
});
```

Note: `projectConfigIdSchema` is declared lower in the file (~line 123). Move the
new `setProjectEnvVarSensitiveSchema` to *after* that declaration, or place this
whole block after line 130 (after `projectConfigEnabledSchema`). Place it after line 130.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- --run tests/unit/lib/schemas/project-agent-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schemas/project-agent-config.ts tests/unit/lib/schemas/project-agent-config.test.ts
git commit -m "feat(env): add project env var schemas"
```

---

## Task 4: Service — projection, CRUD, reveal, import

**Files:**
- Modify: `src/lib/server/project-agent-config-service.ts`
- Test: `tests/unit/lib/server/project-agent-config-service.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/lib/server/project-agent-config-service.test.ts` (follow the file's existing mock/setup style — reuse its prisma + encryption mocks). The exact assertions:

```ts
// inside the existing describe for the service
it('projects env vars, masking sensitive values', async () => {
	// arrange: project exists; two env vars — one sensitive, one not
	// (use the file's existing prisma mock helpers to seed projectEnvVar.findMany)
	const config = await listProjectAgentConfigForOrg('org1', 'p1');
	expect(config.envVars).toEqual([
		{ id: 'e1', key: 'NODE_ENV', enabled: true, sensitive: false, value: 'test' },
		{ id: 'e2', key: 'API_KEY', enabled: true, sensitive: true, value: null }
	]);
});

it('reveals a single env var value', async () => {
	const value = await revealProjectEnvVarForOrg('org1', { projectId: 'p1', id: 'e2' });
	expect(value).toBe('secret-value');
});

it('imports a .env file, defaulting sensitivity from the key name', async () => {
	const result = await importProjectEnvFileForOrg('org1', 'user1', {
		projectId: 'p1',
		content: 'NODE_ENV=test\nAPI_KEY=abc\n# c\n1BAD=x'
	});
	expect(result.imported).toBe(2);
	expect(result.skipped).toContain('1BAD');
});
```

> Mirror the seeding/mocking already used by the secret tests in this file. If the
> file uses a real in-memory prisma, seed via its helpers instead of the comments above.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- --run tests/unit/lib/server/project-agent-config-service.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Update imports + projection**

In `project-agent-config-service.ts`, add to the schema import block (line 11-19):

```ts
	envVarKeySchema,
	type ProjectEnvVarInput,
```

Update `listProjectAgentConfigForOrg` (line 152). Add `projectEnvVar` to the
`Promise.all` and to the return:

```ts
	const [mcpServers, skills, secrets, envVars] = await Promise.all([
		prisma.projectMcpServer.findMany({ where: { organizationId, projectId }, orderBy: { name: 'asc' } }),
		prisma.projectSkill.findMany({ where: { organizationId, projectId }, orderBy: { name: 'asc' } }),
		prisma.projectSecret.findMany({
			where: { organizationId, projectId },
			orderBy: { name: 'asc' },
			select: { id: true, name: true }
		}),
		prisma.projectEnvVar.findMany({
			where: { organizationId, projectId },
			orderBy: { key: 'asc' },
			select: { id: true, key: true, enabled: true, sensitive: true, valueEncrypted: true }
		})
	]);

	return {
		mcpServers,
		skills,
		secrets: secrets.map((secret) => ({ id: secret.id, name: secret.name, hasValue: true })),
		envVars: envVars.map((envVar) => ({
			id: envVar.id,
			key: envVar.key,
			enabled: envVar.enabled,
			sensitive: envVar.sensitive,
			value: envVar.sensitive ? null : decryptProjectSecretValue(envVar.valueEncrypted)
		}))
	};
```

- [ ] **Step 4: Add CRUD + reveal + import functions**

Add after `createProjectSecretForOrg` (~line 378):

```ts
function defaultEnvVarSensitivity(key: string, explicit: boolean | undefined): boolean {
	return explicit ?? isSensitiveConfigKey(key);
}

export async function upsertProjectEnvVarForOrg(
	organizationId: string,
	createdById: string,
	input: ProjectEnvVarInput
) {
	await requireProjectInOrg(organizationId, input.projectId);
	const key = envVarKeySchema.parse(input.key);
	const sensitive = defaultEnvVarSensitivity(key, input.sensitive);
	return prisma.projectEnvVar.upsert({
		where: { projectId_key: { projectId: input.projectId, key } },
		create: {
			projectId: input.projectId,
			organizationId,
			key,
			valueEncrypted: encryptProjectSecretValue(input.value),
			sensitive,
			createdById
		},
		update: {
			valueEncrypted: encryptProjectSecretValue(input.value),
			sensitive
		}
	});
}

export async function setProjectEnvVarSensitiveForOrg(
	organizationId: string,
	input: { projectId: string; id: string; sensitive: boolean }
) {
	const result = await prisma.projectEnvVar.updateMany({
		where: { id: input.id, projectId: input.projectId, organizationId },
		data: { sensitive: input.sensitive }
	});
	if (result.count === 0) throw new ProjectAgentConfigError('Env var not found');
}

export async function revealProjectEnvVarForOrg(
	organizationId: string,
	input: { projectId: string; id: string }
): Promise<string> {
	const envVar = await prisma.projectEnvVar.findFirst({
		where: { id: input.id, projectId: input.projectId, organizationId },
		select: { valueEncrypted: true }
	});
	if (!envVar) throw new ProjectAgentConfigError('Env var not found');
	return decryptProjectSecretValue(envVar.valueEncrypted);
}

export async function importProjectEnvFileForOrg(
	organizationId: string,
	createdById: string,
	input: { projectId: string; content: string }
): Promise<{ imported: number; skipped: string[] }> {
	await requireProjectInOrg(organizationId, input.projectId);
	const entries = parseDotenv(input.content);
	const skipped: string[] = [];
	let imported = 0;
	for (const entry of entries) {
		if (entry.value.length === 0) {
			skipped.push(entry.key);
			continue;
		}
		await upsertProjectEnvVarForOrg(organizationId, createdById, {
			projectId: input.projectId,
			key: entry.key,
			value: entry.value
		});
		imported += 1;
	}
	// surface invalid keys parseDotenv dropped
	const rawKeys = input.content
		.split('\n')
		.map((line) => line.trim().replace(/^export /, '').split('=')[0].trim())
		.filter((key) => key.length > 0 && !key.startsWith('#'));
	for (const key of rawKeys) {
		if (!entries.some((entry) => entry.key === key) && !skipped.includes(key)) skipped.push(key);
	}
	return { imported, skipped };
}
```

Add the import at the top of the file (after the encryption import block):

```ts
import { parseDotenv } from '$lib/server/dotenv';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test:unit -- --run tests/unit/lib/server/project-agent-config-service.test.ts`
Expected: the new tests PASS. (Pre-existing tests may fail until Task 5 because the
projection now returns `envVars` — if an existing test deep-equals the whole
`listProjectAgentConfigForOrg` result, update it to include `envVars: []`.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/project-agent-config-service.ts tests/unit/lib/server/project-agent-config-service.test.ts
git commit -m "feat(env): project env var service CRUD, reveal, import"
```

---

## Task 5: Service — `buildRunAgentConfig.envFile` + snapshot

**Files:**
- Modify: `src/lib/server/project-agent-config-service.ts`
- Test: `tests/unit/lib/server/project-agent-config-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('includes enabled env vars in the runtime config envFile', async () => {
	// seed one enabled env var API_KEY=secret and one disabled DISABLED=x
	const config = await buildRunAgentConfig('org1', 'p1', { useProjectAgentConfig: true });
	expect(config.envFile).toEqual([{ key: 'API_KEY', value: 'secret' }]);
	expect(config.snapshot.envVars).toEqual([{ key: 'API_KEY' }]);
	expect(JSON.stringify(config.snapshot)).not.toContain('secret');
});

it('returns an empty envFile when project agent config is disabled', async () => {
	const config = await buildRunAgentConfig('org1', 'p1', { useProjectAgentConfig: false });
	expect(config.envFile).toEqual([]);
	expect(config.snapshot.envVars).toEqual([]);
});
```

Also update the existing assertions that deep-equal `result.snapshot` (the
service test asserts `snapshot` `toEqual({ enabled, mcpServers, skills })` in
several places — search for `enabled: false, mcpServers: [], skills: []` and
`snapshot).toEqual(`). Add `envVars: []` (or the expected entries) to each.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- --run tests/unit/lib/server/project-agent-config-service.test.ts`
Expected: FAIL — `envFile` undefined / snapshot shape mismatch.

- [ ] **Step 3: Update the interface + builder**

In `RuntimeAgentConfig` (line 29) add `envFile` and extend `snapshot`:

```ts
	secretEnv: Record<string, string>;
	envFile: Array<{ key: string; value: string }>;
	snapshot: {
		enabled: boolean;
		mcpServers: Array<{ id: string; name: string; transport: string }>;
		skills: Array<{
			id: string;
			name: string;
			sourceProvider: string | null;
			sourceSkillId: string | null;
			sourceHash: string | null;
		}>;
		envVars: Array<{ key: string }>;
	};
```

In `buildRunAgentConfig`, update the early-return (line 524) to include the new fields:

```ts
	if (!options.useProjectAgentConfig) {
		return {
			mcpJson: { mcpServers: {} },
			settings: { enabledMcpjsonServers: [] },
			skills: [],
			secretEnv: {},
			envFile: [],
			snapshot: { enabled: false, mcpServers: [], skills: [], envVars: [] }
		};
	}
```

Add `projectEnvVar` to the `Promise.all` (line 535):

```ts
	const [mcpServers, skills, secrets, envVars] = await Promise.all([
		prisma.projectMcpServer.findMany({ where: { organizationId, projectId, enabled: true }, orderBy: { name: 'asc' } }),
		prisma.projectSkill.findMany({
			where: { organizationId, projectId, enabled: true },
			orderBy: { name: 'asc' },
			include: { files: { orderBy: { path: 'asc' } } }
		}),
		prisma.projectSecret.findMany({ where: { organizationId, projectId } }),
		prisma.projectEnvVar.findMany({
			where: { organizationId, projectId, enabled: true },
			orderBy: { key: 'asc' },
			select: { key: true, valueEncrypted: true }
		})
	]);
```

Build the env file list (before the `return`):

```ts
	const envFile = envVars.map((envVar) => ({
		key: envVar.key,
		value: decryptProjectSecretValue(envVar.valueEncrypted)
	}));
```

In the returned object add `envFile,` next to `secretEnv,` and add to `snapshot`:

```ts
		envVars: envVars.map((envVar) => ({ key: envVar.key }))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- --run tests/unit/lib/server/project-agent-config-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/project-agent-config-service.ts tests/unit/lib/server/project-agent-config-service.test.ts
git commit -m "feat(env): expose env vars in runtime config and snapshot"
```

---

## Task 6: Service — materialize `.env` (merge + git protection)

**Files:**
- Modify: `src/lib/server/project-agent-config-service.ts` (`materializeRunAgentConfig` ~line 671)
- Test: `tests/unit/lib/server/project-agent-config-service.test.ts`

- [ ] **Step 1: Write the failing test**

Follow the file's approach for `materializeRunAgentConfig` (it writes to a temp
dir). Add:

```ts
it('merges env vars into .env and marks it as a generated path', async () => {
	const dir = await makeTempCheckout(); // reuse the helper the file already uses
	await writeFile(join(dir, '.env'), 'KEEP=1\n');
	await materializeRunAgentConfig(dir, {
		mcpJson: { mcpServers: {} },
		settings: { enabledMcpjsonServers: [] },
		skills: [],
		secretEnv: {},
		envFile: [{ key: 'API_KEY', value: 'secret' }],
		snapshot: { enabled: true, mcpServers: [], skills: [], envVars: [{ key: 'API_KEY' }] }
	});
	const written = await readFile(join(dir, '.env'), 'utf8');
	expect(written).toContain('KEEP=1');
	expect(written).toContain('API_KEY=secret');
});

it('skips writing .env when there are no env vars', async () => {
	const dir = await makeTempCheckout();
	await materializeRunAgentConfig(dir, {
		mcpJson: { mcpServers: {} },
		settings: { enabledMcpjsonServers: [] },
		skills: [],
		secretEnv: {},
		envFile: [],
		snapshot: { enabled: true, mcpServers: [], skills: [], envVars: [] }
	});
	await expect(readFile(join(dir, '.env'), 'utf8')).rejects.toThrow();
});
```

> If the existing tests stub out git (the file already exercises
> `protectGeneratedAgentConfigFiles`), follow that same stubbing.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- --run tests/unit/lib/server/project-agent-config-service.test.ts`
Expected: FAIL — `.env` not written.

- [ ] **Step 3: Implement the merge**

Add `readFile` to the `node:fs/promises` import (line 2):

```ts
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
```

Add `mergeDotenv` to the dotenv import:

```ts
import { mergeDotenv, parseDotenv } from '$lib/server/dotenv';
```

In `materializeRunAgentConfig`, after the skills loop and **before**
`await protectGeneratedAgentConfigFiles(...)` (line 705), add:

```ts
	if (config.envFile.length > 0) {
		const envPath = join(checkoutPath, '.env');
		let existing = '';
		try {
			existing = await readFile(envPath, 'utf8');
		} catch {
			existing = '';
		}
		await writeFile(envPath, mergeDotenv(existing, config.envFile));
		generatedPaths.push('.env');
	}
```

(`generatedPaths` is the array already declared at line 676; pushing `.env`
routes it through the existing git exclude + `skip-worktree` protection.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- --run tests/unit/lib/server/project-agent-config-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/project-agent-config-service.ts tests/unit/lib/server/project-agent-config-service.test.ts
git commit -m "feat(env): merge project env vars into checkout .env"
```

---

## Task 7: Remote functions

**Files:**
- Modify: `src/lib/rfc/project-agent-config.remote.ts`
- Test: `tests/unit/lib/rfc/project-agent-config.remote.test.ts`

- [ ] **Step 1: Write the failing test**

Mirror the secret-command tests already in the file. Add cases asserting:
`upsertProjectEnvVar` calls `upsertProjectEnvVarForOrg` with the current user id
and refreshes; `deleteProjectEnvVar` deletes scoped by org and 404s on miss;
`setProjectEnvVarEnabled` updates and 404s on miss; `setProjectEnvVarSensitive`
calls the service; `revealProjectEnvVar` returns the value; `importProjectEnvFile`
returns `{ imported, skipped }`.

```ts
it('upserts an env var as the current user and refreshes', async () => {
	await upsertProjectEnvVar({ projectId: 'p1', key: 'API_KEY', value: 'x' });
	expect(mocks.upsertProjectEnvVarForOrg).toHaveBeenCalledWith('org1', 'user1', {
		projectId: 'p1',
		key: 'API_KEY',
		value: 'x'
	});
});
```

> Reuse the file's existing mock wiring for `org`, `getRequestEvent().locals.user`,
> and the service module.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- --run tests/unit/lib/rfc/project-agent-config.remote.test.ts`
Expected: FAIL — commands not exported.

- [ ] **Step 3: Add imports**

Add to the schema import block (line 4-18):

```ts
	projectEnvVarInputSchema,
	setProjectEnvVarSensitiveSchema,
	importProjectEnvFileSchema,
```

Add to the service import block (line 20-28):

```ts
	upsertProjectEnvVarForOrg,
	setProjectEnvVarSensitiveForOrg,
	revealProjectEnvVarForOrg,
	importProjectEnvFileForOrg,
```

- [ ] **Step 4: Add the commands**

Add after `deleteProjectSecret` / `setProjectSkillEnabled` (~line 443):

```ts
export const upsertProjectEnvVar = command(projectEnvVarInputSchema, async (input) => {
	const organizationId = await requireOrganizationId();
	const { locals } = getRequestEvent();
	try {
		const result = await upsertProjectEnvVarForOrg(organizationId, locals.user!.id, input);
		await refreshProjectAgentConfig(input.projectId);
		return result;
	} catch (e) {
		mapProjectAgentConfigCommandError(e);
	}
});

export const deleteProjectEnvVar = command(projectConfigIdSchema, async ({ projectId, id }) => {
	const organizationId = await requireOrganizationId();
	const result = await prisma.projectEnvVar.deleteMany({ where: { id, projectId, organizationId } });
	if (result.count === 0) error(404, 'Not found');
	await refreshProjectAgentConfig(projectId);
});

export const setProjectEnvVarEnabled = command(
	projectConfigEnabledSchema,
	async ({ projectId, id, enabled }) => {
		const organizationId = await requireOrganizationId();
		const result = await prisma.projectEnvVar.updateMany({
			where: { id, projectId, organizationId },
			data: { enabled }
		});
		if (result.count === 0) error(404, 'Not found');
		await refreshProjectAgentConfig(projectId);
	}
);

export const setProjectEnvVarSensitive = command(
	setProjectEnvVarSensitiveSchema,
	async ({ projectId, id, sensitive }) => {
		const organizationId = await requireOrganizationId();
		try {
			await setProjectEnvVarSensitiveForOrg(organizationId, { projectId, id, sensitive });
			await refreshProjectAgentConfig(projectId);
		} catch (e) {
			mapProjectAgentConfigCommandError(e);
		}
	}
);

export const revealProjectEnvVar = command(projectConfigIdSchema, async ({ projectId, id }) => {
	const organizationId = await requireOrganizationId();
	try {
		return { value: await revealProjectEnvVarForOrg(organizationId, { projectId, id }) };
	} catch (e) {
		mapProjectAgentConfigCommandError(e);
	}
});

export const importProjectEnvFile = command(importProjectEnvFileSchema, async (input) => {
	const organizationId = await requireOrganizationId();
	const { locals } = getRequestEvent();
	try {
		const result = await importProjectEnvFileForOrg(organizationId, locals.user!.id, input);
		await refreshProjectAgentConfig(input.projectId);
		return result;
	} catch (e) {
		mapProjectAgentConfigCommandError(e);
	}
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test:unit -- --run tests/unit/lib/rfc/project-agent-config.remote.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/rfc/project-agent-config.remote.ts tests/unit/lib/rfc/project-agent-config.remote.test.ts
git commit -m "feat(env): project env var remote commands"
```

---

## Task 8: UI — `EnvVarEditor.svelte`

**Files:**
- Create: `src/lib/components/projects/EnvVarEditor.svelte`

- [ ] **Step 1: Write the component** (calqué sur `SecretEditor.svelte`)

```svelte
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import type { ProjectEnvVarInput } from '$lib/schemas/project-agent-config';
	import { Save } from '@lucide/svelte';

	let {
		projectId,
		onSave
	}: {
		projectId: string;
		onSave: (input: ProjectEnvVarInput) => Promise<unknown>;
	} = $props();

	let key = $state('');
	let value = $state('');
	let sensitive = $state(true);
	let saving = $state(false);
	let error = $state<string | null>(null);

	const canSave = $derived(key.trim().length > 0 && value.length > 0);

	function reset() {
		key = '';
		value = '';
		sensitive = true;
	}

	async function save() {
		if (!canSave || saving) return;
		error = null;
		saving = true;
		try {
			await onSave({ projectId, key: key.trim(), value, sensitive });
			reset();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save variable';
		} finally {
			saving = false;
		}
	}
</script>

<form
	class="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end"
	onsubmit={(event) => {
		event.preventDefault();
		void save();
	}}
>
	{#if error}
		<p class="text-sm break-words text-destructive md:col-span-3" role="alert">{error}</p>
	{/if}

	<div class="space-y-1">
		<Label for="envvar-key">Key</Label>
		<Input id="envvar-key" bind:value={key} placeholder="DATABASE_URL" />
	</div>
	<div class="space-y-1">
		<Label for="envvar-value">Value</Label>
		<Input id="envvar-value" type={sensitive ? 'password' : 'text'} bind:value placeholder="value" />
	</div>
	<Button type="submit" disabled={!canSave || saving}>
		<Save />
		Save
	</Button>
	<label class="flex items-center gap-2 text-sm md:col-span-3">
		<input type="checkbox" bind:checked={sensitive} />
		Sensitive (mask value)
	</label>
</form>
```

- [ ] **Step 2: Validate with the Svelte autofixer**

Run the `svelte-autofixer` MCP tool on the component. Fix any reported issue and
re-run until clean.

- [ ] **Step 3: Type-check**

Run: `bunx svelte-check --threshold error` (or `bun run check` if defined in package.json)
Expected: no errors in `EnvVarEditor.svelte`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/projects/EnvVarEditor.svelte
git commit -m "feat(env): add EnvVarEditor component"
```

---

## Task 9: UI — env section in `AgentConfigPanel.svelte`

**Files:**
- Modify: `src/lib/components/projects/AgentConfigPanel.svelte`

- [ ] **Step 1: Extend imports + types**

Add to the remote import block (line 4-13):

```ts
	deleteProjectEnvVar,
	setProjectEnvVarEnabled,
	upsertProjectEnvVar,
	importProjectEnvFile,
```

Add an icon to line 14 (e.g. `FileCog`) and import the editor:

```ts
	import EnvVarEditor from './EnvVarEditor.svelte';
```

Extend `AgentConfig` type (after `secrets` array, ~line 40):

```ts
		envVars: Array<{
			id: string;
			key: string;
			enabled: boolean;
			sensitive: boolean;
			value: string | null;
		}>;
```

Extend the `Section` union (line 42):

```ts
	type Section = 'mcp' | 'skills' | 'secrets' | 'env';
```

- [ ] **Step 2: Add the delete + toggle + import handlers** (after `deleteSecret`, ~line 71)

```ts
	async function deleteEnvVar(envVar: AgentConfig['envVars'][number]) {
		if (!confirm(`Delete ${envVar.key}? Runs will no longer receive it.`)) return;
		await runAction(`env-delete-${envVar.id}`, () =>
			deleteProjectEnvVar({ projectId, id: envVar.id })
		);
	}

	async function toggleEnvVar(envVar: AgentConfig['envVars'][number]) {
		await runAction(`env-toggle-${envVar.id}`, () =>
			setProjectEnvVarEnabled({ projectId, id: envVar.id, enabled: !envVar.enabled })
		);
	}

	let envImportText = $state('');
	async function importEnv() {
		if (envImportText.trim().length === 0) return;
		await runAction('env-import', async () => {
			await importProjectEnvFile({ projectId, content: envImportText });
			envImportText = '';
		});
	}
```

- [ ] **Step 3: Add the nav button**

Change the tab container from `grid-cols-3` to `grid-cols-4` (line 81) and add a
button after the Secrets button (after line 108):

```svelte
			<Button
				variant={section === 'env' ? 'default' : 'ghost'}
				aria-pressed={section === 'env'}
				onclick={() => (section = 'env')}
				class="justify-start"
			>
				<FileCog />
				.env
			</Button>
```

- [ ] **Step 4: Add the env card**

Before the final `{/if}` of the section conditional (~line 277, after the secrets
`{:else}` block), add a new branch. Restructure the trailing
`{:else} ... {/if}` so secrets uses `{:else if section === 'secrets'}` and env
gets its own `{:else}`:

```svelte
		{:else if section === 'secrets'}
			<!-- existing secrets Card.Root unchanged -->
		{:else}
			<Card.Root size="sm">
				<Card.Header>
					<Card.Title>Environment (.env)</Card.Title>
					<Card.Description>{config.envVars.length} configured</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4">
					{#if config.envVars.length === 0}
						<p class="text-sm text-muted-foreground">No environment variables.</p>
					{:else}
						<ul class="divide-y divide-border border-y border-border">
							{#each config.envVars as envVar (envVar.id)}
								<li class="grid gap-2 py-2 text-sm md:grid-cols-[1fr_auto] md:items-center">
									<div class="min-w-0">
										<p class="truncate font-medium">{envVar.key}</p>
										<p class="truncate text-xs text-muted-foreground">
											{envVar.sensitive ? '••••••' : envVar.value}
											{envVar.enabled ? '' : ' · disabled'}
										</p>
									</div>
									<div class="flex gap-2">
										<Button
											variant="ghost"
											size="sm"
											disabled={actionsDisabled}
											onclick={() => void toggleEnvVar(envVar)}
										>
											{#if envVar.enabled}<Power />{:else}<PowerOff />{/if}
										</Button>
										<Button
											variant="destructive"
											size="sm"
											disabled={actionsDisabled}
											onclick={() => void deleteEnvVar(envVar)}
										>
											<Trash2 />
											Delete
										</Button>
									</div>
								</li>
							{/each}
						</ul>
					{/if}
					<EnvVarEditor {projectId} onSave={upsertProjectEnvVar} />
					<div class="space-y-2">
						<label class="text-sm font-medium" for="env-import">Import a .env</label>
						<textarea
							id="env-import"
							class="min-h-24 w-full border border-border bg-background p-2 font-mono text-xs"
							bind:value={envImportText}
							placeholder={'NODE_ENV=production\nAPI_KEY=...'}
						></textarea>
						<Button size="sm" disabled={actionsDisabled} onclick={() => void importEnv()}>
							Import
						</Button>
					</div>
				</Card.Content>
			</Card.Root>
		{/if}
```

> `Power`, `PowerOff`, `Trash2` are already imported at line 14. Add `FileCog` to
> that import.

- [ ] **Step 5: Validate with the Svelte autofixer**

Run the `svelte-autofixer` MCP tool on `AgentConfigPanel.svelte`. Fix and re-run
until clean.

- [ ] **Step 6: Type-check + build**

Run: `bun run check` (svelte-check) — expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/components/projects/AgentConfigPanel.svelte
git commit -m "feat(env): env var section in agent config panel"
```

---

## Task 10: run-orchestrator regression test

**Files:**
- Modify: `tests/unit/lib/server/run-orchestrator.test.ts`

- [ ] **Step 1: Update the runtime config test helper**

The test file has an `emptyRuntimeAgentConfig(enabled)` helper and at least one
literal mock (line ~194) of `buildRunAgentConfig`. Add `envFile: []` and
`envVars: []` to the snapshot in both so they match the new `RuntimeAgentConfig`
shape:

```ts
function emptyRuntimeAgentConfig(enabled: boolean) {
	return {
		mcpJson: { mcpServers: {} },
		settings: { enabledMcpjsonServers: [] },
		skills: [],
		secretEnv: {},
		envFile: [],
		snapshot: { enabled, mcpServers: [], skills: [], envVars: [] }
	};
}
```

Update the literal mock near line 194 likewise (add `envFile: []` and
`snapshot.envVars: []`).

- [ ] **Step 2: Run the orchestrator tests**

Run: `bun run test:unit -- --run tests/unit/lib/server/run-orchestrator.test.ts`
Expected: PASS (materialize is already invoked when `useProjectAgentConfig` is
true; the `.env` write is covered by Task 6).

- [ ] **Step 3: Run the full unit suite**

Run: `bun run test:unit -- --run`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/lib/server/run-orchestrator.test.ts
git commit -m "test(env): keep run-orchestrator config shape in sync"
```

---

## Final Verification

- [ ] Run full suite: `bun run test:unit -- --run` → all green.
- [ ] Type-check: `bunx tsc --noEmit` and `bun run check` → clean.
- [ ] Lint/format: `bun run lint` (or `bunx prettier --check . && bunx eslint .`).
- [ ] Manual smoke (optional): start dev, open a project, add a `.env` var, paste an
      import, toggle sensitive/enabled, delete; start a run with project agent
      config on and confirm the merged `.env` is present in the checkout and absent
      from the run diff.
