ALTER TABLE "project_skill"
ADD COLUMN "sourceProvider" TEXT,
ADD COLUMN "sourcePackage" TEXT,
ADD COLUMN "sourceSkillId" TEXT,
ADD COLUMN "sourceUrl" TEXT,
ADD COLUMN "sourceHash" TEXT,
ADD COLUMN "sourceMetadata" JSONB,
ADD COLUMN "importedAt" TIMESTAMP(3);

CREATE TABLE "project_skill_file" (
  "id" TEXT NOT NULL,
  "projectSkillId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_skill_file_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_skill_file_projectSkillId_path_key"
ON "project_skill_file"("projectSkillId", "path");

ALTER TABLE "project_skill_file"
ADD CONSTRAINT "project_skill_file_projectSkillId_fkey"
FOREIGN KEY ("projectSkillId") REFERENCES "project_skill"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
