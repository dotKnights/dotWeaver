# Teams & Invitations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user create teams and invite people into them, using SvelteKit remote functions, better-auth's `organization` plugin, Prisma, zod and superforms.

**Architecture:** "Team" maps to a better-auth `organization`. Reads go through remote `query` functions; writes through remote `command` functions that delegate to `auth.api.*` (passing session headers). Forms use superforms on the client (validation/UX) and call the remote command in `onSubmit`, mirroring the existing login page. Invitations are email-scoped; no email is sent — the accept link is shown for the inviter to copy.

**Tech Stack:** SvelteKit (remote functions), Svelte 5 runes, better-auth + organization plugin, Prisma 7 (PostgreSQL), zod 4, sveltekit-superforms, shadcn-svelte (bits-ui), vitest, playwright.

---

## File Structure

- `svelte.config.js` — enable `experimental.remoteFunctions` + `compilerOptions.experimental.async` (modify)
- `prisma/schema.prisma` — add `Organization`, `Member`, `Invitation`; add `Session.activeOrganizationId`; add `User.members` (modify)
- `src/lib/server/auth.ts` — add `organization()` plugin (modify)
- `src/lib/auth-client.ts` — add `organizationClient()` plugin (modify)
- `src/lib/server/slug.ts` — `slugify()` + collision resolver (create)
- `src/lib/server/slug.test.ts` — unit tests (create)
- `src/lib/schemas/teams.ts` — `createTeamSchema`, `inviteSchema` (create)
- `src/lib/schemas/teams.test.ts` — unit tests (create)
- `src/routes/(app)/teams/teams.remote.ts` — queries + commands (create)
- `src/routes/(app)/teams/+page.svelte` — list + create team (create)
- `src/routes/(app)/teams/[slug]/+page.svelte` — members, invite, pending invitations (create)
- `src/routes/(app)/accept-invitation/[id]/+page.svelte` — accept page (create)
- `src/routes/(app)/+layout.svelte` — active-team dropdown (create)
- `src/routes/(app)/+layout.server.ts` — already returns user; no change needed beyond existing
- `e2e/teams.spec.ts` — optional end-to-end flow (create)

---

## Task 1: Enable remote functions

**Files:**
- Modify: `svelte.config.js`

- [ ] **Step 1: Add experimental flags**

Replace the `config` object in `svelte.config.js` with:

```javascript
import adapter from '@sveltejs/adapter-auto';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true),
		experimental: {
			async: true
		}
	},
	kit: {
		adapter: adapter(),
		experimental: {
			remoteFunctions: true
		}
	}
};

export default config;
```

- [ ] **Step 2: Verify config still type-checks**

Run: `bun run check`
Expected: PASS (no svelte.config errors). Pre-existing unrelated warnings are acceptable; there must be no new errors referencing `svelte.config.js`.

- [ ] **Step 3: Commit**

```bash
git add svelte.config.js
git commit -m "feat: enable SvelteKit remote functions"
```

---

## Task 2: Prisma models for organizations

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add `activeOrganizationId` to Session**

In `prisma/schema.prisma`, inside `model Session`, add this line after `userAgent String?`:

```prisma
  activeOrganizationId String?
```

- [ ] **Step 2: Add `members` relation to User**

In `model User`, add after `accounts      Account[]`:

```prisma
  members       Member[]
```

- [ ] **Step 3: Add the three new models**

Append to `prisma/schema.prisma`:

```prisma
model Organization {
  id          String       @id
  name        String
  slug        String       @unique
  logo        String?
  metadata    String?
  createdAt   DateTime
  members     Member[]
  invitations Invitation[]

  @@map("organization")
}

model Member {
  id             String       @id
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  userId         String
  user           User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  role           String
  createdAt      DateTime

  @@map("member")
}

model Invitation {
  id             String       @id
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  email          String
  role           String?
  status         String
  inviterId      String
  expiresAt      DateTime

  @@map("invitation")
}
```

- [ ] **Step 4: Create and apply the migration**

