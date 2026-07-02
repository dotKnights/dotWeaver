# Client Project Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add modular external-client permissions so client organizations and contacts can access only explicitly granted dotWeaver projects and actions.

**Architecture:** Keep Better Auth responsible for identity, sessions, and internal team membership. Add a separate `authz` domain with Prisma-backed client organizations, client memberships, invitations, grants, a TypeScript permission registry, and centralized `can`/`requirePermission` helpers used by remote functions, SSE routes, MCP tools, and UI. Preserve current internal-team behavior first, then make external-client access strictly opt-in.

**Tech Stack:** TypeScript, SvelteKit remote functions, Svelte 5 runes, Better Auth, Prisma/PostgreSQL, Zod, Tailwind v4, shadcn-svelte/Bits UI, Vitest, Playwright, Bun.

---

## Scope Check

This plan implements the approved design in `docs/superpowers/specs/2026-07-02-client-project-permissions-design.md`.

It includes:

- Prisma models for client organizations, client memberships, invitations, and access grants.
- A modular permission registry.
- A server-side authorization service.
- Project visibility for external clients.
- Permission checks for runs, diffs, project config, SSE, and MCP.
- Client/access management UI using presets.
- Unit, remote/server, component, and E2E coverage.

It intentionally does not add deny rules, internal team role refinement, open invitations, audit logs, or advanced nested client groups.

## File Structure

Create:

- `src/lib/authz/permissions.ts` -- shared permission module DSL, registry, permission constants, preset definitions, and validation helpers.
- `src/lib/authz/resources.ts` -- shared resource type definitions and helpers.
- `src/lib/schemas/client-access.ts` -- Zod schemas for client orgs, invitations, grants, and grant subjects.
- `src/lib/server/authz/actor.ts` -- loads the current actor from SvelteKit locals or by user id for MCP.
- `src/lib/server/authz/service.ts` -- central `can`, `requirePermission`, `listAccessibleProjects`, and grant validation.
- `src/lib/server/authz/runs.ts` -- run-to-project authorization helpers.
- `src/lib/server/client-access/service.ts` -- CRUD for client organizations, invitations, memberships, and project grants.
- `src/lib/rfc/client-access.remote.ts` -- remote queries/commands for client/access management.
- `src/routes/(app)/accept-client-invitation/[id]/+page.svelte` -- client invitation acceptance UI.
- `src/lib/components/clients/ClientAccessPanel.svelte` -- project access management panel.
- `src/lib/components/clients/ClientDirectory.svelte` -- team-level client organization/contact management.
- `tests/unit/lib/authz/permissions.test.ts`
- `tests/unit/lib/server/authz/service.test.ts`
- `tests/unit/lib/server/client-access/service.test.ts`
- `tests/unit/lib/rfc/client-access.remote.test.ts`
- `tests/unit/routes/client-access-panel.svelte.test.ts`
- `tests/e2e/client-access.e2e.ts`

Modify:

- `prisma/schema.prisma` -- add client/access models and relations.
- `src/lib/server/projects/service.ts` -- add actor-aware project listing and retrieval.
- `src/lib/rfc/projects.remote.ts` -- use actor-aware reads; keep imports internal-team only.
- `src/lib/rfc/runs.remote.ts` -- enforce run permissions.
- `src/lib/rfc/project-agent-config.remote.ts` -- enforce config permissions.
- `src/lib/rfc/project-environments.remote.ts` -- enforce project config/environment permissions.
- `src/lib/rfc/project-environment-services.remote.ts` -- enforce project config/service permissions.
- `src/routes/api/runs/[id]/events/+server.ts` -- enforce `run.view`.
- `src/routes/api/projects/[id]/environment/[profileId]/events/+server.ts` -- enforce `project.config.view`.
- `src/routes/api/projects/[id]/environment-services/[serviceId]/events/+server.ts` -- enforce `project.config.view`.
- `src/lib/server/mcp/context.ts` -- expose actor-aware org/project resolution helpers.
- `src/lib/server/mcp/tools.ts` -- use the new authorization helpers.
- `src/lib/rfc/teams.remote.ts` -- include client memberships/navigation context for external-only users.
- `src/routes/(app)/+layout.svelte` -- hide team switcher actions for external-only users.
- `src/lib/components/layout/AppSidebar.svelte` -- show client-safe nav.
- `src/lib/components/layout/AppTopbar.svelte` -- show client-safe nav.
- `src/routes/(app)/teams/[slug]/+page.svelte` -- render client directory for internal users.
- `src/routes/(app)/projects/[id]/+page.svelte` -- render access panel and hide unauthorized actions.
- `src/routes/(app)/projects/+page.svelte` -- show client-safe empty states and hide import for external-only users.
- `tests/mocks/rfc/remotes.ts` -- add client-access remote mocks.
- Existing route/server tests for projects, runs, config, teams, and layouts as behavior changes.

Reference docs consulted:

- Svelte MCP `kit/remote-functions` for remote `query`/`command` validation and refresh behavior.
- Svelte MCP `kit/auth`, `kit/load`, `kit/routing`, and `kit/server-only-modules` for protected app boundaries and server-only authz code.
- Svelte MCP `svelte/$state`, `svelte/$derived`, `{#if}`, `{#each}`, and `svelte/testing` for Svelte 5 UI and tests.
- Local `svelte5-best-practices` references for `$props`, `$derived`, `onclick`, and SvelteKit server/client separation.

---

### Task 1: Prisma Client Access Schema

**Files:**

- Modify: `prisma/schema.prisma`
- Generated: `prisma/migrations/<timestamp>_add_client_access/migration.sql`
- Test: `bun run prisma:generate`

- [ ] **Step 1: Add the Prisma models and relations**

Modify `prisma/schema.prisma`.

Add relations to `User`:

```prisma
  createdClientOrganizations ClientOrganization[]       @relation("ClientOrganizationCreator")
  clientMemberships          ClientOrganizationMember[]
  clientInvitationsSent      ClientInvitation[]         @relation("ClientInvitationInviter")
  accessGrantsCreated        AccessGrant[]              @relation("AccessGrantCreator")
```

Add relations to `Organization`:

```prisma
  clientOrganizations ClientOrganization[]
  clientInvitations   ClientInvitation[]
  accessGrants        AccessGrant[]
```

Add these enums and models after `Invitation`:

```prisma
enum ClientOrganizationMemberRole {
  admin
  member
}

enum ClientInvitationStatus {
  pending
  accepted
  canceled
  expired
}

enum AccessGrantSubjectType {
  client_organization
  client_member
}

enum AccessGrantResourceType {
  project
}

model ClientOrganization {
  id             String                     @id @default(cuid())
  organizationId String
  organization   Organization               @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  name           String
  slug           String
  createdById    String
  createdBy      User                       @relation("ClientOrganizationCreator", fields: [createdById], references: [id], onDelete: Cascade)
  members        ClientOrganizationMember[]
  invitations    ClientInvitation[]
  createdAt      DateTime                   @default(now())
  updatedAt      DateTime                   @updatedAt

  @@unique([organizationId, slug])
  @@index([organizationId])
  @@map("client_organization")
}

model ClientOrganizationMember {
  id                   String                       @id @default(cuid())
  organizationId       String
  clientOrganizationId String
  clientOrganization   ClientOrganization           @relation(fields: [clientOrganizationId], references: [id], onDelete: Cascade)
  userId               String
  user                 User                         @relation(fields: [userId], references: [id], onDelete: Cascade)
  role                 ClientOrganizationMemberRole @default(member)
  createdAt            DateTime                     @default(now())

  @@unique([clientOrganizationId, userId])
  @@index([organizationId, userId])
  @@index([clientOrganizationId])
  @@map("client_organization_member")
}

model ClientInvitation {
  id                   String                 @id @default(cuid())
  organizationId       String
  organization         Organization           @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  clientOrganizationId String
  clientOrganization   ClientOrganization     @relation(fields: [clientOrganizationId], references: [id], onDelete: Cascade)
  email                String
  role                 ClientOrganizationMemberRole @default(member)
  status               ClientInvitationStatus @default(pending)
  invitedById          String
  invitedBy            User                   @relation("ClientInvitationInviter", fields: [invitedById], references: [id], onDelete: Cascade)
  expiresAt            DateTime
  acceptedAt           DateTime?
  createdAt            DateTime               @default(now())

  @@index([organizationId])
  @@index([clientOrganizationId])
  @@index([email])
  @@map("client_invitation")
}

model AccessGrant {
  id             String                 @id @default(cuid())
  organizationId String
  organization   Organization           @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  subjectType    AccessGrantSubjectType
  subjectId      String
  resourceType   AccessGrantResourceType
  resourceId     String
  permissions    String[]
  createdById    String
  createdBy      User                   @relation("AccessGrantCreator", fields: [createdById], references: [id], onDelete: Cascade)
  createdAt      DateTime               @default(now())
  updatedAt      DateTime               @updatedAt

  @@unique([organizationId, subjectType, subjectId, resourceType, resourceId])
  @@index([organizationId, resourceType, resourceId])
  @@index([subjectType, subjectId])
  @@map("access_grant")
}
```

- [ ] **Step 2: Generate Prisma client and migration**

Run:

```bash
bun run prisma:generate
bunx prisma migrate dev --name add_client_access
```

Expected: Prisma generates the client and creates a migration containing the four new mapped tables plus enums.

- [ ] **Step 3: Verify the schema compiles**

Run:

```bash
bun run check
```

Expected: PASS with generated Prisma enum names matching the schema names used in this plan.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(authz): add client access data model"
```

---

### Task 2: Modular Permission Registry

**Files:**

- Create: `src/lib/authz/permissions.ts`
- Create: `src/lib/authz/resources.ts`
- Create: `tests/unit/lib/authz/permissions.test.ts`

- [ ] **Step 1: Write failing registry tests**

Create `tests/unit/lib/authz/permissions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	createPermissionRegistry,
	definePermissionModule,
	isPermission,
	permissionPresets,
	permissionRegistry,
	projectPermissions,
	runPermissions
} from '$lib/authz/permissions';

