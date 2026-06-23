CREATE TYPE "RunMode" AS ENUM ('agent', 'cdc');

ALTER TABLE "run"
ADD COLUMN "mode" "RunMode" NOT NULL DEFAULT 'agent';

CREATE UNIQUE INDEX "run_id_projectId_organizationId_key"
ON "run"("id", "projectId", "organizationId");

CREATE TABLE "cdc_document" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sourceEventSeq" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cdc_document_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cdc_document_projectId_version_key"
ON "cdc_document"("projectId", "version");

CREATE UNIQUE INDEX "cdc_document_runId_sourceEventSeq_key"
ON "cdc_document"("runId", "sourceEventSeq");

CREATE INDEX "cdc_document_organizationId_projectId_idx"
ON "cdc_document"("organizationId", "projectId");

CREATE INDEX "cdc_document_runId_idx"
ON "cdc_document"("runId");

ALTER TABLE "cdc_document"
ADD CONSTRAINT "cdc_document_projectId_organizationId_fkey"
FOREIGN KEY ("projectId", "organizationId")
REFERENCES "project"("id", "organizationId")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cdc_document"
ADD CONSTRAINT "cdc_document_runId_projectId_organizationId_fkey"
FOREIGN KEY ("runId", "projectId", "organizationId")
REFERENCES "run"("id", "projectId", "organizationId")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cdc_document"
ADD CONSTRAINT "cdc_document_createdById_fkey"
FOREIGN KEY ("createdById")
REFERENCES "user"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
