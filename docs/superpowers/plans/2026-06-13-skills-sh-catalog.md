# skills.sh Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native skills.sh catalog to project agent config so users can search skills, preview them, and add them to a project for Claude Code runs.

**Architecture:** Keep dotWeaver as the source of truth for imported project skills. Search and download happen server-side through a small skills.sh client; imported skill snapshots are stored in Prisma and materialized into `.claude/skills/<name>/...` only inside the runner checkout.

**Tech Stack:** SvelteKit remote functions, Svelte 5 components, Prisma/PostgreSQL, Vitest, skills.sh `/api/v1` when authenticated with Vercel OIDC, fallback to the current legacy CLI endpoints for local development.

---

## File Structure

- Create `src/lib/server/skills-sh-service.ts`: skills.sh search/download client, response normalization, frontmatter extraction, and safe file validation.
- Create `tests/unit/lib/server/skills-sh-service.test.ts`: unit tests for API fallback, normalization, limits, and path safety.
- Modify `prisma/schema.prisma`: add imported skill metadata fields on `ProjectSkill` and add `ProjectSkillFile`.
- Create `prisma/migrations/20260613010000_add_project_skill_files/migration.sql`: SQL migration for the new metadata and support-file table.
- Modify `src/lib/schemas/project-agent-config.ts`: add zod schemas for skills.sh search, preview, and import commands.
- Modify `tests/unit/lib/schemas/project-agent-config.test.ts`: validate new schemas reject unsafe inputs.
- Modify `src/lib/server/project-agent-config-service.ts`: import skills.sh snapshots, persist support files, include files in runtime projections, and materialize files safely.
- Modify `tests/unit/lib/server/project-agent-config-service.test.ts`: cover import conflict handling, runtime file projection, materialization, and unsafe support-file paths.
- Modify `src/lib/rfc/project-agent-config.remote.ts`: expose `searchSkillsSh`, `getSkillsShSkill`, and `importSkillsShSkill`.
- Modify `tests/unit/lib/rfc/project-agent-config.remote.test.ts`: verify org scoping, refresh, and service error mapping.
- Create `src/lib/components/projects/SkillsShCatalog.svelte`: search UI, preview panel, and add/replace actions.
- Modify `src/lib/components/projects/AgentConfigPanel.svelte`: show imported metadata and mount the catalog inside the Skills section.

## API Decision

skills.sh currently documents `/api/v1/skills/search` and `/api/v1/skills/{id}` as the official API, but those endpoints require a Vercel OIDC bearer token. Local unauthenticated calls return `401 authentication_required`.

Implementation rule:

- If `SKILLS_SH_API_TOKEN` or `VERCEL_OIDC_TOKEN` is present, call `/api/v1/...` with `Authorization: Bearer <token>`.
- If no token is present or `/api/v1` returns `401`, use the legacy endpoints used by the `skills` CLI: `/api/search?q=...&limit=...` and `/api/download/<source>/<skill>`.
- Normalize both shapes to the same internal types.
- Never execute `npx skills` from dotWeaver.

## Task 1: skills.sh Client

**Files:**

- Create: `src/lib/server/skills-sh-service.ts`
- Create: `tests/unit/lib/server/skills-sh-service.test.ts`

- [ ] **Step 1: Write failing tests for search fallback**

Add tests that mock `fetch` and expect:

```ts
await searchSkillsShCatalog({ query: 'svelte', limit: 2 }, fetchImpl);
```

to call:

```ts
https://skills.sh/api/v1/skills/search?q=svelte&limit=2
```

with authorization when a token is supplied, and to fall back to:

```ts
https://skills.sh/api/search?q=svelte&limit=2
```

when the first response is `401`.

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/skills-sh-service.test.ts
```

Expected: FAIL because `src/lib/server/skills-sh-service.ts` does not exist.

- [ ] **Step 2: Implement minimal search client**

Create the service with these exported types:

```ts
export type SkillsShSearchResult = {
	id: string;
	slug: string;
	name: string;
	source: string;
	installs: number;
	sourceType?: string;
	installUrl?: string | null;
	url?: string | null;
	isDuplicate?: boolean;
};

export type SkillsShSearchResponse = {
	query: string;
	results: SkillsShSearchResult[];
	count: number;
	searchType?: string;
};
```

Add `searchSkillsShCatalog(input, fetchImpl = fetch)` that trims the query, rejects queries under two characters with an empty result, calls the official endpoint first when a token exists, then falls back to the legacy endpoint on auth failure or missing token.

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/skills-sh-service.test.ts
```

Expected: PASS for search tests.

- [ ] **Step 3: Write failing tests for download normalization**

