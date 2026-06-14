# Page Connecteurs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `/settings/connectors` page where a user connects/disconnects GitHub and Google (Gmail), sees each connection's status, and manages GitHub org access.

**Architecture:** Pure status/URL logic lives in `src/lib/server/connectors.ts` (unit-tested in isolation). A `connectors.remote.ts` exposes one `query` (status) and two `command`s (disconnect github/google) following the existing `*.remote.ts` pattern with `requireHeaders()` + `auth.api`. Connections (OAuth redirects) stay client-side via `authClient.linkSocial`. UI is a `ConnectorCard.svelte` rendered on the page, with an `AlertDialog` confirmation for disconnect.

**Tech Stack:** SvelteKit (Svelte 5 runes), better-auth, Prisma, shadcn-svelte (bits-ui), Tailwind v4, Lucide icons, Vitest + vitest-browser-svelte.

---

## File Structure

- Create `src/lib/server/connectors.ts` — pure logic: `computeConnectorStatus`, `buildGithubOrgAccessUrl`, plus `purgeGmailData(userId)`.
- Create `src/lib/rfc/connectors.remote.ts` — `listConnectors` query, `disconnectGithub` / `disconnectGoogle` commands.
- Create `src/lib/components/connectors/ConnectorCard.svelte` — presentational card (status badge + actions).
- Create `src/routes/(app)/settings/connectors/+page.svelte` — the page wiring query + cards + confirm dialog.
- Modify `src/routes/(app)/+layout.svelte` — add "Settings" nav link.
- Modify `src/routes/(app)/mail/+page.svelte` — replace inline Google connect with a link to `/settings/connectors`.
- Add shadcn components `badge` and `alert-dialog`.
- Tests: `tests/unit/lib/server/connectors.test.ts`, `tests/unit/lib/components/connector-card.svelte.test.ts`.

---

### Task 1: Pure connector status logic

**Files:**
- Create: `src/lib/server/connectors.ts`
- Test: `tests/unit/lib/server/connectors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lib/server/connectors.test.ts
import { describe, it, expect } from 'vitest';
import { computeConnectorStatus, buildGithubOrgAccessUrl } from '$lib/server/connectors';
import { GMAIL_READONLY_SCOPE } from '$lib/constants/mail';

describe('computeConnectorStatus', () => {
	it('reports both providers connected with gmail scope', () => {
		const status = computeConnectorStatus(
			[
				{ providerId: 'github', scopes: ['repo'] },
				{ providerId: 'google', scopes: ['openid', GMAIL_READONLY_SCOPE] }
			],
			GMAIL_READONLY_SCOPE
		);
		expect(status.github.connected).toBe(true);
		expect(status.google.connected).toBe(true);
		expect(status.google.hasGmailScope).toBe(true);
		expect(status.google.needsReconnect).toBe(false);
	});

	it('flags google needsReconnect when gmail scope is missing', () => {
		const status = computeConnectorStatus(
			[{ providerId: 'google', scopes: ['openid', 'email'] }],
			GMAIL_READONLY_SCOPE
		);
		expect(status.google.connected).toBe(true);
		expect(status.google.hasGmailScope).toBe(false);
		expect(status.google.needsReconnect).toBe(true);
	});

	it('blocks disconnect when a provider is the only login method', () => {
		const status = computeConnectorStatus([{ providerId: 'github', scopes: ['repo'] }], GMAIL_READONLY_SCOPE);
		expect(status.github.connected).toBe(true);
		expect(status.github.canDisconnect).toBe(false);
		expect(status.hasPassword).toBe(false);
	});

	it('allows disconnect when a password login also exists', () => {
		const status = computeConnectorStatus(
			[
				{ providerId: 'credential', scopes: [] },
				{ providerId: 'github', scopes: ['repo'] }
			],
			GMAIL_READONLY_SCOPE
		);
		expect(status.hasPassword).toBe(true);
		expect(status.github.canDisconnect).toBe(true);
	});

	it('allows disconnect when another social login also exists', () => {
		const status = computeConnectorStatus(
			[
				{ providerId: 'github', scopes: ['repo'] },
				{ providerId: 'google', scopes: [GMAIL_READONLY_SCOPE] }
			],
			GMAIL_READONLY_SCOPE
		);
		expect(status.github.canDisconnect).toBe(true);
		expect(status.google.canDisconnect).toBe(true);
	});

	it('marks disconnected providers as not connected and not disconnectable', () => {
		const status = computeConnectorStatus([{ providerId: 'credential', scopes: [] }], GMAIL_READONLY_SCOPE);
		expect(status.github.connected).toBe(false);
		expect(status.github.canDisconnect).toBe(false);
		expect(status.google.connected).toBe(false);
	});
});

describe('buildGithubOrgAccessUrl', () => {
	it('builds the OAuth app connections URL from the client id', () => {
		expect(buildGithubOrgAccessUrl('abc123')).toBe(
			'https://github.com/settings/connections/applications/abc123'
		);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- --run tests/unit/lib/server/connectors.test.ts`