describe('permission registry', () => {
	it('exposes the initial permission keys', () => {
		expect(permissionRegistry.permissions.map((permission) => permission.key)).toEqual([
			'project.view',
			'project.manage_access',
			'project.config.view',
			'project.config.manage',
			'run.view',
			'run.create',
			'run.reply',
			'run.diff.view',
			'run.approve'
		]);
	});

	it('validates known permission strings', () => {
		expect(isPermission('project.view')).toBe(true);
		expect(isPermission('run.diff.view')).toBe(true);
		expect(isPermission('project.delete')).toBe(false);
	});

	it('defines project and run modules independently', () => {
		expect(projectPermissions.resource).toBe('project');
		expect(runPermissions.resource).toBe('run');
		expect(projectPermissions.permissions.map((permission) => permission.key)).toContain(
			'project.manage_access'
		);
		expect(runPermissions.permissions.map((permission) => permission.key)).toContain(
			'run.create'
		);
	});

	it('exposes UX presets as permission arrays', () => {
		expect(permissionPresets.project_access.permissions).toEqual(['project.view']);
		expect(permissionPresets.operator.permissions).toEqual([
			'project.view',
			'run.view',
			'run.create',
			'run.reply',
			'run.diff.view'
		]);
	});

	it('rejects duplicate permissions across modules', () => {
		const duplicate = definePermissionModule({
			resource: 'project',
			permissions: {
				view: { label: 'View again' }
			}
		});

		expect(() => createPermissionRegistry([projectPermissions, duplicate])).toThrow(
			'Duplicate permission: project.view'
		);
	});

	it('rejects presets that reference unknown permissions', () => {
		expect(() =>
			createPermissionRegistry(
				[projectPermissions],
				{
					broken: {
						label: 'Broken',
						description: 'References an unknown key',
						permissions: ['run.view']
					}
				}
			)
		).toThrow('Unknown permission in preset broken: run.view');
	});
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
bun run test:unit -- tests/unit/lib/authz/permissions.test.ts --run
```

Expected: FAIL because `$lib/authz/permissions` does not exist.

- [ ] **Step 3: Add resource types**

Create `src/lib/authz/resources.ts`:

```ts
export const accessGrantResourceTypes = ['project'] as const;

export type AccessGrantResourceType = (typeof accessGrantResourceTypes)[number];

export type AuthzResource = {
	type: AccessGrantResourceType;
	id: string;
};

export function projectResource(id: string): AuthzResource {
	return { type: 'project', id };
}
```

- [ ] **Step 4: Add the registry implementation**

Create `src/lib/authz/permissions.ts`:

```ts
type PermissionDefinition = {
	label: string;
	description?: string;
};

export type PermissionModuleInput<Resource extends string = string> = {
	resource: Resource;
	permissions: Record<string, PermissionDefinition>;
};

export type PermissionDefinitionWithKey = PermissionDefinition & {
	key: string;
	resource: string;
	action: string;
};

export type PermissionModule = {
	resource: string;
	permissions: PermissionDefinitionWithKey[];
};

export type PermissionPreset = {
	label: string;
	description: string;
	permissions: string[];
};

export type PermissionRegistry = {
	permissions: PermissionDefinitionWithKey[];
	permissionKeys: Set<string>;
	presets: Record<string, PermissionPreset>;
};

export function definePermissionModule(input: PermissionModuleInput): PermissionModule {
	return {
		resource: input.resource,
		permissions: Object.entries(input.permissions).map(([action, definition]) => ({
			...definition,
			key: `${input.resource}.${action}`,
			resource: input.resource,
			action
		}))
	};
}

export const projectPermissions = definePermissionModule({
	resource: 'project',
	permissions: {
		view: { label: 'Voir le projet' },
		manage_access: { label: 'Gérer les accès' },
		'config.view': { label: 'Voir la configuration projet' },
		'config.manage': { label: 'Modifier la configuration projet' }
	}
});

export const runPermissions = definePermissionModule({
	resource: 'run',
	permissions: {
		view: { label: 'Voir les runs' },
		create: { label: 'Lancer un run' },
		reply: { label: 'Répondre à un run' },
		'diff.view': { label: 'Voir le diff' },
		approve: { label: 'Approuver un run' }
	}
});

export const permissionPresets = {
	project_access: {
		label: 'Accès projet',
		description: 'Voir le projet sans accéder aux runs ni à la configuration.',
		permissions: ['project.view']
	},
	follow_up: {
		label: 'Suivi',
		description: 'Voir le projet et suivre les runs.',
		permissions: ['project.view', 'run.view']
	},
	reviewer: {
		label: 'Reviewer',
		description: 'Suivre les runs, consulter les diffs et répondre aux questions.',
		permissions: ['project.view', 'run.view', 'run.diff.view', 'run.reply']
	},
	operator: {
		label: 'Opérateur',
		description: 'Lancer et suivre les runs sur un projet.',
		permissions: ['project.view', 'run.view', 'run.create', 'run.reply', 'run.diff.view']
	},
	project_admin: {
		label: 'Admin projet',
		description: 'Gérer les accès et la configuration du projet.',
		permissions: [
			'project.view',
			'project.manage_access',
			'project.config.view',
			'project.config.manage',
			'run.view',
			'run.create',
			'run.reply',
			'run.diff.view',
			'run.approve'
		]
	}
} satisfies Record<string, PermissionPreset>;

export function createPermissionRegistry(
	modules: PermissionModule[],
	presets: Record<string, PermissionPreset> = permissionPresets
): PermissionRegistry {
	const permissions = modules.flatMap((module) => module.permissions);
	const permissionKeys = new Set<string>();
	for (const permission of permissions) {
		if (permissionKeys.has(permission.key)) {
			throw new Error(`Duplicate permission: ${permission.key}`);
		}
		permissionKeys.add(permission.key);
	}

	for (const [presetKey, preset] of Object.entries(presets)) {
		for (const permission of preset.permissions) {
			if (!permissionKeys.has(permission)) {
				throw new Error(`Unknown permission in preset ${presetKey}: ${permission}`);
			}
		}
	}

	return { permissions, permissionKeys, presets };
}

export const permissionRegistry = createPermissionRegistry([projectPermissions, runPermissions]);

export type Permission = (typeof permissionRegistry.permissions)[number]['key'];
export type PermissionPresetKey = keyof typeof permissionPresets;

export function isPermission(value: string): value is Permission {
	return permissionRegistry.permissionKeys.has(value);
}

export function assertPermissions(values: string[]): Permission[] {
	for (const value of values) {
		if (!isPermission(value)) throw new Error(`Unknown permission: ${value}`);
	}
	return values as Permission[];
}
```

- [ ] **Step 5: Run registry tests**

Run:

```bash
bun run test:unit -- tests/unit/lib/authz/permissions.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/authz tests/unit/lib/authz
git commit -m "feat(authz): add modular permission registry"
```

---

### Task 3: Actor Loading and Authorization Service

**Files:**

- Create: `src/lib/server/authz/actor.ts`
- Create: `src/lib/server/authz/service.ts`
- Create: `src/lib/server/authz/runs.ts`
- Create: `tests/unit/lib/server/authz/service.test.ts`

- [ ] **Step 1: Write failing authorization tests**

Create `tests/unit/lib/server/authz/service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	memberFindMany: vi.fn(),
	clientMemberFindMany: vi.fn(),
	projectFindUnique: vi.fn(),
	projectFindMany: vi.fn(),
	accessGrantFindMany: vi.fn(),
	runFindFirst: vi.fn()
}));

vi.mock('$app/server', () => ({ getRequestEvent: mocks.getRequestEvent }));
vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		member: { findMany: mocks.memberFindMany },
		clientOrganizationMember: { findMany: mocks.clientMemberFindMany },
		project: { findUnique: mocks.projectFindUnique, findMany: mocks.projectFindMany },
		accessGrant: { findMany: mocks.accessGrantFindMany },
		run: { findFirst: mocks.runFindFirst }
	}
}));

import { actorForUserId, requireActor } from '$lib/server/authz/actor';
import { can, listAccessibleProjects, requirePermission } from '$lib/server/authz/service';
import { requireRunPermission } from '$lib/server/authz/runs';

describe('authz service', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.memberFindMany.mockResolvedValue([]);
		mocks.clientMemberFindMany.mockResolvedValue([]);
		mocks.projectFindUnique.mockResolvedValue({ id: 'project1', organizationId: 'org1' });
		mocks.projectFindMany.mockResolvedValue([{ id: 'project1' }]);
		mocks.accessGrantFindMany.mockResolvedValue([]);
		mocks.runFindFirst.mockResolvedValue({ id: 'run1', projectId: 'project1' });
	});

	it('loads an actor from request locals', async () => {
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'user1' } } });
		mocks.memberFindMany.mockResolvedValue([{ organizationId: 'org1', role: 'member' }]);
		mocks.clientMemberFindMany.mockResolvedValue([
			{ id: 'cm1', organizationId: 'org2', clientOrganizationId: 'client1', role: 'member' }
		]);

		await expect(requireActor()).resolves.toEqual({
			userId: 'user1',
			internalMemberships: [{ organizationId: 'org1', role: 'member' }],
			clientMemberships: [
				{
					id: 'cm1',
					organizationId: 'org2',
					clientOrganizationId: 'client1',
					role: 'member'
				}
			]
		});
	});

	it('returns true for internal team members to preserve current access', async () => {
		const actor = await actorForUserId('user1');
		actor.internalMemberships.push({ organizationId: 'org1', role: 'member' });

		await expect(can(actor, 'run.create', { type: 'project', id: 'project1' })).resolves.toBe(true);
		expect(mocks.accessGrantFindMany).not.toHaveBeenCalled();
	});

	it('allows external clients through organization-level grants', async () => {
		const actor = await actorForUserId('user1');
		actor.clientMemberships.push({
			id: 'cm1',
			organizationId: 'org1',
			clientOrganizationId: 'client1',
			role: 'member'
		});
		mocks.accessGrantFindMany.mockResolvedValue([
			{ permissions: ['project.view'], subjectType: 'client_organization', subjectId: 'client1' }
		]);

		await expect(can(actor, 'project.view', { type: 'project', id: 'project1' })).resolves.toBe(
			true
		);
		await expect(can(actor, 'run.view', { type: 'project', id: 'project1' })).resolves.toBe(false);
	});

	it('unions inherited and direct grants for a client member', async () => {
		const actor = await actorForUserId('user1');
		actor.clientMemberships.push({
			id: 'cm1',
			organizationId: 'org1',
			clientOrganizationId: 'client1',
			role: 'member'
		});
		mocks.accessGrantFindMany.mockResolvedValue([
			{ permissions: ['project.view'], subjectType: 'client_organization', subjectId: 'client1' },
			{ permissions: ['run.view'], subjectType: 'client_member', subjectId: 'cm1' }
		]);

		await expect(can(actor, 'run.view', { type: 'project', id: 'project1' })).resolves.toBe(true);
	});

	it('throws 403 from requirePermission when access is missing', async () => {
		const actor = await actorForUserId('user1');

		await expect(
			requirePermission(actor, 'project.view', { type: 'project', id: 'project1' })
		).rejects.toMatchObject({ status: 403, message: 'Forbidden' });
	});

	it('lists only granted projects for external clients', async () => {
		const actor = await actorForUserId('user1');
		actor.clientMemberships.push({
			id: 'cm1',
			organizationId: 'org1',
			clientOrganizationId: 'client1',
			role: 'member'
		});
		mocks.accessGrantFindMany.mockResolvedValue([
			{ resourceId: 'project1', permissions: ['project.view'] },
			{ resourceId: 'project2', permissions: ['run.view'] }
		]);

		await expect(listAccessibleProjects(actor)).resolves.toEqual([{ id: 'project1' }]);
		expect(mocks.projectFindMany).toHaveBeenCalledWith({
			where: { id: { in: ['project1'] } },
			orderBy: { createdAt: 'desc' }
		});
	});

	it('resolves run permissions through the run project', async () => {
		const actor = await actorForUserId('user1');
		actor.internalMemberships.push({ organizationId: 'org1', role: 'member' });

		await expect(requireRunPermission(actor, 'run.view', 'run1')).resolves.toEqual({
			id: 'run1',
			projectId: 'project1'
		});
	});
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/authz/service.test.ts --run
```

Expected: FAIL because server authz modules do not exist.

- [ ] **Step 3: Implement actor loading**

Create `src/lib/server/authz/actor.ts`:

```ts
import { error } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { prisma } from '$lib/server/prisma';

