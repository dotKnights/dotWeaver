-- AlterEnum
ALTER TYPE "RunEventType" ADD VALUE 'user_message';

-- AlterTable
ALTER TABLE "run" ADD COLUMN     "pendingPrompt" TEXT;