Expected: FAIL — `Cannot find module '$lib/server/connectors'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/server/connectors.ts
export interface AccountInfo {
	providerId: string;
	scopes: string[];
}

export interface ProviderStatus {
	connected: boolean;
	canDisconnect: boolean;
}

export interface GoogleStatus extends ProviderStatus {
	hasGmailScope: boolean;
	needsReconnect: boolean;
}

export interface ConnectorStatus {
	github: ProviderStatus;
	google: GoogleStatus;
	hasPassword: boolean;
}

/** Une déconnexion n'est permise que s'il reste >= 1 méthode de login après retrait. */
function canDisconnect(connected: boolean, loginCount: number): boolean {
	return connected && loginCount > 1;
}

export function computeConnectorStatus(accounts: AccountInfo[], gmailScope: string): ConnectorStatus {
	const loginCount = accounts.length;
	const github = accounts.find((a) => a.providerId === 'github');
	const google = accounts.find((a) => a.providerId === 'google');
	const hasGmailScope = Boolean(google?.scopes.includes(gmailScope));

	return {
		github: {
			connected: Boolean(github),
			canDisconnect: canDisconnect(Boolean(github), loginCount)
		},
		google: {
			connected: Boolean(google),
			hasGmailScope,
			needsReconnect: Boolean(google) && !hasGmailScope,
			canDisconnect: canDisconnect(Boolean(google), loginCount)
		},
		hasPassword: accounts.some((a) => a.providerId === 'credential')
	};
}

export function buildGithubOrgAccessUrl(clientId: string): string {
	return `https://github.com/settings/connections/applications/${clientId}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- --run tests/unit/lib/server/connectors.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/connectors.ts tests/unit/lib/server/connectors.test.ts
git commit -m "feat(connectors): add pure connector status logic"
```

---

### Task 2: Gmail data purge helper

**Files:**
- Modify: `src/lib/server/connectors.ts`
- Test: `tests/unit/lib/server/connectors.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/lib/server/connectors.test.ts`:

```ts
import { vi } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		mailThread: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
		mailSyncState: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) }
	}
}));

