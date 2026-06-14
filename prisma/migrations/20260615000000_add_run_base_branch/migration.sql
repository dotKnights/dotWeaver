ALTER TABLE "run" ADD COLUMN "baseBranch" TEXT;

UPDATE "run"
SET "baseBranch" = "project"."defaultBranch"
FROM "project"
WHERE "run"."projectId" = "project"."id";

ALTER TABLE "run" ALTER COLUMN "baseBranch" SET NOT NULL;