export type InternalMembership = {
	organizationId: string;
	role: string;
};

export type ClientMembership = {
	id: string;
	organizationId: string;
	clientOrganizationId: string;
	role: string;
};

export type AuthzActor = {
	userId: string;
	internalMemberships: InternalMembership[];
	clientMemberships: ClientMembership[];
};

export async function actorForUserId(userId: string): Promise<AuthzActor> {
	const [internalMemberships, clientMemberships] = await Promise.all([
		prisma.member.findMany({
			where: { userId },
			select: { organizationId: true, role: true }
		}),
		prisma.clientOrganizationMember.findMany({
			where: { userId },
			select: {
				id: true,
				organizationId: true,
				clientOrganizationId: true,
				role: true
			}
		})
	]);

	return { userId, internalMemberships, clientMemberships };
}

export async function requireActor(): Promise<AuthzActor> {
	const { locals } = getRequestEvent();
	if (!locals.user) error(401, 'Not authenticated');
	return await actorForUserId(locals.user.id);
}
```

- [ ] **Step 4: Implement authorization service**

Create `src/lib/server/authz/service.ts`:

```ts
import { error } from '@sveltejs/kit';
import { assertPermissions, type Permission } from '$lib/authz/permissions';
import type { AuthzResource } from '$lib/authz/resources';
import type { AuthzActor } from '$lib/server/authz/actor';
import { prisma } from '$lib/server/prisma';

type ResourceOwner = {
	organizationId: string;
};

async function resolveResourceOwner(resource: AuthzResource): Promise<ResourceOwner | null> {
	if (resource.type === 'project') {
		return await prisma.project.findUnique({
			where: { id: resource.id },
			select: { organizationId: true }
		});
	}
	return null;
}

function isInternalMember(actor: AuthzActor, organizationId: string): boolean {
	return actor.internalMemberships.some((membership) => membership.organizationId === organizationId);
}

function clientMembershipsForOrg(actor: AuthzActor, organizationId: string) {
	return actor.clientMemberships.filter(
		(membership) => membership.organizationId === organizationId
	);
}

async function grantedPermissionsForResource(
	actor: AuthzActor,
	organizationId: string,
	resource: AuthzResource
): Promise<Set<string>> {
	const memberships = clientMembershipsForOrg(actor, organizationId);
	if (memberships.length === 0) return new Set();

	const clientOrganizationIds = memberships.map((membership) => membership.clientOrganizationId);
	const clientMemberIds = memberships.map((membership) => membership.id);
	const grants = await prisma.accessGrant.findMany({
		where: {
			organizationId,
			resourceType: resource.type,
			resourceId: resource.id,
			OR: [
				{ subjectType: 'client_organization', subjectId: { in: clientOrganizationIds } },
				{ subjectType: 'client_member', subjectId: { in: clientMemberIds } }
			]
		},
		select: { permissions: true, subjectType: true, subjectId: true }
	});

	const permissions = new Set<string>();
	for (const grant of grants) {
		for (const permission of grant.permissions) {
			if (assertPermissions([permission]).length === 1) permissions.add(permission);
		}
	}
	return permissions;
}

export async function can(
	actor: AuthzActor,
	permission: Permission,
	resource: AuthzResource
): Promise<boolean> {
	assertPermissions([permission]);
	const owner = await resolveResourceOwner(resource);
	if (!owner) return false;
	if (isInternalMember(actor, owner.organizationId)) return true;

	const permissions = await grantedPermissionsForResource(actor, owner.organizationId, resource);
	return permissions.has(permission);
}

export async function requirePermission(
	actor: AuthzActor,
	permission: Permission,
	resource: AuthzResource
): Promise<void> {
	if (!(await can(actor, permission, resource))) error(403, 'Forbidden');
}

export async function listAccessibleProjects(actor: AuthzActor) {
	const internalOrgIds = actor.internalMemberships.map((membership) => membership.organizationId);
	if (internalOrgIds.length > 0) {
		return await prisma.project.findMany({
			where: { organizationId: { in: internalOrgIds } },
			orderBy: { createdAt: 'desc' }
		});
	}

	const clientOrgIds = actor.clientMemberships.map((membership) => membership.clientOrganizationId);
	const clientMemberIds = actor.clientMemberships.map((membership) => membership.id);
	if (clientOrgIds.length === 0 && clientMemberIds.length === 0) return [];

	const grants = await prisma.accessGrant.findMany({
		where: {
			resourceType: 'project',
			permissions: { has: 'project.view' },
			OR: [
				{ subjectType: 'client_organization', subjectId: { in: clientOrgIds } },
				{ subjectType: 'client_member', subjectId: { in: clientMemberIds } }
			]
		},
		select: { resourceId: true, permissions: true }
	});
	const projectIds = [...new Set(grants.map((grant) => grant.resourceId))];
	if (projectIds.length === 0) return [];

	return await prisma.project.findMany({
		where: { id: { in: projectIds } },
		orderBy: { createdAt: 'desc' }
	});
}
```

- [ ] **Step 5: Implement run authorization helper**

Create `src/lib/server/authz/runs.ts`:

```ts
import { error } from '@sveltejs/kit';
import type { Permission } from '$lib/authz/permissions';
import { projectResource } from '$lib/authz/resources';
import type { AuthzActor } from '$lib/server/authz/actor';
import { requirePermission } from '$lib/server/authz/service';
import { prisma } from '$lib/server/prisma';

export async function requireRunPermission(
	actor: AuthzActor,
	permission: Permission,
	runId: string
): Promise<{ id: string; projectId: string }> {
	const run = await prisma.run.findFirst({
		where: { id: runId },
		select: { id: true, projectId: true }
	});
	if (!run) error(404, 'Run not found');
	await requirePermission(actor, permission, projectResource(run.projectId));
	return run;
}
```

- [ ] **Step 6: Run authorization tests**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/authz/service.test.ts --run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/authz tests/unit/lib/server/authz
git commit -m "feat(authz): add actor permission evaluator"
```

---

### Task 4: Client Access Services and Remote Functions

**Files:**

- Create: `src/lib/schemas/client-access.ts`
- Create: `src/lib/server/client-access/service.ts`
- Create: `src/lib/rfc/client-access.remote.ts`
- Create: `tests/unit/lib/server/client-access/service.test.ts`
- Create: `tests/unit/lib/rfc/client-access.remote.test.ts`
- Modify: `tests/mocks/rfc/remotes.ts`

- [ ] **Step 1: Write failing service tests**