Mock official detail:

```json
{
	"id": "vercel-labs/skills/find-skills",
	"source": "vercel-labs/skills",
	"slug": "find-skills",
	"installs": 24531,
	"hash": "abc123",
	"files": [
		{
			"path": "SKILL.md",
			"contents": "---\nname: find-skills\ndescription: Find skills\n---\n\nUse it."
		},
		{ "path": "examples/demo.md", "contents": "demo" }
	]
}
```

Expect `downloadSkillsShSkill({ id: 'vercel-labs/skills/find-skills' })` to return:

```ts
{
	id: 'vercel-labs/skills/find-skills',
	name: 'find-skills',
	description: 'Find skills',
	body: expect.stringContaining('Use it.'),
	files: [{ path: 'examples/demo.md', content: 'demo' }],
	source: 'vercel-labs/skills',
	slug: 'find-skills',
	hash: 'abc123'
}
```

Run the same unit test command.

Expected: FAIL because download is not implemented.

- [ ] **Step 4: Implement download and validation**

Add:

```ts
export type SkillsShDownloadedSkill = {
	id: string;
	name: string;
	description: string;
	body: string;
	files: Array<{ path: string; content: string }>;
	source: string;
	slug: string;
	hash: string | null;
	url?: string | null;
	installUrl?: string | null;
	sourceType?: string | null;
};
```

Validation rules:

- Require exactly one `SKILL.md`.
- Reject absolute paths.
- Reject `..`, empty path segments, backslashes, and null bytes.
- Reject more than 100 files.
- Reject any file over 1 MB.
- Reject total contents over 5 MB.
- Keep `ProjectSkill.name` equal to the URL-safe slug/install name.
- Extract description from frontmatter; default to `Imported skill <name>` when absent.

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/skills-sh-service.test.ts
```

Expected: PASS.

## Task 2: Prisma Storage

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260613010000_add_project_skill_files/migration.sql`

- [ ] **Step 1: Add schema fields**

Extend `ProjectSkill`:

```prisma
  sourceProvider String?
  sourcePackage  String?
  sourceSkillId  String?
  sourceUrl      String?
  sourceHash     String?
  sourceMetadata Json?
  importedAt     DateTime?
  files          ProjectSkillFile[]
```

Add:

```prisma
model ProjectSkillFile {
  id             String       @id @default(cuid())
  projectSkillId String
  projectSkill   ProjectSkill @relation(fields: [projectSkillId], references: [id], onDelete: Cascade)
  path           String
  content        String
  contentHash    String
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @default(now()) @updatedAt

  @@unique([projectSkillId, path])
  @@map("project_skill_file")
}
```

- [ ] **Step 2: Add SQL migration**

Migration SQL:

```sql
ALTER TABLE "project_skill"
ADD COLUMN "sourceProvider" TEXT,
ADD COLUMN "sourcePackage" TEXT,
ADD COLUMN "sourceSkillId" TEXT,
ADD COLUMN "sourceUrl" TEXT,
ADD COLUMN "sourceHash" TEXT,
ADD COLUMN "sourceMetadata" JSONB,
ADD COLUMN "importedAt" TIMESTAMP(3);

CREATE TABLE "project_skill_file" (
  "id" TEXT NOT NULL,
  "projectSkillId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_skill_file_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_skill_file_projectSkillId_path_key"
ON "project_skill_file"("projectSkillId", "path");

ALTER TABLE "project_skill_file"
ADD CONSTRAINT "project_skill_file_projectSkillId_fkey"
FOREIGN KEY ("projectSkillId") REFERENCES "project_skill"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Generate Prisma client**

Run:

```bash
bunx prisma generate
```

Expected: generated client includes `projectSkillFile`.

## Task 3: Schemas

**Files:**

- Modify: `src/lib/schemas/project-agent-config.ts`
- Modify: `tests/unit/lib/schemas/project-agent-config.test.ts`

- [ ] **Step 1: Write failing schema tests**

Add tests for:

```ts
skillsShSearchSchema.safeParse({ query: 'sv', limit: 20 }).success === true;
skillsShSearchSchema.safeParse({ query: 's', limit: 20 }).success === false;
skillsShSkillIdSchema.safeParse({ id: 'vercel-labs/skills/find-skills' }).success === true;
skillsShSkillIdSchema.safeParse({ id: '../escape' }).success === false;
importSkillsShSkillSchema.safeParse({
	projectId: 'p1',
	id: 'vercel-labs/skills/find-skills',
	replace: false
}).success === true;
```

Run:

```bash
bun run test:unit -- --run tests/unit/lib/schemas/project-agent-config.test.ts
```

Expected: FAIL because schemas do not exist.

- [ ] **Step 2: Implement schemas**

Add:

```ts
const SKILLS_SH_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/;

