CREATE TYPE "ProjectMcpTransport" AS ENUM ('http', 'sse', 'stdio');
CREATE TYPE "ProjectSkillSource" AS ENUM ('manual', 'imported', 'synced');

ALTER TABLE "run"
ADD COLUMN "useProjectAgentConfig" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "agentConfigSnapshot" JSONB;

CREATE TABLE "project_mcp_server" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "transport" "ProjectMcpTransport" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL,
    "env" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_mcp_server_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_skill" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "source" "ProjectSkillSource" NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_skill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_secret" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "valueEncrypted" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_secret_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_mcp_server_projectId_name_key" ON "project_mcp_server"("projectId", "name");
CREATE INDEX "project_mcp_server_organizationId_projectId_idx" ON "project_mcp_server"("organizationId", "projectId");

CREATE UNIQUE INDEX "project_skill_projectId_name_key" ON "project_skill"("projectId", "name");
CREATE INDEX "project_skill_organizationId_projectId_idx" ON "project_skill"("organizationId", "projectId");

CREATE UNIQUE INDEX "project_secret_projectId_name_key" ON "project_secret"("projectId", "name");
CREATE INDEX "project_secret_organizationId_projectId_idx" ON "project_secret"("organizationId", "projectId");

CREATE UNIQUE INDEX "project_id_organizationId_key" ON "project"("id", "organizationId");

ALTER TABLE "project_mcp_server"
ADD CONSTRAINT "project_mcp_server_projectId_organizationId_fkey"
FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_skill"
ADD CONSTRAINT "project_skill_projectId_organizationId_fkey"
FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_secret"
ADD CONSTRAINT "project_secret_projectId_organizationId_fkey"
FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_secret"
ADD CONSTRAINT "project_secret_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "user"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