Create `tests/unit/lib/server/client-access/service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	resolveSlug: vi.fn(),
	clientOrganizationCreate: vi.fn(),
	clientOrganizationFindFirst: vi.fn(),
	clientOrganizationFindMany: vi.fn(),
	clientInvitationCreate: vi.fn(),
	clientInvitationFindFirst: vi.fn(),
	clientInvitationUpdate: vi.fn(),
	clientMemberCreate: vi.fn(),
	accessGrantUpsert: vi.fn(),
	accessGrantDeleteMany: vi.fn(),
	projectFindFirst: vi.fn()
}));

vi.mock('$lib/server/teams/slug', () => ({ resolveSlug: mocks.resolveSlug }));
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		clientOrganization: {
			create: mocks.clientOrganizationCreate,
			findFirst: mocks.clientOrganizationFindFirst,
			findMany: mocks.clientOrganizationFindMany
		},
		clientInvitation: {
			create: mocks.clientInvitationCreate,
			findFirst: mocks.clientInvitationFindFirst,
			update: mocks.clientInvitationUpdate
		},
		clientOrganizationMember: { create: mocks.clientMemberCreate },
		accessGrant: { upsert: mocks.accessGrantUpsert, deleteMany: mocks.accessGrantDeleteMany },
		project: { findFirst: mocks.projectFindFirst }
	}
}));

import {
	acceptClientInvitation,
	createClientOrganization,
	inviteClientMember,
	removeProjectAccessGrant,
	upsertProjectAccessGrant
} from '$lib/server/client-access/service';

describe('client access service', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.resolveSlug.mockResolvedValue('acme');
		mocks.clientOrganizationCreate.mockResolvedValue({ id: 'client1', slug: 'acme' });
		mocks.clientInvitationCreate.mockResolvedValue({ id: 'invite1' });
		mocks.projectFindFirst.mockResolvedValue({ id: 'project1' });
		mocks.accessGrantUpsert.mockResolvedValue({ id: 'grant1' });
		mocks.accessGrantDeleteMany.mockResolvedValue({ count: 1 });
	});

	it('creates a client organization with a slug scoped to the internal team', async () => {
		await expect(
			createClientOrganization({ organizationId: 'org1', userId: 'user1', name: 'Acme' })
		).resolves.toEqual({ id: 'client1', slug: 'acme' });

		expect(mocks.resolveSlug).toHaveBeenCalledWith('Acme', expect.any(Function));
		expect(mocks.clientOrganizationCreate).toHaveBeenCalledWith({
			data: { organizationId: 'org1', name: 'Acme', slug: 'acme', createdById: 'user1' },
			select: { id: true, slug: true }
		});
	});

	it('creates a pending client invitation that expires in seven days', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-02T10:00:00.000Z'));

		await expect(
			inviteClientMember({
				organizationId: 'org1',
				clientOrganizationId: 'client1',
				userId: 'user1',
				email: 'client@example.com',
				role: 'member'
			})
		).resolves.toEqual({ invitationId: 'invite1' });

		expect(mocks.clientInvitationCreate).toHaveBeenCalledWith({
			data: {
				organizationId: 'org1',
				clientOrganizationId: 'client1',
				email: 'client@example.com',
				role: 'member',
				invitedById: 'user1',
				expiresAt: new Date('2026-07-09T10:00:00.000Z')
			},
			select: { id: true }
		});

		vi.useRealTimers();
	});

	it('accepts a pending invitation for the matching email', async () => {
		mocks.clientInvitationFindFirst.mockResolvedValue({
			id: 'invite1',
			email: 'client@example.com',
			status: 'pending',
			expiresAt: new Date('2026-07-09T10:00:00.000Z'),
			organizationId: 'org1',
			clientOrganizationId: 'client1',
			role: 'member'
		});
		mocks.clientMemberCreate.mockResolvedValue({ id: 'cm1' });

		await expect(
			acceptClientInvitation({
				invitationId: 'invite1',
				userId: 'user2',
				email: 'client@example.com',
				now: new Date('2026-07-02T10:00:00.000Z')
			})
		).resolves.toEqual({ clientOrganizationId: 'client1' });

		expect(mocks.clientMemberCreate).toHaveBeenCalledWith({
			data: {
				organizationId: 'org1',
				clientOrganizationId: 'client1',
				userId: 'user2',
				role: 'member'
			},
			select: { id: true }
		});
		expect(mocks.clientInvitationUpdate).toHaveBeenCalledWith({
			where: { id: 'invite1' },
			data: { status: 'accepted', acceptedAt: new Date('2026-07-02T10:00:00.000Z') },
			select: { id: true }
		});
	});

	it('rejects unknown permissions when upserting project grants', async () => {
		await expect(
			upsertProjectAccessGrant({
				organizationId: 'org1',
				userId: 'user1',
				projectId: 'project1',
				subjectType: 'client_organization',
				subjectId: 'client1',
				permissions: ['project.delete']
			})
		).rejects.toThrow('Unknown permission: project.delete');
	});

	it('upserts project grants for known permissions', async () => {
		await expect(
			upsertProjectAccessGrant({
				organizationId: 'org1',
				userId: 'user1',
				projectId: 'project1',
				subjectType: 'client_organization',
				subjectId: 'client1',
				permissions: ['project.view']
			})
		).resolves.toEqual({ id: 'grant1' });

		expect(mocks.accessGrantUpsert).toHaveBeenCalledWith({
			where: {
				organizationId_subjectType_subjectId_resourceType_resourceId: {
					organizationId: 'org1',
					subjectType: 'client_organization',
					subjectId: 'client1',
					resourceType: 'project',
					resourceId: 'project1'
				}
			},
			create: {
				organizationId: 'org1',
				subjectType: 'client_organization',
				subjectId: 'client1',
				resourceType: 'project',
				resourceId: 'project1',
				permissions: ['project.view'],
				createdById: 'user1'
			},
			update: { permissions: ['project.view'] },
			select: { id: true }
		});
	});

	it('deletes a grant by project and subject', async () => {
		await expect(
			removeProjectAccessGrant({
				organizationId: 'org1',
				projectId: 'project1',
				subjectType: 'client_organization',
				subjectId: 'client1'
			})
		).resolves.toEqual({ removed: true });
	});
});
```

- [ ] **Step 2: Run service tests and verify they fail**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/client-access/service.test.ts --run
```

Expected: FAIL because client access modules do not exist.

- [ ] **Step 3: Add schemas**

Create `src/lib/schemas/client-access.ts`:

```ts
import { z } from 'zod';
import { permissionPresets } from '$lib/authz/permissions';

export const createClientOrganizationSchema = z.object({
	name: z.string().min(2, 'Client name must be at least 2 characters')
});

export const clientMemberRoleSchema = z.enum(['admin', 'member']);

export const inviteClientMemberSchema = z.object({
	clientOrganizationId: z.string().min(1),
	email: z.email('Invalid email address'),
	role: clientMemberRoleSchema.default('member')
});

export const accessGrantSubjectSchema = z.object({
	subjectType: z.enum(['client_organization', 'client_member']),
	subjectId: z.string().min(1)
});

export const permissionPresetSchema = z.enum(
	Object.keys(permissionPresets) as [keyof typeof permissionPresets, ...(keyof typeof permissionPresets)[]]
);

export const upsertProjectAccessGrantSchema = accessGrantSubjectSchema.extend({
	projectId: z.string().min(1),
	preset: permissionPresetSchema
});

export const removeProjectAccessGrantSchema = accessGrantSubjectSchema.extend({
	projectId: z.string().min(1)
});
```

- [ ] **Step 4: Add service implementation**

Create `src/lib/server/client-access/service.ts`:

```ts
import { assertPermissions, permissionPresets } from '$lib/authz/permissions';
import type { PermissionPresetKey } from '$lib/authz/permissions';
import type { AccessGrantSubjectType } from '@prisma/client';
import { prisma } from '$lib/server/prisma';
import { resolveSlug } from '$lib/server/teams/slug';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class ClientAccessError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ClientAccessError';
	}
}

export async function createClientOrganization(input: {
	organizationId: string;
	userId: string;
	name: string;
}) {
	const slug = await resolveSlug(
		input.name,
		async (candidate) =>
			(await prisma.clientOrganization.findFirst({
				where: { organizationId: input.organizationId, slug: candidate },
				select: { id: true }
			})) !== null
	);

	return await prisma.clientOrganization.create({
		data: {
			organizationId: input.organizationId,
			name: input.name,
			slug,
			createdById: input.userId
		},
		select: { id: true, slug: true }
	});
}

export async function listClientOrganizations(organizationId: string) {
	return await prisma.clientOrganization.findMany({
		where: { organizationId },
		orderBy: { createdAt: 'desc' },
		include: {
			members: {
				include: {
					user: { select: { id: true, email: true, name: true, image: true } }
				},
				orderBy: { createdAt: 'asc' }
			},
			invitations: {
				where: { status: 'pending' },
				orderBy: { createdAt: 'desc' }
			}
		}
	});
}

export async function inviteClientMember(input: {
	organizationId: string;
	clientOrganizationId: string;
	userId: string;
	email: string;
	role: 'admin' | 'member';
	now?: Date;
}) {
	const clientOrganization = await prisma.clientOrganization.findFirst({
		where: { id: input.clientOrganizationId, organizationId: input.organizationId },
		select: { id: true }
	});
	if (!clientOrganization) throw new ClientAccessError('Client organization not found');

	const now = input.now ?? new Date();
	const invitation = await prisma.clientInvitation.create({
		data: {
			organizationId: input.organizationId,
			clientOrganizationId: input.clientOrganizationId,
			email: input.email,
			role: input.role,
			invitedById: input.userId,
			expiresAt: new Date(now.getTime() + INVITATION_TTL_MS)
		},
		select: { id: true }
	});
	return { invitationId: invitation.id };
}

export async function acceptClientInvitation(input: {
	invitationId: string;
	userId: string;
	email: string;
	now?: Date;
}) {
	const now = input.now ?? new Date();
	const invitation = await prisma.clientInvitation.findFirst({
		where: { id: input.invitationId },
		select: {
			id: true,
			email: true,
			status: true,
			expiresAt: true,
			organizationId: true,
			clientOrganizationId: true,
			role: true
		}
	});
	if (!invitation || invitation.status !== 'pending') {
		throw new ClientAccessError('Invitation not found');
	}
	if (invitation.email.toLowerCase() !== input.email.toLowerCase()) {
		throw new ClientAccessError('Invitation email does not match this account');
	}
	if (invitation.expiresAt.getTime() <= now.getTime()) {
		await prisma.clientInvitation.update({
			where: { id: invitation.id },
			data: { status: 'expired' },
			select: { id: true }
		});
		throw new ClientAccessError('Invitation expired');
	}

	await prisma.clientOrganizationMember.create({
		data: {
			organizationId: invitation.organizationId,
			clientOrganizationId: invitation.clientOrganizationId,
			userId: input.userId,
			role: invitation.role
		},
		select: { id: true }
	});
	await prisma.clientInvitation.update({
		where: { id: invitation.id },
		data: { status: 'accepted', acceptedAt: now },
		select: { id: true }
	});
	return { clientOrganizationId: invitation.clientOrganizationId };
}

async function requireProjectInOrg(organizationId: string, projectId: string) {
	const project = await prisma.project.findFirst({
		where: { id: projectId, organizationId },
		select: { id: true }
	});
	if (!project) throw new ClientAccessError('Project not found');
	return project;
}

export async function upsertProjectAccessGrant(input: {
	organizationId: string;
	userId: string;
	projectId: string;
	subjectType: AccessGrantSubjectType;
	subjectId: string;
	permissions: string[];
}) {
	await requireProjectInOrg(input.organizationId, input.projectId);
	const permissions = assertPermissions(input.permissions);
	return await prisma.accessGrant.upsert({
		where: {
			organizationId_subjectType_subjectId_resourceType_resourceId: {
				organizationId: input.organizationId,
				subjectType: input.subjectType,
				subjectId: input.subjectId,
				resourceType: 'project',
				resourceId: input.projectId
			}
		},
		create: {
			organizationId: input.organizationId,
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			resourceType: 'project',
			resourceId: input.projectId,
			permissions,
			createdById: input.userId
		},
		update: { permissions },
		select: { id: true }
	});
}

export function permissionsForPreset(preset: PermissionPresetKey): string[] {
	return permissionPresets[preset].permissions;
}

export async function listProjectAccessGrants(organizationId: string, projectId: string) {
	await requireProjectInOrg(organizationId, projectId);
	return await prisma.accessGrant.findMany({
		where: { organizationId, resourceType: 'project', resourceId: projectId },
		orderBy: { createdAt: 'desc' }
	});
}

