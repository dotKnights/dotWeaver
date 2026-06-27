CREATE TYPE "ProjectEnvironmentServiceKind" AS ENUM ('postgres', 'redis');
CREATE TYPE "ProjectEnvironmentServiceStatus" AS ENUM (
  'configured',
  'provisioning',
  'ready',
  'failed',
  'disabled'
);
CREATE TYPE "ProjectEnvironmentServiceEventType" AS ENUM (
  'system',
  'output',
  'error',
  'result'
);

CREATE TABLE "project_environment_service" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "kind" "ProjectEnvironmentServiceKind" NOT NULL,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "status" "ProjectEnvironmentServiceStatus" NOT NULL DEFAULT 'configured',
  "config" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "outputs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "runtime" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "lastError" TEXT,
  "lastReadyAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "project_environment_service_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_environment_service_event" (
  "id" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "type" "ProjectEnvironmentServiceEventType" NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_environment_service_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_environment_profile_id_projectId_organizationId_key"
  ON "project_environment_profile"("id", "projectId", "organizationId");
CREATE UNIQUE INDEX "project_environment_service_profileId_name_key"
  ON "project_environment_service"("profileId", "name");
CREATE UNIQUE INDEX "project_environment_service_id_projectId_organizationId_key"
  ON "project_environment_service"("id", "projectId", "organizationId");
CREATE INDEX "project_environment_service_organizationId_projectId_profileId_idx"
  ON "project_environment_service"("organizationId", "projectId", "profileId");
CREATE UNIQUE INDEX "project_environment_service_event_serviceId_seq_key"
  ON "project_environment_service_event"("serviceId", "seq");
CREATE INDEX "project_environment_service_event_organizationId_projectId_serviceId_idx"
  ON "project_environment_service_event"("organizationId", "projectId", "serviceId");

ALTER TABLE "project_environment_prepare_event"
  DROP CONSTRAINT "project_environment_prepare_event_profileId_fkey";

ALTER TABLE "project_environment_prepare_event"
  ADD CONSTRAINT "project_environment_prepare_event_profileId_projectId_organizationId_fkey"
  FOREIGN KEY ("profileId", "projectId", "organizationId")
  REFERENCES "project_environment_profile"("id", "projectId", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_environment_service"
  ADD CONSTRAINT "project_environment_service_projectId_organizationId_fkey"
  FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_environment_service"
  ADD CONSTRAINT "project_environment_service_profileId_projectId_organizationId_fkey"
  FOREIGN KEY ("profileId", "projectId", "organizationId")
  REFERENCES "project_environment_profile"("id", "projectId", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_environment_service"
  ADD CONSTRAINT "project_environment_service_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "user"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_environment_service_event"
  ADD CONSTRAINT "project_environment_service_event_serviceId_projectId_organizationId_fkey"
  FOREIGN KEY ("serviceId", "projectId", "organizationId")
  REFERENCES "project_environment_service"("id", "projectId", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;
