-- CreateEnum
CREATE TYPE "ClientOrganizationMemberRole" AS ENUM ('admin', 'member');

-- CreateEnum
CREATE TYPE "ClientInvitationStatus" AS ENUM ('pending', 'accepted', 'canceled', 'expired');

-- CreateEnum
CREATE TYPE "AccessGrantSubjectType" AS ENUM ('client_organization', 'client_member');

-- CreateEnum
CREATE TYPE "AccessGrantResourceType" AS ENUM ('project');

-- CreateTable
CREATE TABLE "client_organization" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_organization_member" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientOrganizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ClientOrganizationMemberRole" NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_organization_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientOrganizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "ClientOrganizationMemberRole" NOT NULL DEFAULT 'member',
    "status" "ClientInvitationStatus" NOT NULL DEFAULT 'pending',
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_grant" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subjectType" "AccessGrantSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "resourceType" "AccessGrantResourceType" NOT NULL,
    "resourceId" TEXT NOT NULL,
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_organization_organizationId_idx" ON "client_organization"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "client_organization_organizationId_slug_key" ON "client_organization"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "client_organization_id_organizationId_key" ON "client_organization"("id", "organizationId");

-- CreateIndex
CREATE INDEX "client_organization_member_organizationId_userId_idx" ON "client_organization_member"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "client_organization_member_clientOrganizationId_idx" ON "client_organization_member"("clientOrganizationId");

