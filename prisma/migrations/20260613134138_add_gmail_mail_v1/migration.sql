-- CreateEnum
CREATE TYPE "MailSyncStatus" AS ENUM ('idle', 'syncing', 'error');

-- CreateTable
CREATE TABLE "mail_thread" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gmailThreadId" TEXT NOT NULL,
    "historyId" TEXT,
    "subject" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "participants" JSONB NOT NULL,
    "fromEmail" TEXT,
    "fromName" TEXT,
    "toEmails" JSONB NOT NULL,
    "labelIds" JSONB NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "unread" BOOLEAN NOT NULL DEFAULT false,
    "starred" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_sync_state" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "windowDays" INTEGER NOT NULL DEFAULT 90,
    "nextPageToken" TEXT,
    "lastHistoryId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "status" "MailSyncStatus" NOT NULL DEFAULT 'idle',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_sync_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mail_thread_userId_lastMessageAt_idx" ON "mail_thread"("userId", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "mail_thread_userId_gmailThreadId_key" ON "mail_thread"("userId", "gmailThreadId");

-- CreateIndex
CREATE UNIQUE INDEX "mail_sync_state_userId_key" ON "mail_sync_state"("userId");

-- AddForeignKey
ALTER TABLE "mail_thread" ADD CONSTRAINT "mail_thread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_sync_state" ADD CONSTRAINT "mail_sync_state_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