describe('purgeGmailData', () => {
	it('deletes mail threads and sync state scoped to the user', async () => {
		const { purgeGmailData } = await import('$lib/server/connectors');
		const { prisma } = await import('$lib/server/prisma');
		await purgeGmailData('user_1');
		expect(prisma.mailThread.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user_1' } });
		expect(prisma.mailSyncState.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user_1' } });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- --run tests/unit/lib/server/connectors.test.ts`
Expected: FAIL — `purgeGmailData is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/lib/server/connectors.ts`:

```ts
import { prisma } from '$lib/server/prisma';

/** Supprime toutes les données Gmail synchronisées d'un utilisateur (threads + état de sync). */
export async function purgeGmailData(userId: string): Promise<void> {
	await prisma.$transaction([
		prisma.mailThread.deleteMany({ where: { userId } }),
		prisma.mailSyncState.deleteMany({ where: { userId } })
	]);
}
```

Note: the test mock above does not implement `$transaction`. Update the mock in Step 1's `vi.mock` to:

```ts
vi.mock('$lib/server/prisma', () => {
	const mailThread = { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) };
	const mailSyncState = { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) };
	return {
		prisma: {
			mailThread,
			mailSyncState,
			$transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops))
		}
	};
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- --run tests/unit/lib/server/connectors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/connectors.ts tests/unit/lib/server/connectors.test.ts
git commit -m "feat(connectors): add gmail data purge helper"
```

---

### Task 3: Remote functions (status query + disconnect commands)

**Files:**
- Create: `src/lib/rfc/connectors.remote.ts`

This task wires the pure logic to better-auth. No new unit test (the pure logic is already covered; remote functions need a live request event). Verify with `svelte-check`.

- [ ] **Step 1: Implement the remote module**

```ts
// src/lib/rfc/connectors.remote.ts
import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { auth } from '$lib/server/auth';
import { requireHeaders } from '$lib/server/utils';
import { GMAIL_READONLY_SCOPE } from '$lib/constants/mail';
import {
	buildGithubOrgAccessUrl,
	computeConnectorStatus,
	purgeGmailData,
	type AccountInfo
} from '$lib/server/connectors';

function normalizeScopes(scopes: unknown): string[] {
	if (Array.isArray(scopes)) return scopes as string[];
	if (typeof scopes === 'string') return scopes.split(/[ ,]+/).filter(Boolean);
	return [];
}

export const listConnectors = query(async () => {
	const headers = requireHeaders();
	const accounts = await auth.api.listUserAccounts({ headers });
	const normalized: AccountInfo[] = accounts.map((a) => ({
		providerId: a.providerId,
		scopes: normalizeScopes((a as { scopes?: unknown }).scopes)
	}));
	const status = computeConnectorStatus(normalized, GMAIL_READONLY_SCOPE);
	return {
		...status,
		githubOrgAccessUrl: buildGithubOrgAccessUrl(env.GITHUB_CLIENT_ID ?? '')
	};
});

export const disconnectGithub = command(async () => {
	const headers = requireHeaders();
	const accounts = await auth.api.listUserAccounts({ headers });
	if (accounts.length <= 1) error(400, 'Impossible de déconnecter votre seule méthode de connexion.');
	await auth.api.unlinkAccount({ body: { providerId: 'github' }, headers });
	await listConnectors().refresh();
	return { ok: true as const };
});

export const disconnectGoogle = command(async () => {
	const headers = requireHeaders();
	const session = await auth.api.getSession({ headers });
	if (!session?.user) error(401, 'Not authenticated');
	const accounts = await auth.api.listUserAccounts({ headers });
	if (accounts.length <= 1) error(400, 'Impossible de déconnecter votre seule méthode de connexion.');
	// Purge avant unlink : l'op reste rejouable si l'unlink échoue.
	await purgeGmailData(session.user.id);
	await auth.api.unlinkAccount({ body: { providerId: 'google' }, headers });
	await listConnectors().refresh();
	return { ok: true as const };
});
```

- [ ] **Step 2: Type-check**

Run: `bun run check`
Expected: no new errors referencing `connectors.remote.ts`. If `unlinkAccount`/`listUserAccounts` body shapes mismatch the installed better-auth version, adjust to match the type error (the method names are stable; only the `body` wrapper may differ).

- [ ] **Step 3: Commit**

```bash
git add src/lib/rfc/connectors.remote.ts
git commit -m "feat(connectors): add status query and disconnect commands"
```

---

### Task 4: Add shadcn badge + alert-dialog components

**Files:**
- Create (via CLI): `src/lib/components/ui/badge/*`, `src/lib/components/ui/alert-dialog/*`

- [ ] **Step 1: Add the components**

Run: `bunx shadcn-svelte@latest add badge alert-dialog`
Expected: new folders under `src/lib/components/ui/badge` and `src/lib/components/ui/alert-dialog` with `index.ts` exports.

- [ ] **Step 2: Verify they import cleanly**

Run: `bun run check`
Expected: no errors from the new component folders.

- [ ] **Step 3: Commit**

```bash
git add src/lib/components/ui/badge src/lib/components/ui/alert-dialog
git commit -m "chore(ui): add badge and alert-dialog components"
```

---

### Task 5: ConnectorCard component

**Files:**
- Create: `src/lib/components/connectors/ConnectorCard.svelte`
- Test: `tests/unit/lib/components/connector-card.svelte.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lib/components/connector-card.svelte.test.ts
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ConnectorCard from '$lib/components/connectors/ConnectorCard.svelte';

describe('ConnectorCard', () => {
	it('shows a connected badge', async () => {
		const screen = render(ConnectorCard, {
			name: 'GitHub',
			status: 'connected',
			actionLabel: 'Déconnecter'
		});
		await expect.element(screen.getByText('Connecté')).toBeInTheDocument();
	});

	it('shows a reconnect badge', async () => {
		const screen = render(ConnectorCard, {
			name: 'Google',
			status: 'needs_reconnect',
			actionLabel: 'Reconnecter'
		});
		await expect.element(screen.getByText('Reconnexion requise')).toBeInTheDocument();
	});

	it('shows a disconnected badge', async () => {
		const screen = render(ConnectorCard, {
			name: 'GitHub',
			status: 'disconnected',
			actionLabel: 'Connecter'
		});
		await expect.element(screen.getByText('Non connecté')).toBeInTheDocument();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- --run tests/unit/lib/components/connector-card.svelte.test.ts`
Expected: FAIL — cannot find `ConnectorCard.svelte`.

- [ ] **Step 3: Write minimal implementation**

```svelte
<!-- src/lib/components/connectors/ConnectorCard.svelte -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';

	type Status = 'connected' | 'disconnected' | 'needs_reconnect';

	let {
		name,
		status,
		description,
		icon,
		actions
	}: {
		name: string;
		status: Status;
		description?: string;
		icon?: Snippet;
		actions?: Snippet;
	} = $props();

	const badge = {
		connected: { label: 'Connecté', variant: 'default' as const },
		needs_reconnect: { label: 'Reconnexion requise', variant: 'secondary' as const },
		disconnected: { label: 'Non connecté', variant: 'outline' as const }
	};
</script>

<Card.Root>
	<Card.Header>
		<div class="flex items-center justify-between gap-3">
			<div class="flex items-center gap-3">
				{#if icon}{@render icon()}{/if}
				<Card.Title>{name}</Card.Title>
			</div>
			<Badge variant={badge[status].variant}>{badge[status].label}</Badge>
		</div>
		{#if description}
			<Card.Description>{description}</Card.Description>
		{/if}
	</Card.Header>
	{#if actions}
		<Card.Content class="flex flex-wrap gap-2">
			{@render actions()}
		</Card.Content>
	{/if}
</Card.Root>
```

Note: the test passes `actionLabel` but the component uses an `actions` snippet — update the test to assert only on the badge text (already the case) and drop the unused `actionLabel` prop from the render calls. Final render calls in the test should pass only `name` and `status` (plus optional `description`).

- [ ] **Step 4: Run the Svelte autofixer**

Use the `mcp__svelte__svelte-autofixer` tool on `ConnectorCard.svelte`. Apply fixes until it returns no issues.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test:unit -- --run tests/unit/lib/components/connector-card.svelte.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/components/connectors/ConnectorCard.svelte tests/unit/lib/components/connector-card.svelte.test.ts
git commit -m "feat(connectors): add ConnectorCard component"
```

---

### Task 6: Connectors page

**Files:**
- Create: `src/routes/(app)/settings/connectors/+page.svelte`

- [ ] **Step 1: Implement the page**

```svelte
<!-- src/routes/(app)/settings/connectors/+page.svelte -->
<script lang="ts">
	import { Github, Mail, ExternalLink } from '@lucide/svelte';
	import { authClient } from '$lib/auth-client';
	import { Button } from '$lib/components/ui/button';
	import * as Alert from '$lib/components/ui/alert';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import ConnectorCard from '$lib/components/connectors/ConnectorCard.svelte';
	import { GMAIL_READONLY_SCOPE } from '$lib/constants/mail';
	import { listConnectors, disconnectGithub, disconnectGoogle } from '$lib/rfc/connectors.remote';

	const connectors = listConnectors();
	let actionError = $state<string | null>(null);
	let pending = $state(false);

	const CALLBACK = '/settings/connectors';

	async function connectGithub() {
		actionError = null;
		await authClient.linkSocial({ provider: 'github', scopes: ['repo'], callbackURL: CALLBACK });
	}

	async function connectGoogle() {
		actionError = null;
		await authClient.linkSocial({
			provider: 'google',
			scopes: [GMAIL_READONLY_SCOPE],
			callbackURL: CALLBACK
		});
	}

	async function runDisconnect(fn: () => Promise<{ ok: true }>) {
		actionError = null;
		pending = true;
		try {
			await fn();
			await connectors.refresh();
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Échec de la déconnexion.';
		} finally {
			pending = false;
		}
	}
</script>

<div class="mx-auto max-w-2xl space-y-6 p-6">
	<div>
		<h1 class="text-2xl font-semibold">Connecteurs</h1>
		<p class="text-muted-foreground text-sm">Gérez vos comptes connectés.</p>
	</div>

	{#if actionError}
		<Alert.Root variant="destructive">
			<Alert.Description>{actionError}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if connectors.current}
		{@const c = connectors.current}

		<ConnectorCard
			name="GitHub"
			status={c.github.connected ? 'connected' : 'disconnected'}
			description="Accès à vos dépôts pour importer des projets."
		>
			{#snippet icon()}<Github class="size-5" />{/snippet}
			{#snippet actions()}
				{#if c.github.connected}
					<Button variant="outline" href={c.githubOrgAccessUrl} target="_blank" rel="noopener">
						Gérer l'accès org <ExternalLink class="ml-1 size-4" />
					</Button>
					<AlertDialog.Root>
						<AlertDialog.Trigger
							disabled={!c.github.canDisconnect || pending}
							class="text-destructive text-sm underline-offset-4 hover:underline disabled:opacity-50"
						>
							Déconnecter
						</AlertDialog.Trigger>
						<AlertDialog.Content>
							<AlertDialog.Header>
								<AlertDialog.Title>Déconnecter GitHub ?</AlertDialog.Title>
								<AlertDialog.Description>
									L'application n'aura plus accès à vos dépôts GitHub.
								</AlertDialog.Description>
							</AlertDialog.Header>
							<AlertDialog.Footer>
								<AlertDialog.Cancel>Annuler</AlertDialog.Cancel>
								<AlertDialog.Action onclick={() => runDisconnect(disconnectGithub)}>
									Déconnecter
								</AlertDialog.Action>
							</AlertDialog.Footer>
						</AlertDialog.Content>
					</AlertDialog.Root>
					{#if !c.github.canDisconnect}
						<span class="text-muted-foreground text-xs">Seule méthode de connexion.</span>
					{/if}
				{:else}
					<Button onclick={connectGithub}>Connecter GitHub</Button>
				{/if}
			{/snippet}
		</ConnectorCard>

		<ConnectorCard
			name="Google (Gmail)"
			status={c.google.needsReconnect
				? 'needs_reconnect'
				: c.google.connected
					? 'connected'
					: 'disconnected'}
			description="Lecture de vos emails dans dotWeaver."
		>
			{#snippet icon()}<Mail class="size-5" />{/snippet}
			{#snippet actions()}
				{#if c.google.connected}
					{#if c.google.needsReconnect}
						<Button onclick={connectGoogle}>Reconnecter Google</Button>
					{/if}
					<AlertDialog.Root>
						<AlertDialog.Trigger
							disabled={!c.google.canDisconnect || pending}
							class="text-destructive text-sm underline-offset-4 hover:underline disabled:opacity-50"
						>
							Déconnecter
						</AlertDialog.Trigger>
						<AlertDialog.Content>
							<AlertDialog.Header>
								<AlertDialog.Title>Déconnecter Google ?</AlertDialog.Title>
								<AlertDialog.Description>
									Vos emails synchronisés seront supprimés de dotWeaver.
								</AlertDialog.Description>
							</AlertDialog.Header>
							<AlertDialog.Footer>
								<AlertDialog.Cancel>Annuler</AlertDialog.Cancel>
								<AlertDialog.Action onclick={() => runDisconnect(disconnectGoogle)}>
									Déconnecter et supprimer
								</AlertDialog.Action>
							</AlertDialog.Footer>
						</AlertDialog.Content>
					</AlertDialog.Root>
					{#if !c.google.canDisconnect}
						<span class="text-muted-foreground text-xs">Seule méthode de connexion.</span>
					{/if}
				{:else}
					<Button onclick={connectGoogle}>Connecter Google</Button>
				{/if}
			{/snippet}
		</ConnectorCard>
	{/if}
</div>
```

- [ ] **Step 2: Run the Svelte autofixer**

Use `mcp__svelte__svelte-autofixer` on the page until it returns no issues. (If `AlertDialog.Trigger`/`Action` don't accept a raw `onclick`/`disabled`, follow the autofixer/shadcn pattern — typically wrapping a `Button` via the `child` snippet.)

- [ ] **Step 3: Type-check**

Run: `bun run check`
Expected: no errors in the new page.

- [ ] **Step 4: Commit**

```bash
git add src/routes/\(app\)/settings/connectors/+page.svelte
git commit -m "feat(connectors): add connectors settings page"
```

---

### Task 7: Add Settings nav link

**Files:**
- Modify: `src/routes/(app)/+layout.svelte:17-22`

- [ ] **Step 1: Add the link**

In the header `<div class="flex items-center gap-4">`, after the Mail link, add:

```svelte
<a href="/settings/connectors" class="text-sm font-medium hover:underline">Settings</a>
```

- [ ] **Step 2: Type-check**

Run: `bun run check`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/routes/\(app\)/+layout.svelte
git commit -m "feat(connectors): add Settings nav link"
```

---

### Task 8: Redirect Mail connect to connectors page

**Files:**
- Modify: `src/routes/(app)/mail/+page.svelte`

The mail page currently has a `connectGoogle()` that calls `linkSocial` inline (around line 51) and a "Connect Google" button (around line 212). Replace the inline action with a link to `/settings/connectors` so connections have a single source of truth.

- [ ] **Step 1: Replace the button**

Find the block rendering the Connect/Reconnect Google button (the `<Button onclick={connectGoogle}>` near line 212) and replace it with:

```svelte
<Button href="/settings/connectors">
	{threads.current.needsReconnect ? 'Reconnecter Google' : 'Connecter Google'}
</Button>
```

- [ ] **Step 2: Remove the now-unused inline handler**

Delete the `connectGoogle` function (lines ~51-57) and, if `GMAIL_READONLY_SCOPE` is no longer referenced anywhere else in the file, remove its import (line 6). Verify with a search.

Run: `grep -n "connectGoogle\|GMAIL_READONLY_SCOPE\|linkSocial" src/routes/\(app\)/mail/+page.svelte`
Expected: no remaining references (or keep the import if still used elsewhere in the file).

- [ ] **Step 3: Type-check + autofixer**

Run: `bun run check` — expected no errors.
Then run `mcp__svelte__svelte-autofixer` on the mail page until clean.

- [ ] **Step 4: Commit**

```bash
git add src/routes/\(app\)/mail/+page.svelte
git commit -m "refactor(mail): route Google connect to connectors page"
```

---

### Task 9: Full verification

- [ ] **Step 1: Run the whole unit suite**

Run: `bun run test:unit -- --run`
Expected: all tests pass, including the new connector tests.

- [ ] **Step 2: Lint + type-check**

Run: `bun run lint && bun run check`
Expected: clean.

- [ ] **Step 3: Manual smoke (dev server)**

Run: `bun run dev`, log in, visit `/settings/connectors`. Verify: GitHub/Google cards render with correct badges; "Gérer l'accès org" opens the GitHub connections page; disconnect is disabled when it is the only login method; disconnecting Google shows the purge warning.

- [ ] **Step 4: Final commit (if any cleanup)**

```bash
git add -A
git commit -m "chore(connectors): verification cleanup"
```

---

## Self-Review Notes

- **Spec coverage:** route + nav (Tasks 6,7) ✓; `listConnectors` data shape incl. `githubOrgAccessUrl`/`canDisconnect`/`needsReconnect`/`hasPassword` (Tasks 1,3) ✓; connect/reconnect via linkSocial (Task 6) ✓; disconnect commands with last-login guard + Gmail purge-before-unlink (Tasks 2,3) ✓; ConnectorCard 3-state badge + confirm dialog (Tasks 5,6) ✓; Mail page redirect (Task 8) ✓; tests (Tasks 1,2,5) ✓.
- **Known integration risk:** exact `auth.api.unlinkAccount` / `listUserAccounts` body shapes and shadcn `AlertDialog` trigger API depend on installed versions — Tasks 3 and 6 call this out and tell the implementer to follow the type error / autofixer rather than guess.
