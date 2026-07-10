import 'dotenv/config';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const connectionString = process.env.DATABASE_URL;
const dbDescribe = connectionString ? describe : describe.skip;

type Fixture = {
	userId: string;
	organizationId: string;
	projectId: string;
	clientOrganizationId: string;
	clientMemberId: string;
};

type CountRow = { count: number | bigint };

const ACCESS_GRANT_INSERT_PAUSE_LOCK = 74_613_901;

let prisma: PrismaClient;
const createdUsers = new Set<string>();
const createdOrganizations = new Set<string>();

function createPrisma(): PrismaClient {
	const adapter = new PrismaPg({ connectionString: connectionString! });
	return new PrismaClient({ adapter });
}

function id(prefix: string): string {
	return `${prefix}-${randomUUID()}`;
}

async function ensureClientAccessSchema() {
	const [row] = await prisma.$queryRaw<
		Array<{ accessGrant: string | null; validateFn: string | null }>
	>`
		SELECT
			to_regclass('public.access_grant')::text AS "accessGrant",
			to_regprocedure('public.validate_access_grant_references()')::text AS "validateFn"
	`;

	if (!row?.accessGrant || !row.validateFn) {
		throw new Error(
			'Client access migration is not applied to DATABASE_URL; run Prisma migrations before this integration test.'
		);
	}
}

async function seedFixture(label: string): Promise<Fixture> {
	const fixture = {
		userId: id(`${label}-user`),
		organizationId: id(`${label}-org`),
		projectId: id(`${label}-project`),
		clientOrganizationId: id(`${label}-client-org`),
		clientMemberId: id(`${label}-client-member`)
	};
	const slug = fixture.organizationId.toLowerCase();

	await prisma.$executeRaw`
		INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
		VALUES (${fixture.userId}, 'Access Grant Test User', ${`${fixture.userId}@example.test`}, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
	`;
	createdUsers.add(fixture.userId);

	await prisma.$executeRaw`
		INSERT INTO "organization" ("id", "name", "slug", "createdAt")
		VALUES (${fixture.organizationId}, 'Access Grant Test Organization', ${slug}, CURRENT_TIMESTAMP)
	`;
	createdOrganizations.add(fixture.organizationId);

	await prisma.$executeRaw`
		INSERT INTO "project" ("id", "organizationId", "githubRepoId", "owner", "name", "defaultBranch", "cloneUrl", "importedById", "updatedAt")
		VALUES (${fixture.projectId}, ${fixture.organizationId}, ${id(`${label}-repo`)}, 'owner', 'repo', 'main', 'https://example.test/repo.git', ${fixture.userId}, CURRENT_TIMESTAMP)
	`;

	await prisma.$executeRaw`
		INSERT INTO "client_organization" ("id", "organizationId", "name", "slug", "createdById", "updatedAt")
		VALUES (${fixture.clientOrganizationId}, ${fixture.organizationId}, 'Client Org', ${id(`${label}-client`).toLowerCase()}, ${fixture.userId}, CURRENT_TIMESTAMP)
	`;

	await prisma.$executeRaw`
		INSERT INTO "client_organization_member" ("id", "organizationId", "clientOrganizationId", "userId")
		VALUES (${fixture.clientMemberId}, ${fixture.organizationId}, ${fixture.clientOrganizationId}, ${fixture.userId})
	`;

	return fixture;
}

async function insertProjectGrant(fixture: Fixture, grantId = id('grant')) {
	const [row] = await prisma.$queryRaw<Array<{ permissions: string[] }>>`
		INSERT INTO "access_grant" ("id", "organizationId", "subjectType", "subjectId", "resourceType", "resourceId", "createdById", "updatedAt")
		VALUES (${grantId}, ${fixture.organizationId}, 'client_organization', ${fixture.clientOrganizationId}, 'project', ${fixture.projectId}, ${fixture.userId}, CURRENT_TIMESTAMP)
		RETURNING "permissions"
	`;

	return { grantId, permissions: row?.permissions };
}

async function insertClientMemberProjectGrant(fixture: Fixture, grantId = id('grant')) {
	const [row] = await prisma.$queryRaw<Array<{ permissions: string[] }>>`
		INSERT INTO "access_grant" ("id", "organizationId", "subjectType", "subjectId", "resourceType", "resourceId", "createdById", "updatedAt")
		VALUES (${grantId}, ${fixture.organizationId}, 'client_member', ${fixture.clientMemberId}, 'project', ${fixture.projectId}, ${fixture.userId}, CURRENT_TIMESTAMP)
		RETURNING "permissions"
	`;

	return { grantId, permissions: row?.permissions };
}