export const skillsShSearchSchema = z.object({
	query: z.string().trim().min(2).max(120),
	limit: z.number().int().min(1).max(50).default(20)
});

export const skillsShSkillIdSchema = z.object({
	id: z.string().min(3).max(240).regex(SKILLS_SH_ID_RE)
});

export const importSkillsShSkillSchema = skillsShSkillIdSchema.extend({
	projectId: z.string().min(1),
	replace: z.boolean().default(false)
});
```

Run:

```bash
bun run test:unit -- --run tests/unit/lib/schemas/project-agent-config.test.ts
```

Expected: PASS.

## Task 4: Project Agent Config Service

**Files:**

- Modify: `src/lib/server/project-agent-config-service.ts`
- Modify: `tests/unit/lib/server/project-agent-config-service.test.ts`

- [ ] **Step 1: Write failing import tests**

Mock `prisma.projectSkill.findFirst`, `prisma.$transaction`, `prisma.projectSkill.update`, `prisma.projectSkill.create`, `prisma.projectSkillFile.createMany`, and `prisma.projectSkillFile.deleteMany`.

Add tests that assert:

- New imported skills call `projectSkill.create` with `source: 'imported'`, `sourceProvider: 'skills.sh'`, `sourcePackage`, `sourceSkillId`, `sourceHash`, and `importedAt`.
- Support files are stored with content hashes.
- Existing skill with same name rejects when `replace: false`.
- Existing skill is updated and support files are replaced when `replace: true`.

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/project-agent-config-service.test.ts
```

Expected: FAIL because import service does not exist.

- [ ] **Step 2: Implement import persistence**

Add:

```ts
export async function importSkillsShSkillForOrg(
	organizationId: string,
	projectId: string,
	skill: SkillsShDownloadedSkill,
	options: { replace: boolean }
);
```

Use `requireProjectInOrg`, `assertSafeName(skill.name)`, and a Prisma transaction. On create, write `ProjectSkill` and `ProjectSkillFile` rows. On replace, update `ProjectSkill`, delete existing support files, and recreate them.

Run the service unit test file.

Expected: PASS for import tests.

- [ ] **Step 3: Write failing runtime projection tests**

Update the existing `buildRunAgentConfig` test to have:

```ts
mocks.skillFindMany.mockResolvedValue([
	{
		id: 'sk1',
		name: 'find-skills',
		description: 'Find skills',
		body: '---\nname: find-skills\n---\n\nUse it.',
		enabled: true,
		files: [{ path: 'examples/demo.md', content: 'demo' }],
		sourceProvider: 'skills.sh',
		sourceSkillId: 'vercel-labs/skills/find-skills',
		sourceHash: 'abc123'
	}
]);
```

Expect:

```ts
result.skills[0].files === [{ path: 'examples/demo.md', content: 'demo' }]
result.snapshot.skills[0] includes sourceProvider, sourceSkillId, sourceHash
```

Run the service unit test file.

Expected: FAIL until runtime projection includes files and metadata.

- [ ] **Step 4: Include files in runtime config**

Change `RuntimeAgentConfig.skills` to:

```ts
Array<{ name: string; body: string; files: Array<{ path: string; content: string }> }>;
```

Fetch skills with:

```ts
include: {
	files: {
		orderBy: {
			path: 'asc';
		}
	}
}
```

Map files and safe metadata into `snapshot.skills`.

Run the service unit test file.

Expected: PASS for projection tests.

- [ ] **Step 5: Write failing materialization tests**

Add tests that expect:

- `.claude/skills/find-skills/SKILL.md` is written.
- `.claude/skills/find-skills/examples/demo.md` is written.
- Git exclude contains both paths.
- Unsafe support-file paths reject before writing.

Run the service unit test file.

Expected: FAIL until support-file materialization exists.

- [ ] **Step 6: Implement safe support-file materialization**

Add `assertSafeSkillFilePath(path)` and write each support file under the skill directory. Add every generated support path to `generatedPaths` before `protectGeneratedAgentConfigFiles`.

Run:

```bash
bun run test:unit -- --run tests/unit/lib/server/project-agent-config-service.test.ts
```

Expected: PASS.

## Task 5: Remote Functions

**Files:**

- Modify: `src/lib/rfc/project-agent-config.remote.ts`
- Modify: `tests/unit/lib/rfc/project-agent-config.remote.test.ts`

- [ ] **Step 1: Write failing remote tests**

Mock:

