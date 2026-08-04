-- CreateEnum
CREATE TYPE "GithubTriggerEventType" AS ENUM ('ISSUES_OPENED', 'ISSUE_COMMENT_CREATED', 'PULL_REQUEST_REVIEW_SUBMITTED');

-- CreateEnum
CREATE TYPE "GithubWebhookDeliveryStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "webhookSecretEncrypted" TEXT;

-- AlterTable
ALTER TABLE "run" ADD COLUMN     "githubTriggerId" TEXT,
ADD COLUMN     "webhookDeliveryId" TEXT;

-- CreateTable
CREATE TABLE "github_trigger" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "eventType" "GithubTriggerEventType" NOT NULL,
    "labelFilter" TEXT,
    "commentKeyword" TEXT,
    "baseBranchPattern" TEXT,
    "agent" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "runBaseBranch" TEXT NOT NULL DEFAULT '{{default_branch}}',
    "promptTemplate" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "github_trigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_webhook_delivery" (
    "id" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "githubDeliveryId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "action" TEXT,
    "organizationId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "GithubWebhookDeliveryStatus" NOT NULL DEFAULT 'RECEIVED',
    "errorMessage" TEXT,

    CONSTRAINT "github_webhook_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "github_trigger_projectId_idx" ON "github_trigger"("projectId");

-- CreateIndex
CREATE INDEX "github_trigger_organizationId_idx" ON "github_trigger"("organizationId");

-- CreateIndex
CREATE INDEX "github_trigger_eventType_enabled_idx" ON "github_trigger"("eventType", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "github_webhook_delivery_githubDeliveryId_key" ON "github_webhook_delivery"("githubDeliveryId");

-- CreateIndex
CREATE INDEX "github_webhook_delivery_organizationId_idx" ON "github_webhook_delivery"("organizationId");

-- CreateIndex
CREATE INDEX "github_webhook_delivery_status_idx" ON "github_webhook_delivery"("status");

-- CreateIndex
CREATE INDEX "github_webhook_delivery_receivedAt_idx" ON "github_webhook_delivery"("receivedAt");

-- CreateIndex
CREATE INDEX "run_githubTriggerId_idx" ON "run"("githubTriggerId");

-- CreateIndex
CREATE INDEX "run_webhookDeliveryId_idx" ON "run"("webhookDeliveryId");

-- AddForeignKey
ALTER TABLE "github_trigger" ADD CONSTRAINT "github_trigger_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_trigger" ADD CONSTRAINT "github_trigger_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_trigger" ADD CONSTRAINT "github_trigger_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_webhook_delivery" ADD CONSTRAINT "github_webhook_delivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run" ADD CONSTRAINT "run_githubTriggerId_fkey" FOREIGN KEY ("githubTriggerId") REFERENCES "github_trigger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run" ADD CONSTRAINT "run_webhookDeliveryId_fkey" FOREIGN KEY ("webhookDeliveryId") REFERENCES "github_webhook_delivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;