async function countGrant(grantId: string): Promise<number> {
	const [row] = await prisma.$queryRaw<Array<CountRow>>`
		SELECT COUNT(*)::int AS "count"
		FROM "access_grant"
		WHERE "id" = ${grantId}
	`;
	return Number(row?.count ?? 0);
}

async function countOrphanedProjectGrant(grantId: string): Promise<number> {
	const [row] = await prisma.$queryRaw<Array<CountRow>>`
		SELECT COUNT(*)::int AS "count"
		FROM "access_grant" ag
		WHERE ag."id" = ${grantId}
			AND ag."resourceType" = 'project'
			AND NOT EXISTS (
				SELECT 1
				FROM "project" p
				WHERE p."id" = ag."resourceId"
					AND p."organizationId" = ag."organizationId"
			)
	`;
	return Number(row?.count ?? 0);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readGrantPermissions(grantId: string): Promise<string[]> {
	const [row] = await prisma.$queryRaw<Array<{ permissions: string[] }>>`
		SELECT "permissions"
		FROM "access_grant"
		WHERE "id" = ${grantId}
	`;
	return row?.permissions ?? [];
}

async function cleanup() {
	for (const organizationId of [...createdOrganizations].reverse()) {
		await prisma.$executeRaw`DELETE FROM "access_grant" WHERE "organizationId" = ${organizationId}`;
		await prisma.$executeRaw`DELETE FROM "client_invitation" WHERE "organizationId" = ${organizationId}`;
		await prisma.$executeRaw`DELETE FROM "client_organization_member" WHERE "organizationId" = ${organizationId}`;
		await prisma.$executeRaw`DELETE FROM "client_organization" WHERE "organizationId" = ${organizationId}`;
		await prisma.$executeRaw`DELETE FROM "project" WHERE "organizationId" = ${organizationId}`;
		await prisma.$executeRaw`DELETE FROM "member" WHERE "organizationId" = ${organizationId}`;
		await prisma.$executeRaw`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
		createdOrganizations.delete(organizationId);
	}

	for (const userId of [...createdUsers].reverse()) {
		await prisma.$executeRaw`DELETE FROM "user" WHERE "id" = ${userId}`;
		createdUsers.delete(userId);
	}
}

async function installPauseTrigger() {
	await prisma.$executeRawUnsafe(
		'DROP TRIGGER IF EXISTS "zz_test_pause_access_grant_insert" ON "access_grant"'
	);
	await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS zz_test_pause_access_grant_insert()');
	await prisma.$executeRawUnsafe(`
		CREATE FUNCTION zz_test_pause_access_grant_insert()
		RETURNS TRIGGER AS $$
		BEGIN
			IF current_setting('dotweaver.test_pause_access_grant_insert', true) = 'on' THEN
				PERFORM pg_advisory_xact_lock(${ACCESS_GRANT_INSERT_PAUSE_LOCK});
				PERFORM pg_sleep(1);
			END IF;

			RETURN NEW;
		END;
		$$ LANGUAGE plpgsql
	`);
	await prisma.$executeRawUnsafe(`
		CREATE TRIGGER "zz_test_pause_access_grant_insert"
		BEFORE INSERT ON "access_grant"
		FOR EACH ROW
		EXECUTE FUNCTION zz_test_pause_access_grant_insert()
	`);
}

async function dropPauseTrigger() {
	await prisma.$executeRawUnsafe(
		'DROP TRIGGER IF EXISTS "zz_test_pause_access_grant_insert" ON "access_grant"'
	);
	await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS zz_test_pause_access_grant_insert()');
}

async function waitForPauseLock(timeoutMs = 2_000) {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		const [row] = await prisma.$queryRaw<Array<{ acquired: boolean }>>`
			SELECT pg_try_advisory_xact_lock(${ACCESS_GRANT_INSERT_PAUSE_LOCK}) AS "acquired"
		`;

		if (row?.acquired === false) return;

		await delay(25);
	}

	throw new Error('Timed out waiting for paused access_grant insert');
}

dbDescribe('access grant database integrity', () => {
	beforeAll(async () => {
		prisma = createPrisma();
		await ensureClientAccessSchema();
	});

	afterEach(async () => {
		await dropPauseTrigger();
		await cleanup();
	});

	afterAll(async () => {
		await prisma?.$disconnect();
	});

	it('has a tenant identity unique index for client members', async () => {
		const [row] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
			SELECT indexdef
			FROM pg_indexes
			WHERE schemaname = 'public'
				AND tablename = 'client_organization_member'
				AND indexname = 'client_organization_member_id_organizationId_key'
		`;

		expect(row?.indexdef).toContain('UNIQUE INDEX');
		const indexedColumns = row?.indexdef
			.match(/\((?<columns>[^)]+)\)$/)
			?.groups?.columns.split(',')
			.map((column) => column.trim().replace(/^"|"$/g, ''));
		expect(indexedColumns).toEqual(['id', 'organizationId']);
	});

	it('validates grants on insert and reference-column updates only', async () => {
		const triggers = await prisma.$queryRaw<Array<{ name: string; definition: string }>>`
			SELECT tgname AS "name", pg_get_triggerdef(oid) AS "definition"
			FROM pg_trigger
			WHERE tgrelid = 'access_grant'::regclass
				AND tgname IN (
					'access_grant_validate_references_insert',
					'access_grant_validate_references_reference_update'
				)
			ORDER BY tgname
		`;

		expect(triggers.map((trigger) => trigger.name)).toEqual([
			'access_grant_validate_references_insert',
			'access_grant_validate_references_reference_update'
		]);
		expect(triggers[0]?.definition).toContain('BEFORE INSERT ON public.access_grant');
		expect(triggers[1]?.definition).toContain(
			'BEFORE UPDATE OF "organizationId", "subjectType", "subjectId", "resourceType", "resourceId"'
		);
		expect(triggers[1]?.definition).toContain('WHEN');
	});

	it('allows a valid project grant insert and defaults omitted permissions to an empty array', async () => {
		const fixture = await seedFixture('valid');

		const grant = await insertProjectGrant(fixture);

		expect(grant.permissions).toEqual([]);
		expect(await countGrant(grant.grantId)).toBe(1);
	});

	it('allows permissions-only updates without reference validation', async () => {
		const fixture = await seedFixture('permissions-update');
		const grant = await insertProjectGrant(fixture);

		await prisma.$executeRaw`
			UPDATE "access_grant"
			SET "permissions" = ARRAY['project.view', 'run.view']::TEXT[]
			WHERE "id" = ${grant.grantId}
		`;

		expect(await readGrantPermissions(grant.grantId)).toEqual(['project.view', 'run.view']);
	});

	it('rejects a project resource from another organization', async () => {
		const fixture = await seedFixture('cross-a');
		const other = await seedFixture('cross-b');

		await expect(
			prisma.$executeRaw`
				INSERT INTO "access_grant" ("id", "organizationId", "subjectType", "subjectId", "resourceType", "resourceId", "createdById", "updatedAt")
				VALUES (${id('grant')}, ${fixture.organizationId}, 'client_organization', ${fixture.clientOrganizationId}, 'project', ${other.projectId}, ${fixture.userId}, CURRENT_TIMESTAMP)
			`
		).rejects.toThrow(/Invalid access_grant project reference/);
	});

	it('rejects cross-tenant reference updates', async () => {
		const fixture = await seedFixture('reference-update-a');
		const other = await seedFixture('reference-update-b');
		const grant = await insertProjectGrant(fixture);

		await expect(
			prisma.$executeRaw`
				UPDATE "access_grant"
				SET "resourceId" = ${other.projectId}
				WHERE "id" = ${grant.grantId}
			`
		).rejects.toThrow(/Invalid access_grant project reference/);
	});

	it('rejects a client organization subject from another organization', async () => {
		const fixture = await seedFixture('cross-client-org-a');
		const other = await seedFixture('cross-client-org-b');

		await expect(
			prisma.$executeRaw`
				INSERT INTO "access_grant" ("id", "organizationId", "subjectType", "subjectId", "resourceType", "resourceId", "createdById", "updatedAt")
				VALUES (${id('grant')}, ${fixture.organizationId}, 'client_organization', ${other.clientOrganizationId}, 'project', ${fixture.projectId}, ${fixture.userId}, CURRENT_TIMESTAMP)
			`
		).rejects.toThrow(/Invalid access_grant client_organization subject/);
	});

	it('rejects a client member subject from another organization', async () => {
		const fixture = await seedFixture('cross-client-member-a');
		const other = await seedFixture('cross-client-member-b');

		await expect(
			prisma.$executeRaw`
				INSERT INTO "access_grant" ("id", "organizationId", "subjectType", "subjectId", "resourceType", "resourceId", "createdById", "updatedAt")
				VALUES (${id('grant')}, ${fixture.organizationId}, 'client_member', ${other.clientMemberId}, 'project', ${fixture.projectId}, ${fixture.userId}, CURRENT_TIMESTAMP)
			`
		).rejects.toThrow(/Invalid access_grant client_member subject/);
	});

	it('allows a valid client member grant insert', async () => {
		const fixture = await seedFixture('valid-member');

		const grant = await insertClientMemberProjectGrant(fixture);

		expect(grant.permissions).toEqual([]);
		expect(await countGrant(grant.grantId)).toBe(1);
	});

	it('cleans matching resource grants when a project is deleted', async () => {
		const fixture = await seedFixture('delete');
		const grant = await insertProjectGrant(fixture);

		await prisma.$executeRaw`
			DELETE FROM "project"
			WHERE "id" = ${fixture.projectId}
				AND "organizationId" = ${fixture.organizationId}
		`;

		expect(await countGrant(grant.grantId)).toBe(0);
	});

	it('cleans matching subject grants when a client organization is deleted', async () => {
		const fixture = await seedFixture('delete-client-org');
		const grant = await insertProjectGrant(fixture);

		await prisma.$executeRaw`
			DELETE FROM "client_organization"
			WHERE "id" = ${fixture.clientOrganizationId}
				AND "organizationId" = ${fixture.organizationId}
		`;

		expect(await countGrant(grant.grantId)).toBe(0);
	});

	it('cleans matching subject grants when a client member is deleted', async () => {
		const fixture = await seedFixture('delete-client-member');
		const grant = await insertClientMemberProjectGrant(fixture);

		await prisma.$executeRaw`
			DELETE FROM "client_organization_member"
			WHERE "id" = ${fixture.clientMemberId}
				AND "organizationId" = ${fixture.organizationId}
		`;

		expect(await countGrant(grant.grantId)).toBe(0);
	});

	it('rejects referenced-row identity and tenant updates when matching grants exist', async () => {
		const target = await seedFixture('guard-target');
		const projectFixture = await seedFixture('guard-project');
		const clientOrganizationFixture = await seedFixture('guard-client-org');
		const clientMemberFixture = await seedFixture('guard-client-member');
		await insertProjectGrant(projectFixture);
		await insertProjectGrant(clientOrganizationFixture);
		await insertClientMemberProjectGrant(clientMemberFixture);

		await expect(
			prisma.$executeRaw`
				UPDATE "project"
				SET "id" = ${id('updated-project')}
				WHERE "id" = ${projectFixture.projectId}
			`
		).rejects.toThrow(/Cannot update project identity/);
		await expect(
			prisma.$executeRaw`
				UPDATE "project"
				SET "organizationId" = ${target.organizationId}
				WHERE "id" = ${projectFixture.projectId}
			`
		).rejects.toThrow(/Cannot update project identity/);

		await expect(
			prisma.$executeRaw`
				UPDATE "client_organization"
				SET "id" = ${id('updated-client-org')}
				WHERE "id" = ${clientOrganizationFixture.clientOrganizationId}
			`
		).rejects.toThrow(/Cannot update client_organization identity/);
		await expect(
			prisma.$executeRaw`
				UPDATE "client_organization"
				SET "organizationId" = ${target.organizationId}
				WHERE "id" = ${clientOrganizationFixture.clientOrganizationId}
			`
		).rejects.toThrow(/Cannot update client_organization identity/);

		await expect(
			prisma.$executeRaw`
				UPDATE "client_organization_member"
				SET "id" = ${id('updated-client-member')}
				WHERE "id" = ${clientMemberFixture.clientMemberId}
			`
		).rejects.toThrow(/Cannot update client_organization_member identity/);
		await expect(
			prisma.$executeRaw`
				UPDATE "client_organization_member"
				SET "organizationId" = ${target.organizationId}
				WHERE "id" = ${clientMemberFixture.clientMemberId}
			`
		).rejects.toThrow(/Cannot update client_organization_member identity/);
	});

	it('does not leave an orphan when a grant insert races a project delete', async () => {
		const fixture = await seedFixture('race');
		const grantId = id('race-grant');
		const txA = createPrisma();
		const txB = createPrisma();
		let deleteSettled = false;

		try {
			await installPauseTrigger();
			const insertTx = txA.$transaction(async (tx) => {
				await tx.$executeRaw`SELECT set_config('dotweaver.test_pause_access_grant_insert', 'on', true)`;
				await tx.$executeRaw`
					INSERT INTO "access_grant" ("id", "organizationId", "subjectType", "subjectId", "resourceType", "resourceId", "createdById", "updatedAt")
					VALUES (${grantId}, ${fixture.organizationId}, 'client_organization', ${fixture.clientOrganizationId}, 'project', ${fixture.projectId}, ${fixture.userId}, CURRENT_TIMESTAMP)
				`;
			});

			await waitForPauseLock();

			const deleteProject = txB.$executeRaw`
				DELETE FROM "project"
				WHERE "id" = ${fixture.projectId}
					AND "organizationId" = ${fixture.organizationId}
			`.then((result) => {
				deleteSettled = true;
				return result;
			});

			await delay(250);
			const deleteCompletedBeforeCommit = deleteSettled;

			await insertTx;
			await deleteProject;

			expect(deleteCompletedBeforeCommit).toBe(false);
			expect(await countOrphanedProjectGrant(grantId)).toBe(0);
			expect(await countGrant(grantId)).toBe(0);
		} finally {
			await Promise.allSettled([txA.$disconnect(), txB.$disconnect()]);
		}
	});
});
