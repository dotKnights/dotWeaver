CREATE TYPE "ProjectEnvironmentRuntime" AS ENUM ('node', 'python', 'custom');
CREATE TYPE "ProjectEnvironmentPackageManager" AS ENUM ('bun', 'npm', 'pnpm', 'yarn', 'uv', 'pip', 'poetry', 'custom');
CREATE TYPE "ProjectEnvironmentStatus" AS ENUM ('unconfigured', 'detected', 'ready', 'invalid');
CREATE TYPE "ProjectEnvironmentPrepareStatus" AS ENUM ('never', 'running', 'succeeded', 'failed');
CREATE TYPE "ProjectEnvironmentPrepareEventType" AS ENUM ('system', 'output', 'error', 'result');

ALTER TABLE "run" ADD COLUMN "environmentSnapshot" JSONB;

CREATE TABLE "project_environment_profile" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'default',
    "runtime" "ProjectEnvironmentRuntime" NOT NULL,
    "adapterId" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "packageManager" "ProjectEnvironmentPackageManager" NOT NULL,
    "installCommand" TEXT NOT NULL DEFAULT '',
    "testCommand" TEXT NOT NULL DEFAULT '',
    "buildCommand" TEXT NOT NULL DEFAULT '',
    "devCommand" TEXT NOT NULL DEFAULT '',
    "status" "ProjectEnvironmentStatus" NOT NULL DEFAULT 'detected',
    "detection" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "warnings" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "currentFingerprint" TEXT,
    "lastPreparedFingerprint" TEXT,
    "lastPreparedAt" TIMESTAMP(3),
    "lastPrepareStatus" "ProjectEnvironmentPrepareStatus" NOT NULL DEFAULT 'never',
    "lastPrepareError" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "project_environment_profile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_environment_prepare_event" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" "ProjectEnvironmentPrepareEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_environment_prepare_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_environment_profile_projectId_name_key" ON "project_environment_profile"("projectId", "name");
CREATE INDEX "project_environment_profile_organizationId_projectId_idx" ON "project_environment_profile"("organizationId", "projectId");
CREATE UNIQUE INDEX "project_environment_prepare_event_profileId_seq_key" ON "project_environment_prepare_event"("profileId", "seq");
CREATE INDEX "project_environment_prepare_event_organizationId_projectId_profileId_idx" ON "project_environment_prepare_event"("organizationId", "projectId", "profileId");

ALTER TABLE "project_environment_profile"
ADD CONSTRAINT "project_environment_profile_projectId_organizationId_fkey"
FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_environment_profile"
ADD CONSTRAINT "project_environment_profile_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "user"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_environment_prepare_event"
ADD CONSTRAINT "project_environment_prepare_event_profileId_fkey"
FOREIGN KEY ("profileId") REFERENCES "project_environment_profile"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
