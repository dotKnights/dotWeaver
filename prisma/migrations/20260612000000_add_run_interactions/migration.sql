ALTER TYPE "RunStatus" ADD VALUE 'awaiting_input';

CREATE TYPE "RunInteractionKind" AS ENUM ('ask_user_question');
CREATE TYPE "RunInteractionStatus" AS ENUM ('pending', 'answered', 'canceled');

CREATE TABLE "run_interaction" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" "RunInteractionKind" NOT NULL,
    "status" "RunInteractionStatus" NOT NULL DEFAULT 'pending',
    "toolUseId" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "run_interaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "run_interaction_runId_status_idx" ON "run_interaction"("runId", "status");

CREATE UNIQUE INDEX "run_interaction_one_pending_per_run"
ON "run_interaction"("runId")
WHERE "status" = 'pending';

ALTER TABLE "run_interaction"
ADD CONSTRAINT "run_interaction_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "run"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