Run: `bunx prisma migrate dev --name add_organizations`
Expected: migration created and applied; `prisma generate` runs automatically. If the database is unreachable, fix the connection (DATABASE_URL in env / `prisma.config.ts`) before continuing — do not skip.

- [ ] **Step 5: Verify the client generates**

Run: `bun run check`
Expected: PASS — no errors about missing `Organization`/`Member`/`Invitation` Prisma types.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add organization, member, invitation models"
```

---

## Task 3: Wire up the better-auth organization plugin

**Files:**
- Modify: `src/lib/server/auth.ts`
- Modify: `src/lib/auth-client.ts`

- [ ] **Step 1: Add the server plugin**

Replace the contents of `src/lib/server/auth.ts` with:

```typescript
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { organization } from 'better-auth/plugins';
import { prisma } from './prisma';
import { env } from '$env/dynamic/private';

export const auth = betterAuth({
	baseURL: env.BETTER_AUTH_URL,
	secret: env.BETTER_AUTH_SECRET,
	database: prismaAdapter(prisma, { provider: 'postgresql' }),
	emailAndPassword: {
		enabled: true
	},
	socialProviders: {
		github: {
			clientId: env.GITHUB_CLIENT_ID!,
			clientSecret: env.GITHUB_CLIENT_SECRET!
		}
	},
	plugins: [organization()]
});
```

- [ ] **Step 2: Add the client plugin**

Replace the contents of `src/lib/auth-client.ts` with:

```typescript
import { createAuthClient } from 'better-auth/svelte';
import { organizationClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
	plugins: [organizationClient()]
});
```

- [ ] **Step 3: Verify it type-checks**

Run: `bun run check`
Expected: PASS — no errors in `auth.ts` / `auth-client.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/server/auth.ts src/lib/auth-client.ts
git commit -m "feat: enable better-auth organization plugin"
```

---

## Task 4: Slug utility (TDD)

**Files:**
- Create: `src/lib/server/slug.ts`
- Test: `src/lib/server/slug.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/server/slug.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { slugify, resolveSlug } from './slug';

describe('slugify', () => {
	it('lowercases and hyphenates', () => {
		expect(slugify('Mon Équipe')).toBe('mon-equipe');
	});

	it('strips punctuation and collapses spaces', () => {
		expect(slugify('  Hello, World!!  ')).toBe('hello-world');
	});

	it('falls back to "team" when empty', () => {
		expect(slugify('!!!')).toBe('team');
	});
});