-- CreateIndex
CREATE UNIQUE INDEX "client_organization_member_clientOrganizationId_userId_key" ON "client_organization_member"("clientOrganizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "client_organization_member_id_organizationId_key" ON "client_organization_member"("id", "organizationId");

-- CreateIndex
CREATE INDEX "client_invitation_organizationId_idx" ON "client_invitation"("organizationId");

-- CreateIndex
CREATE INDEX "client_invitation_clientOrganizationId_idx" ON "client_invitation"("clientOrganizationId");

-- CreateIndex
CREATE INDEX "client_invitation_email_idx" ON "client_invitation"("email");

-- CreateIndex
CREATE INDEX "access_grant_organizationId_resourceType_resourceId_idx" ON "access_grant"("organizationId", "resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "access_grant_subjectType_subjectId_idx" ON "access_grant"("subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "access_grant_organizationId_subjectType_subjectId_resourceT_key" ON "access_grant"("organizationId", "subjectType", "subjectId", "resourceType", "resourceId");

-- AddForeignKey
ALTER TABLE "client_organization" ADD CONSTRAINT "client_organization_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_organization" ADD CONSTRAINT "client_organization_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_organization_member" ADD CONSTRAINT "client_organization_member_clientOrganizationId_organizati_fkey" FOREIGN KEY ("clientOrganizationId", "organizationId") REFERENCES "client_organization"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_organization_member" ADD CONSTRAINT "client_organization_member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_organization_member" ADD CONSTRAINT "client_organization_member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_invitation" ADD CONSTRAINT "client_invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_invitation" ADD CONSTRAINT "client_invitation_clientOrganizationId_organizationId_fkey" FOREIGN KEY ("clientOrganizationId", "organizationId") REFERENCES "client_organization"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_invitation" ADD CONSTRAINT "client_invitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AccessGrant is intentionally polymorphic; Prisma cannot model these conditional FKs.
CREATE FUNCTION validate_access_grant_references()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."resourceType" = 'project' THEN
    PERFORM 1
    FROM "project"
    WHERE "id" = NEW."resourceId"
      AND "organizationId" = NEW."organizationId"
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid access_grant project reference: resourceId %, organizationId %', NEW."resourceId", NEW."organizationId"
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid access_grant resourceType: %', NEW."resourceType"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."subjectType" = 'client_organization' THEN
    PERFORM 1
    FROM "client_organization"
    WHERE "id" = NEW."subjectId"
      AND "organizationId" = NEW."organizationId"
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid access_grant client_organization subject: subjectId %, organizationId %', NEW."subjectId", NEW."organizationId"
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  ELSIF NEW."subjectType" = 'client_member' THEN
    PERFORM 1
    FROM "client_organization_member"
    WHERE "id" = NEW."subjectId"
      AND "organizationId" = NEW."organizationId"
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid access_grant client_member subject: subjectId %, organizationId %', NEW."subjectId", NEW."organizationId"
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid access_grant subjectType: %', NEW."subjectType"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "access_grant_validate_references_insert"
BEFORE INSERT ON "access_grant"
FOR EACH ROW
EXECUTE FUNCTION validate_access_grant_references();

CREATE TRIGGER "access_grant_validate_references_reference_update"
BEFORE UPDATE OF "organizationId", "subjectType", "subjectId", "resourceType", "resourceId" ON "access_grant"
FOR EACH ROW
WHEN (
  OLD."organizationId" IS DISTINCT FROM NEW."organizationId"
  OR OLD."subjectType" IS DISTINCT FROM NEW."subjectType"
  OR OLD."subjectId" IS DISTINCT FROM NEW."subjectId"
  OR OLD."resourceType" IS DISTINCT FROM NEW."resourceType"
  OR OLD."resourceId" IS DISTINCT FROM NEW."resourceId"
)
EXECUTE FUNCTION validate_access_grant_references();

-- AccessGrant uses intentional polymorphic references; Prisma cannot express these
-- as conditional cascading FKs, so referenced-row deletes clean up matching grants.
CREATE FUNCTION cleanup_access_grants_for_project_delete()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM "access_grant"
  WHERE "resourceType" = 'project'
    AND "resourceId" = OLD."id"
    AND "organizationId" = OLD."organizationId";

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_cleanup_access_grants"
BEFORE DELETE ON "project"
FOR EACH ROW
EXECUTE FUNCTION cleanup_access_grants_for_project_delete();

CREATE FUNCTION cleanup_access_grants_for_client_organization_delete()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM "access_grant"
  WHERE "subjectType" = 'client_organization'
    AND "subjectId" = OLD."id"
    AND "organizationId" = OLD."organizationId";

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "client_organization_cleanup_access_grants"
BEFORE DELETE ON "client_organization"
FOR EACH ROW
EXECUTE FUNCTION cleanup_access_grants_for_client_organization_delete();

CREATE FUNCTION cleanup_access_grants_for_client_member_delete()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM "access_grant"
  WHERE "subjectType" = 'client_member'
    AND "subjectId" = OLD."id"
    AND "organizationId" = OLD."organizationId";

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "client_organization_member_cleanup_access_grants"
BEFORE DELETE ON "client_organization_member"
FOR EACH ROW
EXECUTE FUNCTION cleanup_access_grants_for_client_member_delete();

-- AccessGrant uses intentional polymorphic references; these update guards
-- protect polymorphic references Prisma cannot express as normal FKs.
CREATE FUNCTION reject_project_access_grant_identity_update()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD."id" IS DISTINCT FROM NEW."id" OR OLD."organizationId" IS DISTINCT FROM NEW."organizationId")
    AND EXISTS (
      SELECT 1
      FROM "access_grant"
      WHERE "resourceType" = 'project'
        AND "resourceId" = OLD."id"
        AND "organizationId" = OLD."organizationId"
    ) THEN
    RAISE EXCEPTION 'Cannot update project identity while access_grant references exist: id %, organizationId %', OLD."id", OLD."organizationId"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_reject_access_grant_identity_update"
BEFORE UPDATE OF "id", "organizationId" ON "project"
FOR EACH ROW
EXECUTE FUNCTION reject_project_access_grant_identity_update();

CREATE FUNCTION reject_client_organization_access_grant_identity_update()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD."id" IS DISTINCT FROM NEW."id" OR OLD."organizationId" IS DISTINCT FROM NEW."organizationId")
    AND EXISTS (
      SELECT 1
      FROM "access_grant"
      WHERE "subjectType" = 'client_organization'
        AND "subjectId" = OLD."id"
        AND "organizationId" = OLD."organizationId"
    ) THEN
    RAISE EXCEPTION 'Cannot update client_organization identity while access_grant references exist: id %, organizationId %', OLD."id", OLD."organizationId"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "client_organization_reject_access_grant_identity_update"
BEFORE UPDATE OF "id", "organizationId" ON "client_organization"
FOR EACH ROW
EXECUTE FUNCTION reject_client_organization_access_grant_identity_update();

CREATE FUNCTION reject_client_member_access_grant_identity_update()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD."id" IS DISTINCT FROM NEW."id" OR OLD."organizationId" IS DISTINCT FROM NEW."organizationId")
    AND EXISTS (
      SELECT 1
      FROM "access_grant"
      WHERE "subjectType" = 'client_member'
        AND "subjectId" = OLD."id"
        AND "organizationId" = OLD."organizationId"
    ) THEN
    RAISE EXCEPTION 'Cannot update client_organization_member identity while access_grant references exist: id %, organizationId %', OLD."id", OLD."organizationId"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "client_organization_member_reject_access_grant_identity_update"
BEFORE UPDATE OF "id", "organizationId" ON "client_organization_member"
FOR EACH ROW
EXECUTE FUNCTION reject_client_member_access_grant_identity_update();