export async function removeProjectAccessGrant(input: {
	organizationId: string;
	projectId: string;
	subjectType: AccessGrantSubjectType;
	subjectId: string;
}) {
	const result = await prisma.accessGrant.deleteMany({
		where: {
			organizationId: input.organizationId,
			resourceType: 'project',
			resourceId: input.projectId,
			subjectType: input.subjectType,
			subjectId: input.subjectId
		}
	});
	return { removed: result.count > 0 };
}
```

- [ ] **Step 5: Add remote functions**

Create `src/lib/rfc/client-access.remote.ts`:

```ts
import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireActiveOrg } from '$lib/server/auth/org';
import { requireHeaders } from '$lib/server/auth/request';
import { projectResource } from '$lib/authz/resources';
import {
	createClientOrganizationSchema,
	inviteClientMemberSchema,
	removeProjectAccessGrantSchema,
	upsertProjectAccessGrantSchema
} from '$lib/schemas/client-access';
import { requireActor } from '$lib/server/authz/actor';
import { requirePermission } from '$lib/server/authz/service';
import {
	ClientAccessError,
	acceptClientInvitation as acceptClientInvitationService,
	createClientOrganization,
	inviteClientMember,
	listClientOrganizations,
	listProjectAccessGrants,
	permissionsForPreset,
	removeProjectAccessGrant as removeProjectAccessGrantService,
	upsertProjectAccessGrant as upsertProjectAccessGrantService
} from '$lib/server/client-access/service';

function mapClientAccessError(err: unknown): never {
	if (err instanceof ClientAccessError) error(400, err.message);
	throw err;
}

async function internalContext() {
	const headers = requireHeaders();
	const organizationId = await requireActiveOrg(headers);
	const { locals } = getRequestEvent();
	if (!locals.user) error(401, 'Not authenticated');
	return { headers, organizationId, userId: locals.user.id };
}

export const listClients = query(async () => {
	const { organizationId } = await internalContext();
	return await listClientOrganizations(organizationId);
});

export const createClient = command(createClientOrganizationSchema, async ({ name }) => {
	const { organizationId, userId } = await internalContext();
	const client = await createClientOrganization({ organizationId, userId, name });
	await listClients().refresh();
	return client;
});

export const inviteClient = command(inviteClientMemberSchema, async (input) => {
	const { organizationId, userId } = await internalContext();
	try {
		const result = await inviteClientMember({ organizationId, userId, ...input });
		await listClients().refresh();
		return result;
	} catch (err) {
		mapClientAccessError(err);
	}
});

export const acceptClientInvitation = command(z.string(), async (invitationId) => {
	const { locals } = getRequestEvent();
	if (!locals.user) error(401, 'Not authenticated');
	try {
		return await acceptClientInvitationService({
			invitationId,
			userId: locals.user.id,
			email: locals.user.email
		});
	} catch (err) {
		mapClientAccessError(err);
	}
});

export const getProjectAccess = query(z.string().min(1), async (projectId) => {
	const actor = await requireActor();
	await requirePermission(actor, 'project.manage_access', projectResource(projectId));
	const { organizationId } = await internalContext();
	return await listProjectAccessGrants(organizationId, projectId);
});

export const upsertProjectAccess = command(upsertProjectAccessGrantSchema, async (input) => {
	const actor = await requireActor();
	await requirePermission(actor, 'project.manage_access', projectResource(input.projectId));
	const { organizationId, userId } = await internalContext();
	try {
		const result = await upsertProjectAccessGrantService({
			organizationId,
			userId,
			projectId: input.projectId,
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			permissions: permissionsForPreset(input.preset)
		});
		await getProjectAccess(input.projectId).refresh();
		return result;
	} catch (err) {
		mapClientAccessError(err);
	}
});

export const removeProjectAccess = command(removeProjectAccessGrantSchema, async (input) => {
	const actor = await requireActor();
	await requirePermission(actor, 'project.manage_access', projectResource(input.projectId));
	const { organizationId } = await internalContext();
	const result = await removeProjectAccessGrantService({ organizationId, ...input });
	await getProjectAccess(input.projectId).refresh();
	return result;
});
```

- [ ] **Step 6: Add remote mocks**

Modify `tests/mocks/rfc/remotes.ts` and add:

```ts
export const listClients = () => queryState([]);
export const createClient = emptyCommand;
export const inviteClient = emptyCommand;
export const acceptClientInvitation = emptyCommand;
export const getProjectAccess = () => queryState([]);
export const upsertProjectAccess = emptyCommand;
export const removeProjectAccess = emptyCommand;
```

- [ ] **Step 7: Run client access service tests**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/client-access/service.test.ts --run
```

Expected: PASS.

- [ ] **Step 8: Add remote tests**

Create `tests/unit/lib/rfc/client-access.remote.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRefreshableRemoteCommand, mockRemoteQueryState } from './remote-test-helpers';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	requireHeaders: vi.fn(),
	requireActiveOrg: vi.fn(),
	requireActor: vi.fn(),
	requirePermission: vi.fn(),
	queryRefresh: vi.fn(),
	createClientOrganization: vi.fn(),
	inviteClientMember: vi.fn(),
	listClientOrganizations: vi.fn(),
	permissionsForPreset: vi.fn(),
	upsertProjectAccessGrantService: vi.fn(),
	listProjectAccessGrants: vi.fn()
}));

vi.mock('$app/server', () => ({
	command: vi.fn((schemaOrHandler, maybeHandler) =>
		mockRefreshableRemoteCommand(maybeHandler ?? schemaOrHandler)
	),
	query: vi.fn((schemaOrHandler, maybeHandler) => {
		const handler = maybeHandler ?? schemaOrHandler;
		return mockRemoteQueryState(handler, mocks.queryRefresh);
	}),
	getRequestEvent: mocks.getRequestEvent
}));

vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));

vi.mock('$lib/server/auth/request', () => ({ requireHeaders: mocks.requireHeaders }));
vi.mock('$lib/server/auth/org', () => ({ requireActiveOrg: mocks.requireActiveOrg }));
vi.mock('$lib/server/authz/actor', () => ({ requireActor: mocks.requireActor }));
vi.mock('$lib/server/authz/service', () => ({ requirePermission: mocks.requirePermission }));
vi.mock('$lib/server/client-access/service', () => ({
	createClientOrganization: mocks.createClientOrganization,
	inviteClientMember: mocks.inviteClientMember,
	listClientOrganizations: mocks.listClientOrganizations,
	permissionsForPreset: mocks.permissionsForPreset,
	upsertProjectAccessGrant: mocks.upsertProjectAccessGrantService,
	listProjectAccessGrants: mocks.listProjectAccessGrants,
	ClientAccessError: class ClientAccessError extends Error {}
}));

import { createClient, listClients, upsertProjectAccess } from '$lib/rfc/client-access.remote';

const listClientsHandler = listClients as unknown as { serverHandler: () => Promise<unknown> };

describe('client-access.remote', () => {
	const headers = new Headers({ cookie: 'session=abc' });

	beforeEach(() => {
		vi.resetAllMocks();
		mocks.requireHeaders.mockReturnValue(headers);
		mocks.requireActiveOrg.mockResolvedValue('org1');
		mocks.requireActor.mockResolvedValue({ userId: 'user1' });
		mocks.requirePermission.mockResolvedValue(undefined);
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'user1' } } });
		mocks.queryRefresh.mockResolvedValue(undefined);
		mocks.listClientOrganizations.mockResolvedValue([]);
		mocks.createClientOrganization.mockResolvedValue({ id: 'client1', slug: 'acme' });
		mocks.permissionsForPreset.mockReturnValue(['project.view']);
		mocks.upsertProjectAccessGrantService.mockResolvedValue({ id: 'grant1' });
		mocks.listProjectAccessGrants.mockResolvedValue([]);
	});

	it('listClients returns client organizations for the active team', async () => {
		mocks.listClientOrganizations.mockResolvedValue([{ id: 'client1', name: 'Acme' }]);

		await expect(listClientsHandler.serverHandler()).resolves.toEqual([
			{ id: 'client1', name: 'Acme' }
		]);

		expect(mocks.listClientOrganizations).toHaveBeenCalledWith('org1');
	});

	it('createClient uses the active org and current user', async () => {
		await expect(createClient({ name: 'Acme' })).resolves.toEqual({
			id: 'client1',
			slug: 'acme'
		});

		expect(mocks.createClientOrganization).toHaveBeenCalledWith({
			organizationId: 'org1',
			userId: 'user1',
			name: 'Acme'
		});
		expect(mocks.queryRefresh).toHaveBeenCalledTimes(1);
	});

	it('upsertProjectAccess requires project.manage_access before writing', async () => {
		await expect(
			upsertProjectAccess({
				projectId: 'project1',
				subjectType: 'client_organization',
				subjectId: 'client1',
				preset: 'project_access'
			})
		).resolves.toEqual({ id: 'grant1' });

		expect(mocks.requirePermission).toHaveBeenCalledWith(
			{ userId: 'user1' },
			'project.manage_access',
			{ type: 'project', id: 'project1' }
		);
		expect(mocks.upsertProjectAccessGrantService).toHaveBeenCalledWith({
			organizationId: 'org1',
			userId: 'user1',
			projectId: 'project1',
			subjectType: 'client_organization',
			subjectId: 'client1',
			permissions: ['project.view']
		});
	});
});
```

Run:

```bash
bun run test:unit -- tests/unit/lib/rfc/client-access.remote.test.ts --run
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/schemas/client-access.ts src/lib/server/client-access src/lib/rfc/client-access.remote.ts tests/unit/lib/server/client-access tests/unit/lib/rfc/client-access.remote.test.ts tests/mocks/rfc/remotes.ts
git commit -m "feat(authz): add client access management api"
```

---

### Task 5: Project Visibility Integration

**Files:**

- Modify: `src/lib/server/projects/service.ts`
- Modify: `src/lib/rfc/projects.remote.ts`
- Modify: `tests/unit/lib/server/projects/service.test.ts`
- Modify: `tests/unit/lib/rfc/projects.remote.test.ts`

- [ ] **Step 1: Add failing project service tests**

In `tests/unit/lib/server/projects/service.test.ts`, add `listAccessibleProjects` and `requirePermission` mocks if the module is split, then add:

```ts
it('listProjectsForActor delegates to authz accessible projects', async () => {
	const actor = { userId: 'user1', internalMemberships: [], clientMemberships: [] };
	const listAccessibleProjects = vi.fn().mockResolvedValue([{ id: 'project1' }]);
	vi.doMock('$lib/server/authz/service', () => ({ listAccessibleProjects }));

	const { listProjectsForActor } = await import('$lib/server/projects/service');
	await expect(listProjectsForActor(actor)).resolves.toEqual([{ id: 'project1' }]);
	expect(listAccessibleProjects).toHaveBeenCalledWith(actor);
});
```