describe('resolveSlug', () => {
	it('returns the base slug when free', async () => {
		const exists = async () => false;
		expect(await resolveSlug('Acme', exists)).toBe('acme');
	});

	it('appends -2 when the base is taken', async () => {
		const taken = new Set(['acme']);
		const exists = async (s: string) => taken.has(s);
		expect(await resolveSlug('Acme', exists)).toBe('acme-2');
	});

	it('increments until a free slug is found', async () => {
		const taken = new Set(['acme', 'acme-2', 'acme-3']);
		const exists = async (s: string) => taken.has(s);
		expect(await resolveSlug('Acme', exists)).toBe('acme-4');
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:unit -- --run src/lib/server/slug.test.ts`
Expected: FAIL — cannot resolve `./slug`.

- [ ] **Step 3: Implement the util**

Create `src/lib/server/slug.ts`:

```typescript
export function slugify(name: string): string {
	const slug = name
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || 'team';
}

export async function resolveSlug(
	name: string,
	exists: (slug: string) => Promise<boolean>
): Promise<string> {
	const base = slugify(name);
	if (!(await exists(base))) return base;
	let n = 2;
	while (await exists(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:unit -- --run src/lib/server/slug.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/slug.ts src/lib/server/slug.test.ts
git commit -m "feat: add slug utility"
```

---

## Task 5: Zod schemas (TDD)

**Files:**
- Create: `src/lib/schemas/teams.ts`
- Test: `src/lib/schemas/teams.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/schemas/teams.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createTeamSchema, inviteSchema } from './teams';

describe('createTeamSchema', () => {
	it('accepts a valid name', () => {
		expect(createTeamSchema.safeParse({ name: 'Acme' }).success).toBe(true);
	});

	it('rejects a name shorter than 2 chars', () => {
		expect(createTeamSchema.safeParse({ name: 'A' }).success).toBe(false);
	});
});

describe('inviteSchema', () => {
	it('accepts a valid email and role', () => {
		expect(inviteSchema.safeParse({ email: 'a@b.com', role: 'member' }).success).toBe(true);
	});

	it('rejects an invalid email', () => {
		expect(inviteSchema.safeParse({ email: 'nope', role: 'member' }).success).toBe(false);
	});

	it('rejects an unknown role', () => {
		expect(inviteSchema.safeParse({ email: 'a@b.com', role: 'owner' }).success).toBe(false);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:unit -- --run src/lib/schemas/teams.test.ts`
Expected: FAIL — cannot resolve `./teams`.

- [ ] **Step 3: Implement the schemas**

Create `src/lib/schemas/teams.ts`:

```typescript
import { z } from 'zod';

export const createTeamSchema = z.object({
	name: z.string().min(2, 'Team name must be at least 2 characters')
});

export const inviteSchema = z.object({
	email: z.string().email('Invalid email address'),
	role: z.enum(['admin', 'member'])
});

export type CreateTeamSchema = typeof createTeamSchema;
export type InviteSchema = typeof inviteSchema;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:unit -- --run src/lib/schemas/teams.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/schemas/teams.ts src/lib/schemas/teams.test.ts
git commit -m "feat: add team zod schemas"
```

---

## Task 6: Remote queries

**Files:**
- Create: `src/routes/(app)/teams/teams.remote.ts`

- [ ] **Step 1: Implement the read queries**

Create `src/routes/(app)/teams/teams.remote.ts`:

```typescript
import { query, getRequestEvent } from '$app/server';
import { z } from 'zod';
import { error } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';

function requireHeaders() {
	const { request, locals } = getRequestEvent();
	if (!locals.session) error(401, 'Not authenticated');
	return request.headers;
}

export const listMyTeams = query(async () => {
	const headers = requireHeaders();
	const [teams, session] = await Promise.all([
		auth.api.listOrganizations({ headers }),
		auth.api.getSession({ headers })
	]);
	return {
		teams,
		activeOrganizationId: session?.session.activeOrganizationId ?? null
	};
});

export const getTeam = query(z.string(), async (slug) => {
	const headers = requireHeaders();
	const org = await auth.api.getFullOrganization({
		query: { organizationSlug: slug },
		headers
	});
	if (!org) error(404, 'Team not found');
	const invitations = await auth.api.listInvitations({
		query: { organizationId: org.id },
		headers
	});
	return {
		org,
		pendingInvitations: invitations.filter((i) => i.status === 'pending')
	};
});
```

- [ ] **Step 2: Verify it type-checks**

Run: `bun run check`
Expected: PASS — no errors in `teams.remote.ts`.

- [ ] **Step 3: Commit**

```bash
git add "src/routes/(app)/teams/teams.remote.ts"
git commit -m "feat: add team read queries"
```

---

## Task 7: Remote commands

**Files:**
- Modify: `src/routes/(app)/teams/teams.remote.ts`

- [ ] **Step 1: Add command imports**

At the top of `src/routes/(app)/teams/teams.remote.ts`, change the `$app/server` import line to:

```typescript
import { query, command, getRequestEvent } from '$app/server';
```

- [ ] **Step 2: Add the schema imports**

Add below the existing imports:

```typescript
import { createTeamSchema, inviteSchema } from '$lib/schemas/teams';
import { resolveSlug } from '$lib/server/slug';
import { prisma } from '$lib/server/prisma';
```

- [ ] **Step 3: Append the commands**

Append to `src/routes/(app)/teams/teams.remote.ts`:

```typescript
export const createTeam = command(createTeamSchema, async ({ name }) => {
	const headers = requireHeaders();
	const slug = await resolveSlug(
		name,
		async (s) => (await prisma.organization.findUnique({ where: { slug: s } })) !== null
	);
	const org = await auth.api.createOrganization({ body: { name, slug }, headers });
	await listMyTeams().refresh();
	return { slug: org?.slug ?? slug };
});

export const inviteMember = command(
	inviteSchema.extend({ organizationId: z.string() }),
	async ({ email, role, organizationId }) => {
		const headers = requireHeaders();
		const invitation = await auth.api.createInvitation({
			body: { email, role, organizationId },
			headers
		});
		return { invitationId: invitation.id };
	}
);

export const acceptInvitation = command(z.string(), async (invitationId) => {
	const headers = requireHeaders();
	await auth.api.acceptInvitation({ body: { invitationId }, headers });
	await listMyTeams().refresh();
});

export const cancelInvitation = command(z.string(), async (invitationId) => {
	const headers = requireHeaders();
	await auth.api.cancelInvitation({ body: { invitationId }, headers });
});

export const setActiveTeam = command(z.string(), async (organizationId) => {
	const headers = requireHeaders();
	await auth.api.setActiveOrganization({ body: { organizationId }, headers });
	await listMyTeams().refresh();
});

export const removeMember = command(
	z.object({ organizationId: z.string(), memberIdOrEmail: z.string() }),
	async ({ organizationId, memberIdOrEmail }) => {
		const headers = requireHeaders();
		await auth.api.removeMember({ body: { organizationId, memberIdOrEmail }, headers });
	}
);
```

- [ ] **Step 4: Verify it type-checks**

Run: `bun run check`
Expected: PASS — no errors in `teams.remote.ts`.

- [ ] **Step 5: Commit**

```bash
git add "src/routes/(app)/teams/teams.remote.ts"
git commit -m "feat: add team mutation commands"
```

---

## Task 8: Teams list + create page

**Files:**
- Create: `src/routes/(app)/teams/+page.svelte`

- [ ] **Step 1: Implement the page**

Create `src/routes/(app)/teams/+page.svelte`:

```svelte
<script lang="ts">
	import { superForm, defaults } from 'sveltekit-superforms';
	import { zod4Client as zodClient } from 'sveltekit-superforms/adapters';
	import { createTeamSchema } from '$lib/schemas/teams';
	import { listMyTeams, createTeam } from './teams.remote';
	import { goto } from '$app/navigation';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import * as Alert from '$lib/components/ui/alert';

	let createError = $state<string | null>(null);
	let loading = $state(false);

	const { form, errors, enhance } = superForm(defaults(zodClient(createTeamSchema)), {
		SPA: true,
		validators: zodClient(createTeamSchema),
		async onUpdate({ form }) {
			if (!form.valid) return;
			createError = null;
			loading = true;
			try {
				const { slug } = await createTeam({ name: form.data.name });
				goto(`/teams/${slug}`);
			} catch (e) {
				createError = e instanceof Error ? e.message : 'Could not create team';
			} finally {
				loading = false;
			}
		}
	});
</script>

<div class="mx-auto max-w-2xl space-y-6 p-6">
	<Card.Root>
		<Card.Header>
			<Card.Title>Create a team</Card.Title>
			<Card.Description>Give your team a name. You become its owner.</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#if createError}
				<Alert.Root variant="destructive"><Alert.Description>{createError}</Alert.Description></Alert.Root>
			{/if}
			<form use:enhance class="flex items-end gap-2">
				<div class="flex-1 space-y-2">
					<Label for="name">Team name</Label>
					<Input id="name" name="name" bind:value={$form.name} aria-invalid={$errors.name ? 'true' : undefined} />
					{#if $errors.name}<p class="text-sm text-destructive">{$errors.name}</p>{/if}
				</div>
				<Button type="submit" disabled={loading}>{loading ? 'Creating…' : 'Create'}</Button>
			</form>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header><Card.Title>My teams</Card.Title></Card.Header>
		<Card.Content>
			{#await listMyTeams()}
				<p class="text-sm text-muted-foreground">Loading…</p>
			{:then { teams, activeOrganizationId }}
				{#if teams.length === 0}
					<p class="text-sm text-muted-foreground">You don't belong to any team yet.</p>
				{:else}
					<ul class="space-y-2">
						{#each teams as team (team.id)}
							<li class="flex items-center justify-between rounded border p-3">
								<a href={`/teams/${team.slug}`} class="font-medium underline-offset-4 hover:underline">
									{team.name}
								</a>
								{#if team.id === activeOrganizationId}
									<span class="text-xs text-muted-foreground">Active</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			{/await}
		</Card.Content>
	</Card.Root>
</div>
```

- [ ] **Step 2: Verify it type-checks and autofixes**

Run: `bun run check`
Expected: PASS — no errors in `teams/+page.svelte`.

Then run the Svelte MCP `svelte-autofixer` on this file's contents and apply any fixes it returns until it reports no issues.

- [ ] **Step 3: Manually verify in the browser**

Run: `bun run dev`, log in, visit `/teams`, create a team named "Acme". Expected: redirect to `/teams/acme`, and "Acme" appears under "My teams".

- [ ] **Step 4: Commit**

```bash
git add "src/routes/(app)/teams/+page.svelte"
git commit -m "feat: add teams list and create page"
```

---

## Task 9: Team detail page (members + invitations)

**Files:**
- Create: `src/routes/(app)/teams/[slug]/+page.svelte`

- [ ] **Step 1: Implement the page**

Create `src/routes/(app)/teams/[slug]/+page.svelte`:

```svelte
<script lang="ts">
	import { page } from '$app/state';
	import { superForm, defaults } from 'sveltekit-superforms';
	import { zod4Client as zodClient } from 'sveltekit-superforms/adapters';
	import { inviteSchema } from '$lib/schemas/teams';
	import { getTeam, inviteMember, cancelInvitation, removeMember } from '../teams.remote';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import * as Alert from '$lib/components/ui/alert';

	const slug = $derived(page.params.slug);
	let inviteError = $state<string | null>(null);
	let lastLink = $state<string | null>(null);
	let loading = $state(false);

	const { form, errors, enhance } = superForm(defaults(zodClient(inviteSchema)), {
		SPA: true,
		validators: zodClient(inviteSchema),
		async onUpdate({ form }) {
			if (!form.valid) return;
			const { org } = await getTeam(slug);
			inviteError = null;
			loading = true;
			try {
				const { invitationId } = await inviteMember({
					email: form.data.email,
					role: form.data.role,
					organizationId: org.id
				});
				lastLink = `${location.origin}/accept-invitation/${invitationId}`;
				await getTeam(slug).refresh();
			} catch (e) {
				inviteError = e instanceof Error ? e.message : 'Could not send invitation';
			} finally {
				loading = false;
			}
		}
	});

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
	}
</script>

{#await getTeam(slug)}
	<p class="p-6 text-sm text-muted-foreground">Loading…</p>
{:then { org, pendingInvitations }}
	<div class="mx-auto max-w-3xl space-y-6 p-6">
		<h1 class="text-2xl font-semibold">{org.name}</h1>

		<Card.Root>
			<Card.Header><Card.Title>Members</Card.Title></Card.Header>
			<Card.Content>
				<ul class="space-y-2">
					{#each org.members as member (member.id)}
						<li class="flex items-center justify-between rounded border p-3">
							<span>{member.user?.email ?? member.user?.name} · <span class="text-muted-foreground">{member.role}</span></span>
							{#if member.role !== 'owner'}
								<Button variant="outline" onclick={async () => { await removeMember({ organizationId: org.id, memberIdOrEmail: member.id }); await getTeam(slug).refresh(); }}>
									Remove
								</Button>
							{/if}
						</li>
					{/each}
				</ul>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Invite someone</Card.Title>
				<Card.Description>They must sign in with this email to accept.</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				{#if inviteError}
					<Alert.Root variant="destructive"><Alert.Description>{inviteError}</Alert.Description></Alert.Root>
				{/if}
				<form use:enhance class="space-y-3">
					<div class="space-y-2">
						<Label for="email">Email</Label>
						<Input id="email" name="email" type="email" bind:value={$form.email} aria-invalid={$errors.email ? 'true' : undefined} />
						{#if $errors.email}<p class="text-sm text-destructive">{$errors.email}</p>{/if}
					</div>
					<div class="space-y-2">
						<Label for="role">Role</Label>
						<select id="role" name="role" bind:value={$form.role} class="w-full rounded border bg-background p-2">
							<option value="member">Member</option>
							<option value="admin">Admin</option>
						</select>
					</div>
					<Button type="submit" disabled={loading}>{loading ? 'Inviting…' : 'Invite'}</Button>
				</form>

				{#if lastLink}
					<Alert.Root>
						<Alert.Description class="flex items-center gap-2">
							<code class="truncate text-xs">{lastLink}</code>
							<Button variant="outline" onclick={() => copy(lastLink!)}>Copy link</Button>
						</Alert.Description>
					</Alert.Root>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header><Card.Title>Pending invitations</Card.Title></Card.Header>
			<Card.Content>
				{#if pendingInvitations.length === 0}
					<p class="text-sm text-muted-foreground">No pending invitations.</p>
				{:else}
					<ul class="space-y-2">
						{#each pendingInvitations as inv (inv.id)}
							<li class="flex items-center justify-between rounded border p-3">
								<span>{inv.email} · <span class="text-muted-foreground">{inv.role}</span></span>
								<div class="flex gap-2">
									<Button variant="outline" onclick={() => copy(`${location.origin}/accept-invitation/${inv.id}`)}>Copy link</Button>
									<Button variant="outline" onclick={async () => { await cancelInvitation(inv.id); await getTeam(slug).refresh(); }}>Cancel</Button>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
{:catch e}
	<p class="p-6 text-sm text-destructive">{e.message}</p>
{/await}
```

- [ ] **Step 2: Verify it type-checks and autofixes**

Run: `bun run check`
Expected: PASS — no errors in `teams/[slug]/+page.svelte`.

Then run the Svelte MCP `svelte-autofixer` on this file and apply fixes until it reports no issues.

- [ ] **Step 3: Manually verify in the browser**

With `bun run dev` running, open the team created in Task 8, invite `someone@example.com` as Member. Expected: a copyable accept link appears and the invitation shows under "Pending invitations".

- [ ] **Step 4: Commit**

```bash
git add "src/routes/(app)/teams/[slug]/+page.svelte"
git commit -m "feat: add team detail page with members and invitations"
```

---

## Task 10: Accept-invitation page

**Files:**
- Create: `src/routes/(app)/accept-invitation/[id]/+page.svelte`

- [ ] **Step 1: Implement the page**

Create `src/routes/(app)/accept-invitation/[id]/+page.svelte`:

```svelte
<script lang="ts">
	import { page } from '$app/state';
	import { acceptInvitation } from '../../teams/teams.remote';
	import { goto } from '$app/navigation';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import * as Alert from '$lib/components/ui/alert';

	const id = $derived(page.params.id);
	let errorMsg = $state<string | null>(null);
	let loading = $state(false);

	async function accept() {
		errorMsg = null;
		loading = true;
		try {
			await acceptInvitation(id);
			goto('/teams');
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : 'Could not accept this invitation';
			loading = false;
		}
	}
</script>

<div class="flex min-h-screen items-center justify-center">
	<Card.Root class="w-full max-w-md">
		<Card.Header>
			<Card.Title>Join team</Card.Title>
			<Card.Description>Accept this invitation to join the team.</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#if errorMsg}
				<Alert.Root variant="destructive"><Alert.Description>{errorMsg}</Alert.Description></Alert.Root>
			{/if}
			<Button class="w-full" disabled={loading} onclick={accept}>
				{loading ? 'Accepting…' : 'Accept invitation'}
			</Button>
		</Card.Content>
	</Card.Root>
</div>
```

Note: this route lives under `(app)`, so the existing `(app)/+layout.server.ts` already redirects unauthenticated users to `/login`. If a user signs in with a non-matching email, `acceptInvitation` throws and the error renders in the alert.

- [ ] **Step 2: Verify it type-checks and autofixes**

Run: `bun run check`
Expected: PASS. Then run `svelte-autofixer` and apply fixes until clean.

- [ ] **Step 3: Commit**

```bash
git add "src/routes/(app)/accept-invitation/[id]/+page.svelte"
git commit -m "feat: add accept-invitation page"
```

---

## Task 11: Active-team dropdown in layout

**Files:**
- Create: `src/routes/(app)/+layout.svelte`

- [ ] **Step 1: Implement the layout with the dropdown**

Create `src/routes/(app)/+layout.svelte`:

```svelte
<script lang="ts">
	import { listMyTeams, setActiveTeam } from './teams/teams.remote';
	import { invalidateAll } from '$app/navigation';

	let { children } = $props();

	async function onChange(e: Event) {
		const id = (e.currentTarget as HTMLSelectElement).value;
		if (!id) return;
		await setActiveTeam(id);
		await invalidateAll();
	}
</script>

<header class="flex items-center justify-between border-b p-4">
	<a href="/dashboard" class="font-semibold">dotWeaver</a>
	{#await listMyTeams() then { teams, activeOrganizationId }}
		{#if teams.length > 0}
			<select onchange={onChange} value={activeOrganizationId ?? ''} class="rounded border bg-background p-2 text-sm">
				<option value="" disabled>Select a team</option>
				{#each teams as team (team.id)}
					<option value={team.id}>{team.name}</option>
				{/each}
			</select>
		{:else}
			<a href="/teams" class="text-sm underline underline-offset-4">Create a team</a>
		{/if}
	{/await}
</header>

{@render children()}
```

- [ ] **Step 2: Verify it type-checks and autofixes**

Run: `bun run check`
Expected: PASS. Then run `svelte-autofixer` and apply fixes until clean.

- [ ] **Step 3: Manually verify in the browser**

With two teams created, confirm the dropdown shows both, with the active one pre-selected, and switching updates the selection.

- [ ] **Step 4: Commit**

```bash
git add "src/routes/(app)/+layout.svelte"
git commit -m "feat: add active-team dropdown to app layout"
```

---

## Task 12: End-to-end flow (optional)

**Files:**
- Create: `e2e/teams.spec.ts`

- [ ] **Step 1: Write the e2e test**

Create `e2e/teams.spec.ts` (adapt the login helper to the project's existing auth e2e pattern if one exists; otherwise register two users in the test):

```typescript
import { expect, test } from '@playwright/test';

test('owner can create a team and generate an invite link', async ({ page }) => {
	// Assumes a logged-in session helper or a registered user; see existing e2e setup.
	await page.goto('/teams');
	await page.getByLabel('Team name').fill('E2E Team');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page).toHaveURL(/\/teams\/e2e-team/);

	await page.getByLabel('Email').fill('invitee@example.com');
	await page.getByRole('button', { name: 'Invite' }).click();
	await expect(page.getByText('/accept-invitation/')).toBeVisible();
});
```

- [ ] **Step 2: Run the e2e test**

Run: `bun run test:e2e -- e2e/teams.spec.ts`
Expected: PASS (or document the auth-setup dependency if the project lacks an e2e login helper).

- [ ] **Step 3: Commit**

```bash
git add e2e/teams.spec.ts
git commit -m "test: e2e team creation and invite flow"
```

---

## Final verification

- [ ] Run full unit suite: `bun run test:unit -- --run` → PASS
- [ ] Run type/lint check: `bun run check && bun run lint` → PASS
- [ ] Manual smoke: create team → invite → copy link → accept with a second account in another browser/profile → invitee appears as member, switch active team works.