```ts
searchSkillsShCatalog;
downloadSkillsShSkill;
importSkillsShSkillForOrg;
```

Assert:

- `searchSkillsSh({ query: 'svelte', limit: 20 })` requires active org and returns search results.
- `getSkillsShSkill({ id })` returns normalized preview data.
- `importSkillsShSkill({ projectId, id, replace })` downloads then persists in the active org and refreshes config.
- `ProjectAgentConfigError` maps to HTTP 400.

Run:

```bash
bun run test:unit -- --run tests/unit/lib/rfc/project-agent-config.remote.test.ts
```

Expected: FAIL because remotes do not exist.

- [ ] **Step 2: Implement remotes**

Add exports:

```ts
export const searchSkillsSh = query(skillsShSearchSchema, async (input) => {
	await requireOrganizationId();
	return await searchSkillsShCatalog(input);
});

export const getSkillsShSkill = query(skillsShSkillIdSchema, async (input) => {
	await requireOrganizationId();
	return await downloadSkillsShSkill(input);
});

export const importSkillsShSkill = command(importSkillsShSkillSchema, async (input) => {
	const organizationId = await requireOrganizationId();
	const skill = await downloadSkillsShSkill({ id: input.id });
	const result = await importSkillsShSkillForOrg(organizationId, input.projectId, skill, {
		replace: input.replace
	});
	await refreshProjectAgentConfig(input.projectId);
	return result;
});
```

Use `requireOrganizationId()` for org scoping. For import, call `downloadSkillsShSkill`, then `importSkillsShSkillForOrg`, then `refreshProjectAgentConfig(input.projectId)`.

Run the remote unit test file.

Expected: PASS.

## Task 6: Catalog UI

**Files:**

- Create: `src/lib/components/projects/SkillsShCatalog.svelte`
- Modify: `src/lib/components/projects/AgentConfigPanel.svelte`

- [ ] **Step 1: Create catalog component**

Component props:

```ts
type Props = {
	projectId: string;
	existingSkillNames: string[];
	onImported?: () => void | Promise<void>;
};
```

State:

```ts
let query = $state('');
let results = $state<SkillsShResult[]>([]);
let selected = $state<SkillsShPreview | null>(null);
let searching = $state(false);
let loadingId = $state<string | null>(null);
let importingId = $state<string | null>(null);
let error = $state<string | null>(null);
```

UI:

- Search input and icon button.
- Results list with name, source, installs, and Add/Replace button.
- Preview area showing description, hash, file count, and external link when available.
- Use icons from `@lucide/svelte`.
- Do not nest a card inside the existing Skills card; use bordered sections.

- [ ] **Step 2: Wire remotes**

Use remote functions:

```ts
import {
	getSkillsShSkill,
	importSkillsShSkill,
	searchSkillsSh
} from '$lib/rfc/project-agent-config.remote';
```

On add:

```ts
await importSkillsShSkill({
	projectId,
	id: result.id,
	replace: existingSkillNames.includes(result.slug)
});
await onImported?.();
```

Because `importSkillsShSkill` refreshes `getProjectAgentConfig`, the parent remote data should update.

- [ ] **Step 3: Mount in AgentConfigPanel**

Inside the Skills section, render:

```svelte
<SkillsShCatalog {projectId} existingSkillNames={config.skills.map((skill) => skill.name)} />
```

Update the skill list secondary line to include:

```svelte
{skill.sourceProvider === 'skills.sh' ? 'skills.sh' : skill.description}
```

only if the returned config type includes metadata.

- [ ] **Step 4: Run Svelte autofixer**

Call the Svelte MCP `svelte-autofixer` on `SkillsShCatalog.svelte` and modified `AgentConfigPanel.svelte`. Fix every issue and call it again until clean.

## Task 7: Verification

**Files:**

- All files touched above.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
bun run test:unit -- --run \
  tests/unit/lib/server/skills-sh-service.test.ts \
  tests/unit/lib/server/project-agent-config-service.test.ts \
  tests/unit/lib/rfc/project-agent-config.remote.test.ts \
  tests/unit/lib/schemas/project-agent-config.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run project checks**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 3: Run Prisma generate/check**

Run:

```bash
bunx prisma generate
```

Expected: PASS.

- [ ] **Step 4: Smoke test in browser**

Open the local app, visit a project, open `Agent config > Skills`, search for `svelte`, preview one result, and import it. Verify the imported skill appears in the configured skills list without reloading the page.

- [ ] **Step 5: Git hygiene**

Stage only files related to the skills.sh catalog implementation. Do not stage `.superpowers/` or unrelated existing page edits unless this task intentionally updates that page.