If `vi.doMock` conflicts with existing static imports, place this test in a new file `tests/unit/lib/server/projects/access.test.ts` with fresh mocks.

- [ ] **Step 2: Add actor-aware project service functions**

Modify `src/lib/server/projects/service.ts`:

```ts
import { projectResource } from '$lib/authz/resources';
import type { AuthzActor } from '$lib/server/authz/actor';
import { listAccessibleProjects, can } from '$lib/server/authz/service';
```

Add:

```ts
export async function listProjectsForActor(actor: AuthzActor) {
	return await listAccessibleProjects(actor);
}

export async function getProjectForActor(actor: AuthzActor, id: string) {
	if (!(await can(actor, 'project.view', projectResource(id)))) return null;
	return await prisma.project.findFirst({ where: { id } });
}
```

- [ ] **Step 3: Update project remote reads**

Modify `src/lib/rfc/projects.remote.ts`:

```ts
import { requireActor } from '$lib/server/authz/actor';
import { requirePermission } from '$lib/server/authz/service';
import { projectResource } from '$lib/authz/resources';
```

Change `listProjects`:

```ts
export const listProjects = query(async () => {
	await requireHeaders();
	const actor = await requireActor();
	return await listProjectsForActor(actor);
});
```

Change `getProject`:

```ts
export const getProject = query(z.string(), async (id) => {
	await requireHeaders();
	const actor = await requireActor();
	const project = await getProjectForActor(actor, id);
	if (!project) error(404, 'Project not found');
	return project;
});
```

Change `listProjectBranches`:

```ts
export const listProjectBranches = query(z.string(), async (id) => {
	const headers = requireHeaders();
	const actor = await requireActor();
	await requirePermission(actor, 'project.view', projectResource(id));
	const project = await getProjectForActor(actor, id);
	if (!project) error(404, 'Project not found');
	const token = await getGithubToken(headers);
	return await listBranchesForProject(project, token);
});
```

Keep `importProject` using `requireActiveOrg(headers)` so only internal team members can import repositories.

- [ ] **Step 4: Update remote tests**

Modify `tests/unit/lib/rfc/projects.remote.test.ts` mocks to include:

```ts
requireActor: vi.fn(),
requirePermission: vi.fn(),
listProjectsForActor: vi.fn(),
getProjectForActor: vi.fn()
```

Add tests:

```ts
it('listProjects uses actor-aware project visibility', async () => {
	mocks.requireActor.mockResolvedValue({ userId: 'client1' });
	mocks.listProjectsForActor.mockResolvedValue([{ id: 'project1' }]);

	const { listProjects } = await import('$lib/rfc/projects.remote');
	const handler = listProjects as unknown as { serverHandler: () => Promise<unknown> };

	await expect(handler.serverHandler()).resolves.toEqual([{ id: 'project1' }]);
	expect(mocks.listProjectsForActor).toHaveBeenCalledWith({ userId: 'client1' });
});

it('getProject returns 404 when actor cannot view project', async () => {
	mocks.requireActor.mockResolvedValue({ userId: 'client1' });
	mocks.getProjectForActor.mockResolvedValue(null);

	const { getProject } = await import('$lib/rfc/projects.remote');
	await expect(getProject('project_hidden')).rejects.toMatchObject({
		status: 404,
		message: 'Project not found'
	});
});
```

- [ ] **Step 5: Run project tests**

Run:

```bash
bun run test:unit -- tests/unit/lib/server/projects/service.test.ts tests/unit/lib/rfc/projects.remote.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/projects/service.ts src/lib/rfc/projects.remote.ts tests/unit/lib/server/projects tests/unit/lib/rfc/projects.remote.test.ts
git commit -m "feat(authz): scope project reads to actor access"
```

---

### Task 6: Runs, Config, SSE, and MCP Permission Guards

**Files:**

- Modify: `src/lib/rfc/runs.remote.ts`
- Modify: `src/lib/rfc/project-agent-config.remote.ts`
- Modify: `src/lib/rfc/project-environments.remote.ts`
- Modify: `src/lib/rfc/project-environment-services.remote.ts`
- Modify: `src/routes/api/runs/[id]/events/+server.ts`
- Modify: `src/routes/api/projects/[id]/environment/[profileId]/events/+server.ts`
- Modify: `src/routes/api/projects/[id]/environment-services/[serviceId]/events/+server.ts`
- Modify: `src/lib/server/mcp/context.ts`
- Modify: `src/lib/server/mcp/tools.ts`
- Update relevant existing tests under `tests/unit/lib/rfc` and `tests/unit/lib/server/mcp`.

- [ ] **Step 1: Add permission mapping comments to run remote**

Modify `src/lib/rfc/runs.remote.ts` with this local helper:

```ts
import { requireActor } from '$lib/server/authz/actor';
import { requirePermission } from '$lib/server/authz/service';
import { requireRunPermission } from '$lib/server/authz/runs';
import { projectResource } from '$lib/authz/resources';
```

Add near `TIMEOUT_MS`:

```ts
async function requireProjectRunPermission(permission: Parameters<typeof requirePermission>[1], projectId: string) {
	const actor = await requireActor();
	await requirePermission(actor, permission, projectResource(projectId));
	return actor;
}
```

- [ ] **Step 2: Guard run commands and queries**

Apply these checks:

```ts
// startRun
await requireProjectRunPermission('run.create', projectId);

// listRuns
await requireProjectRunPermission('run.view', projectId);

// getRun
const actor = await requireActor();
await requireRunPermission(actor, 'run.view', runId);

// getRunDiff
const actor = await requireActor();
await requireRunPermission(actor, 'run.diff.view', runId);

// cancelRun
const actor = await requireActor();
await requireRunPermission(actor, 'run.reply', runId);

// answerRunInteraction
const actor = await requireActor();
await requireRunPermission(actor, 'run.reply', input.runId);

// replyToRun
const actor = await requireActor();
await requireRunPermission(actor, 'run.reply', runId);

// approveRun
const actor = await requireActor();
await requireRunPermission(actor, 'run.approve', runId);
```

Keep existing `organizationId = await requireActiveOrg(headers)` for service calls until the run service is made actor-native. This preserves current service signatures while the new permission layer blocks external clients without grants.

- [ ] **Step 3: Guard project config remotes**

In `src/lib/rfc/project-agent-config.remote.ts`, add:

```ts
import { requireActor } from '$lib/server/authz/actor';
import { requirePermission } from '$lib/server/authz/service';
import { projectResource } from '$lib/authz/resources';

async function requireProjectConfigPermission(
	projectId: string,
	permission: 'project.config.view' | 'project.config.manage'
) {
	const actor = await requireActor();
	await requirePermission(actor, permission, projectResource(projectId));
}
```

Call `await requireProjectConfigPermission(projectId, 'project.config.view')` in `getProjectAgentConfig`.

Call `await requireProjectConfigPermission(input.projectId, 'project.config.manage')` in all upsert/import commands.

Call `await requireProjectConfigPermission(projectId, 'project.config.manage')` in delete/toggle/reveal commands. For `revealProjectEnvVar`, use `project.config.manage` because it exposes a secret value.

- [ ] **Step 4: Guard environment and service remotes**

In `src/lib/rfc/project-environments.remote.ts`, require:

```ts
// getProjectEnvironment, getProjectEnvironmentPrepareEvents
await requirePermission(actor, 'project.config.view', projectResource(projectId));

// detectProjectEnvironment, saveProjectEnvironment, prepareProjectEnvironment
await requirePermission(actor, 'project.config.manage', projectResource(projectId));
```

In `src/lib/rfc/project-environment-services.remote.ts`, require:

```ts
// getProjectEnvironmentServices
await requirePermission(actor, 'project.config.view', projectResource(projectId));

// create/provision/toggle/mapping updates
await requirePermission(actor, 'project.config.manage', projectResource(projectId));
```

- [ ] **Step 5: Guard SSE routes**

In `src/routes/api/runs/[id]/events/+server.ts`, before opening the stream:

```ts
const actor = await requireActor();
await requireRunPermission(actor, 'run.view', runId);
```

In `src/routes/api/projects/[id]/environment/[profileId]/events/+server.ts`:

```ts
const actor = await requireActor();
await requirePermission(actor, 'project.config.view', projectResource(projectId));
```

In `src/routes/api/projects/[id]/environment-services/[serviceId]/events/+server.ts`:

```ts
const actor = await requireActor();
await requirePermission(actor, 'project.config.view', projectResource(projectId));
```

- [ ] **Step 6: Add MCP actor helpers**

Modify `src/lib/server/mcp/context.ts`:

```ts
import { actorForUserId } from '$lib/server/authz/actor';

export async function resolveMcpActor(userId: string) {
	return await actorForUserId(userId);
}
```

Modify `src/lib/server/mcp/tools.ts`:

```ts
const actor = await resolveMcpActor(ctx.userId);
```

Use `listAccessibleProjects(actor)` for `list_projects`, `can(actor, 'project.view', projectResource(args.projectId))` for `get_project`, and the same run/config permissions as web remotes before calling run services.

- [ ] **Step 7: Update tests for permission calls**

Update existing tests:

```bash
tests/unit/lib/rfc/runs.remote.test.ts
tests/unit/lib/rfc/project-agent-config.remote.test.ts
tests/unit/lib/rfc/project-environments.remote.test.ts
tests/unit/lib/rfc/project-environment-services.remote.test.ts
tests/unit/lib/server/mcp/tools.test.ts
```

In `tests/unit/lib/rfc/runs.remote.test.ts`, add hoisted fakes for `requireActor` and
`requireRunPermission`, then add:

```ts
it('getRun blocks actors without run.view', async () => {
	mocks.requireActor.mockResolvedValue({ userId: 'client1' });
	mocks.requireRunPermission.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));

	await expect(getRun('run1')).rejects.toMatchObject({ status: 403, message: 'Forbidden' });
	expect(mocks.requireRunPermission).toHaveBeenCalledWith(
		{ userId: 'client1' },
		'run.view',
		'run1'
	);
});
```

In `tests/unit/lib/rfc/project-agent-config.remote.test.ts`, add hoisted fakes for
`requireActor` and `requirePermission`, then add:

```ts
it('getProjectAgentConfig blocks actors without project.config.view', async () => {
	mocks.requireActor.mockResolvedValue({ userId: 'client1' });
	mocks.requirePermission.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));

	await expect(getProjectAgentConfig('project1')).rejects.toMatchObject({
		status: 403,
		message: 'Forbidden'
	});
	expect(mocks.requirePermission).toHaveBeenCalledWith(
		{ userId: 'client1' },
		'project.config.view',
		{ type: 'project', id: 'project1' }
	);
});
```

