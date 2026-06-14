-- CreateTable
CREATE TABLE "project_env_var" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueEncrypted" TEXT NOT NULL,
    "sensitive" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_env_var_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_env_var_organizationId_projectId_idx" ON "project_env_var"("organizationId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_env_var_projectId_key_key" ON "project_env_var"("projectId", "key");

-- AddForeignKey
ALTER TABLE "project_env_var" ADD CONSTRAINT "project_env_var_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_env_var" ADD CONSTRAINT "project_env_var_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
