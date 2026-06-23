ALTER TABLE "user"
ADD COLUMN "preferredOrganizationId" TEXT;

CREATE INDEX "user_preferredOrganizationId_idx"
ON "user"("preferredOrganizationId");

ALTER TABLE "user"
ADD CONSTRAINT "user_preferredOrganizationId_fkey"
FOREIGN KEY ("preferredOrganizationId") REFERENCES "organization"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