In `tests/unit/lib/server/mcp/tools.test.ts`, make the project listing fake return only
actor-visible projects:

```ts
it('list_projects returns only actor-accessible projects', async () => {
	mocks.resolveMcpActor.mockResolvedValue({ userId: 'client1' });
	mocks.listAccessibleProjects.mockResolvedValue([{ id: 'project1', name: 'visible-repo' }]);

	const result = await callTool('list_projects', {});

	expect(result.isError).toBeUndefined();
	expect(JSON.parse(result.content[0].text)).toEqual([{ id: 'project1', name: 'visible-repo' }]);
	expect(mocks.listAccessibleProjects).toHaveBeenCalledWith({ userId: 'client1' });
});
```

- [ ] **Step 8: Run guarded surface tests**

Run:

```bash
bun run test:unit -- tests/unit/lib/rfc/runs.remote.test.ts tests/unit/lib/rfc/project-agent-config.remote.test.ts tests/unit/lib/rfc/project-environments.remote.test.ts tests/unit/lib/rfc/project-environment-services.remote.test.ts tests/unit/lib/server/mcp/tools.test.ts --run
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/rfc src/routes/api src/lib/server/mcp tests/unit/lib/rfc tests/unit/lib/server/mcp
git commit -m "feat(authz): enforce permissions on project operations"
```

---

### Task 7: Client Management and Project Access UI

**Files:**

- Create: `src/lib/components/clients/ClientDirectory.svelte`
- Create: `src/lib/components/clients/ClientAccessPanel.svelte`
- Create: `src/routes/(app)/accept-client-invitation/[id]/+page.svelte`
- Modify: `src/routes/(app)/teams/[slug]/+page.svelte`
- Modify: `src/routes/(app)/projects/[id]/+page.svelte`
- Modify: `src/routes/(app)/projects/+page.svelte`
- Modify: `src/routes/(app)/+layout.svelte`
- Modify: `src/lib/components/layout/AppSidebar.svelte`
- Modify: `src/lib/components/layout/AppTopbar.svelte`
- Create: `tests/unit/routes/client-access-panel.svelte.test.ts`

- [ ] **Step 1: Create ClientDirectory component**

Create `src/lib/components/clients/ClientDirectory.svelte`:

```svelte
<script lang="ts">
	import { createClient, inviteClient, listClients } from '$lib/rfc/client-access.remote';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Alert from '$lib/components/ui/alert';
	import * as Card from '$lib/components/ui/card';
	import { Building2, MailPlus } from '@lucide/svelte';

	const clients = listClients();

	let clientName = $state('');
	let inviteEmailByClient = $state<Record<string, string>>({});
	let errorMessage = $state<string | null>(null);
	let lastInviteLink = $state<string | null>(null);

	async function handleCreateClient() {
		errorMessage = null;
		try {
			await createClient({ name: clientName });
			clientName = '';
			await listClients().refresh();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Could not create client';
		}
	}

	async function handleInvite(clientOrganizationId: string) {
		errorMessage = null;
		const email = inviteEmailByClient[clientOrganizationId]?.trim() ?? '';
		try {
			const result = await inviteClient({ clientOrganizationId, email, role: 'member' });
			lastInviteLink = `${location.origin}/accept-client-invitation/${result.invitationId}`;
			inviteEmailByClient[clientOrganizationId] = '';
			await listClients().refresh();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Could not invite client contact';
		}
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Clients</Card.Title>
		<Card.Description>Manage external client organizations and contacts.</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		{#if errorMessage}
			<Alert.Root variant="destructive">
				<Alert.Description>{errorMessage}</Alert.Description>
			</Alert.Root>
		{/if}

		<div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
			<div class="space-y-2">
				<Label for="client-name">Client name</Label>
				<Input id="client-name" bind:value={clientName} placeholder="Acme" />
			</div>
			<Button class="self-end" onclick={handleCreateClient} disabled={clientName.trim().length < 2}>
				<Building2 class="size-4" strokeWidth={1.8} />
				Add client
			</Button>
		</div>

		{#if lastInviteLink}
			<div class="rounded-lg border bg-muted/20 p-3">
				<p class="text-xs text-muted-foreground">Invitation link</p>
				<code class="block truncate text-xs">{lastInviteLink}</code>
			</div>
		{/if}

		{#if clients.error}
			<Alert.Root variant="destructive">
				<Alert.Description>{clients.error.message}</Alert.Description>
			</Alert.Root>
		{:else if clients.current}
			<ul class="space-y-3">
				{#each clients.current as client (client.id)}
					<li class="rounded-lg border p-3">
						<div class="flex items-center justify-between gap-3">
							<div class="min-w-0">
								<p class="truncate text-sm font-medium">{client.name}</p>
								<p class="text-xs text-muted-foreground">
									{client.members.length} contact{client.members.length === 1 ? '' : 's'}
								</p>
							</div>
						</div>
						<div class="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
							<Input
								type="email"
								placeholder="contact@client.com"
								bind:value={inviteEmailByClient[client.id]}
								aria-label={`Invite contact to ${client.name}`}
							/>
							<Button variant="outline" onclick={() => handleInvite(client.id)}>
								<MailPlus class="size-4" strokeWidth={1.8} />
								Invite
							</Button>
						</div>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-sm text-muted-foreground">Loading clients</p>
		{/if}
	</Card.Content>
</Card.Root>
```

Run Svelte autofixer before committing this component:

```text
Use mcp__svelte.svelte_autofixer with filename "ClientDirectory.svelte", desired_svelte_version 5.
```

- [ ] **Step 2: Create ClientAccessPanel component**

Create `src/lib/components/clients/ClientAccessPanel.svelte`:

```svelte
<script lang="ts">
	import { permissionPresets, type PermissionPresetKey } from '$lib/authz/permissions';
	import {
		getProjectAccess,
		listClients,
		removeProjectAccess,
		upsertProjectAccess
	} from '$lib/rfc/client-access.remote';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import * as Alert from '$lib/components/ui/alert';
	import { ShieldCheck, Trash2 } from '@lucide/svelte';

	type Props = {
		projectId: string;
		canManageAccess?: boolean;
	};

	let { projectId, canManageAccess = false }: Props = $props();

	const clients = listClients();
	const access = getProjectAccess(projectId);

	let selectedSubjectId = $state('');
	let selectedPreset = $state<PermissionPresetKey>('project_access');
	let errorMessage = $state<string | null>(null);

	async function handleGrant() {
		errorMessage = null;
		try {
			await upsertProjectAccess({
				projectId,
				subjectType: 'client_organization',
				subjectId: selectedSubjectId,
				preset: selectedPreset
			});
			await getProjectAccess(projectId).refresh();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Could not update access';
		}
	}

	async function handleRemove(subjectType: 'client_organization' | 'client_member', subjectId: string) {
		errorMessage = null;
		try {
			await removeProjectAccess({ projectId, subjectType, subjectId });
			await getProjectAccess(projectId).refresh();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Could not remove access';
		}
	}
</script>

{#if canManageAccess}
	<Card.Root>
		<Card.Header>
			<Card.Title>Client access</Card.Title>
			<Card.Description>Grant external clients scoped access to this project.</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#if errorMessage}
				<Alert.Root variant="destructive">
					<Alert.Description>{errorMessage}</Alert.Description>
				</Alert.Root>
			{/if}

			<div class="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(12rem,16rem)_auto]">
				<Select.Root type="single" bind:value={selectedSubjectId}>
					<Select.Trigger aria-label="Select client">
						{clients.current?.find((client) => client.id === selectedSubjectId)?.name ?? 'Select client'}
					</Select.Trigger>
					<Select.Content>
						{#each clients.current ?? [] as client (client.id)}
							<Select.Item value={client.id} label={client.name} />
						{/each}
					</Select.Content>
				</Select.Root>

				<Select.Root type="single" bind:value={selectedPreset}>
					<Select.Trigger aria-label="Select access preset">
						{permissionPresets[selectedPreset].label}
					</Select.Trigger>
					<Select.Content>
						{#each Object.entries(permissionPresets) as [key, preset] (key)}
							<Select.Item value={key} label={preset.label} />
						{/each}
					</Select.Content>
				</Select.Root>

				<Button onclick={handleGrant} disabled={!selectedSubjectId}>
					<ShieldCheck class="size-4" strokeWidth={1.8} />
					Grant
				</Button>
			</div>

			<ul class="space-y-2">
				{#each access.current ?? [] as grant (grant.id)}
					<li class="flex items-center justify-between gap-3 rounded-lg border p-3">
						<div class="min-w-0">
							<p class="truncate text-sm font-medium">{grant.subjectType}: {grant.subjectId}</p>
							<p class="truncate text-xs text-muted-foreground">{grant.permissions.join(', ')}</p>
						</div>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Remove client access"
							onclick={() => handleRemove(grant.subjectType, grant.subjectId)}
						>
							<Trash2 class="size-4" strokeWidth={1.8} />
						</Button>
					</li>
				{/each}
			</ul>
		</Card.Content>
	</Card.Root>
{/if}
```

Run Svelte autofixer:

```text
Use mcp__svelte.svelte_autofixer with filename "ClientAccessPanel.svelte", desired_svelte_version 5.
```

- [ ] **Step 3: Wire team page**

Modify `src/routes/(app)/teams/[slug]/+page.svelte`:

```svelte
import ClientDirectory from '$lib/components/clients/ClientDirectory.svelte';
```

Render below the existing pending invitations card:

```svelte
<ClientDirectory />
```

- [ ] **Step 4: Wire project page**

Modify `src/routes/(app)/projects/[id]/+page.svelte`:

```svelte
import ClientAccessPanel from '$lib/components/clients/ClientAccessPanel.svelte';
```

Render near project settings/actions:

```svelte
<ClientAccessPanel projectId={project.id} canManageAccess={true} />
```

When implementing, replace `true` with a value returned by `getProject` or a small `getProjectPermissions(projectId)` query if the page needs to hide the panel for clients without `project.manage_access`.

- [ ] **Step 5: Add client invitation acceptance page**

Create `src/routes/(app)/accept-client-invitation/[id]/+page.svelte`:

```svelte
<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { acceptClientInvitation } from '$lib/rfc/client-access.remote';
	import { Button } from '$lib/components/ui/button';
	import * as Alert from '$lib/components/ui/alert';

	const invitationId = $derived(page.params.id ?? '');
	let status = $state<'idle' | 'accepting' | 'accepted' | 'error'>('idle');
	let message = $state<string | null>(null);

	async function accept() {
		status = 'accepting';
		message = null;
		try {
			await acceptClientInvitation(invitationId);
			status = 'accepted';
			message = 'Invitation accepted.';
		} catch (err) {
			status = 'error';
			message = err instanceof Error ? err.message : 'Could not accept invitation';
		}
	}
</script>

<div class="mx-auto flex max-w-lg flex-col gap-4 p-6">
	<h1 class="text-2xl font-semibold">Accept client invitation</h1>

	{#if message}
		<Alert.Root variant={status === 'error' ? 'destructive' : 'default'}>
			<Alert.Description>{message}</Alert.Description>
		</Alert.Root>
	{/if}

	<div class="flex gap-2">
		<Button onclick={accept} disabled={status === 'accepting' || status === 'accepted'}>
			{status === 'accepting' ? 'Accepting' : 'Accept invitation'}
		</Button>
		{#if status === 'accepted'}
			<Button variant="outline" onclick={() => goto('/projects')}>Open projects</Button>
		{/if}
	</div>
</div>
```

Run Svelte autofixer:

```text
Use mcp__svelte.svelte_autofixer with filename "+page.svelte", desired_svelte_version 5.
```

- [ ] **Step 6: Make app shell client-safe**

Update `listMyTeams` in `src/lib/rfc/teams.remote.ts` to return:

```ts
return {
	teams,
	activeOrganizationId: effectiveActiveOrganizationId,
	hasInternalTeams: teams.length > 0,
	hasClientAccess: actor.clientMemberships.length > 0
};
```

Update `src/routes/(app)/+layout.svelte` derived state:

```ts
const hasInternalTeams = $derived(myTeams.current?.hasInternalTeams ?? false);
const hasClientAccess = $derived(myTeams.current?.hasClientAccess ?? false);
```

Pass those props to `AppSidebar` and `AppTopbar`. In both components:

- hide the team selector when `!hasInternalTeams && hasClientAccess`;
- hide `Teams`, `Mail`, and `Connecteurs` nav items for external-only users;
- keep `Projects` visible.

- [ ] **Step 7: Run Svelte checks**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 8: Add component tests**

Create `tests/unit/routes/client-access-panel.svelte.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ClientAccessPanel from '$lib/components/clients/ClientAccessPanel.svelte';

const mocks = vi.hoisted(() => ({
	upsertProjectAccess: vi.fn(),
	removeProjectAccess: vi.fn(),
	accessRefresh: vi.fn()
}));

vi.mock('$lib/rfc/client-access.remote', () => ({
	listClients: vi.fn(() => ({
		current: [{ id: 'client1', name: 'Acme', members: [] }],
		error: undefined,
		refresh: vi.fn()
	})),
	getProjectAccess: vi.fn(() => ({
		current: [
			{
				id: 'grant1',
				subjectType: 'client_organization',
				subjectId: 'client1',
				permissions: ['project.view']
			}
		],
		error: undefined,
		refresh: mocks.accessRefresh
	})),
	upsertProjectAccess: mocks.upsertProjectAccess,
	removeProjectAccess: mocks.removeProjectAccess
}));

describe('ClientAccessPanel', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.upsertProjectAccess.mockResolvedValue({ id: 'grant1' });
		mocks.removeProjectAccess.mockResolvedValue({ removed: true });
		mocks.accessRefresh.mockResolvedValue(undefined);
	});

	it('does not render access management when canManageAccess is false', async () => {
		const screen = render(ClientAccessPanel, { projectId: 'project1', canManageAccess: false });

		await expect.element(screen.getByText('Client access')).not.toBeInTheDocument();
	});

	it('renders preset labels for users who can manage access', async () => {
		const screen = render(ClientAccessPanel, { projectId: 'project1', canManageAccess: true });

		await expect.element(screen.getByText('Client access')).toBeInTheDocument();
		await expect.element(screen.getByText('Accès projet')).toBeInTheDocument();
		await screen.getByLabelText('Select access preset').click();
		await expect.element(screen.getByText('Reviewer')).toBeInTheDocument();
	});
});
```

Run:

```bash
bun run test:unit -- tests/unit/routes/client-access-panel.svelte.test.ts --run
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/components/clients src/routes/'(app)'/accept-client-invitation src/routes/'(app)'/teams/'[slug]'/+page.svelte src/routes/'(app)'/projects src/routes/'(app)'/+layout.svelte src/lib/components/layout tests/unit/routes/client-access-panel.svelte.test.ts
git commit -m "feat(authz): add client access management ui"
```

---

### Task 8: End-to-End Verification

**Files:**

- Create: `tests/e2e/client-access.e2e.ts`
- Modify: `tests/e2e/helpers.ts`

- [ ] **Step 1: Add an e2e helper for team creation**

Modify `tests/e2e/helpers.ts`:

```ts
export async function createTeam(page: Page, teamName: string): Promise<void> {
	await page.goto('/teams');
	await page.waitForLoadState('networkidle');
	await page.getByLabel('Team name').fill(teamName);
	await page.getByRole('button', { name: 'Create' }).click();
	await page.waitForURL('**/teams/**', { timeout: 15000 });
}
```

- [ ] **Step 2: Add client access E2E test**

Create `tests/e2e/client-access.e2e.ts`:

```ts
import { test, expect } from '@playwright/test';
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createTeam, registerUser, uniqueEmail } from './helpers';

function prismaClient() {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) throw new Error('DATABASE_URL is required for client access e2e');
	return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

test('external client sees only explicitly granted projects', async ({ browser }) => {
	const ownerEmail = uniqueEmail();
	const clientEmail = uniqueEmail();
	const teamName = `E2E Team ${Date.now()}`;
	const prisma = prismaClient();

	const ownerPage = await browser.newPage();
	await registerUser(ownerPage, ownerEmail, undefined, 'Owner User');
	await createTeam(ownerPage, teamName);
	const teamSlug = ownerPage.url().split('/teams/')[1];

	await ownerPage.goto('/teams');
	await ownerPage.waitForLoadState('networkidle');
	await ownerPage.getByLabel('Client name').fill('Acme Client');
	await ownerPage.getByRole('button', { name: 'Add client' }).click();
	await expect(ownerPage.getByText('Acme Client')).toBeVisible();

	await ownerPage.getByLabel('Invite contact to Acme Client').fill(clientEmail);
	await ownerPage.getByRole('button', { name: 'Invite' }).click();
	await expect(ownerPage.getByText('/accept-client-invitation/')).toBeVisible();
	const inviteLink = await ownerPage.locator('code').last().innerText();

	const clientPage = await browser.newPage();
	await registerUser(clientPage, clientEmail, undefined, 'Client User');
	await clientPage.goto(inviteLink);
	await clientPage.getByRole('button', { name: 'Accept invitation' }).click();
	await expect(clientPage.getByText('Invitation accepted.')).toBeVisible();

	const [organization, owner, clientUser] = await Promise.all([
		prisma.organization.findUniqueOrThrow({ where: { slug: teamSlug } }),
		prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } }),
		prisma.user.findUniqueOrThrow({ where: { email: clientEmail } })
	]);
	const clientOrganization = await prisma.clientOrganization.findFirstOrThrow({
		where: { organizationId: organization.id, name: 'Acme Client' }
	});
	const clientMember = await prisma.clientOrganizationMember.findFirstOrThrow({
		where: { clientOrganizationId: clientOrganization.id, userId: clientUser.id }
	});
	const visibleProject = await prisma.project.create({
		data: {
			organizationId: organization.id,
			githubRepoId: `${Date.now()}-visible`,
			owner: 'acme',
			name: 'visible-repo',
			defaultBranch: 'main',
			cloneUrl: 'https://github.com/acme/visible-repo.git',
			private: false,
			importedById: owner.id
		}
	});
	await prisma.project.create({
		data: {
			organizationId: organization.id,
			githubRepoId: `${Date.now()}-hidden`,
			owner: 'acme',
			name: 'hidden-repo',
			defaultBranch: 'main',
			cloneUrl: 'https://github.com/acme/hidden-repo.git',
			private: false,
			importedById: owner.id
		}
	});
	await prisma.accessGrant.create({
		data: {
			organizationId: organization.id,
			subjectType: 'client_member',
			subjectId: clientMember.id,
			resourceType: 'project',
			resourceId: visibleProject.id,
			permissions: ['project.view'],
			createdById: owner.id
		}
	});

	await clientPage.goto('/projects');
	await expect(clientPage.getByText('visible-repo')).toBeVisible();
	await expect(clientPage.getByText('hidden-repo')).not.toBeVisible();
	await expect(clientPage.getByRole('button', { name: 'Import repository' })).not.toBeVisible();

	await prisma.$disconnect();
	await ownerPage.close();
	await clientPage.close();
});
```

- [ ] **Step 3: Run targeted E2E**

Run:

```bash
bun run test:e2e -- tests/e2e/client-access.e2e.ts
```

Expected: PASS in the local E2E environment.

- [ ] **Step 4: Run full verification**

Run:

```bash
bun run check
bun run test:unit -- --run
bun run test:e2e
```

Expected: all commands PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/client-access.e2e.ts tests/e2e/helpers.ts
git commit -m "test(authz): cover client project access flow"
```

---

## Implementation Notes

- Use `requireActiveOrg` only for actions that must remain internal-team scoped, such as importing GitHub repositories and creating client organizations from a selected team.
- Use `requireActor` and `requirePermission` for all resource reads and mutations that may be available to external clients.
- For external clients, `project.view` does not imply `run.view`.
- For internal team members, preserve current access behavior in the first version.
- Use Svelte 5 `onclick`, `$state`, `$derived`, and keyed `{#each}` blocks.
- After writing or changing any Svelte component, run `mcp__svelte.svelte_autofixer` until it returns no issues.
- Avoid placing authz code under `src/lib/server` if the UI needs to import labels or presets. Shared permission metadata belongs in `src/lib/authz`.

## Self-Review Checklist

- Spec coverage: tasks cover client organizations, client contacts, inherited grants, individual grants, permission registry, project visibility, protected runs/config/SSE/MCP, presets UI, and tests.
- No deny rules are included.
- No internal team role refinement is included.
- Permission names are consistent with the spec: `project.view`, `project.manage_access`, `project.config.view`, `project.config.manage`, `run.view`, `run.create`, `run.reply`, `run.diff.view`, `run.approve`.
- DB stores permission strings; TypeScript registry validates them.
- Client users are not Better Auth organization members.
