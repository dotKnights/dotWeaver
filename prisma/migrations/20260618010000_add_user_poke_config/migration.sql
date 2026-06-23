CREATE TABLE "user_poke_config" (
    "userId" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastNotifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_poke_config_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "user_poke_config"
ADD CONSTRAINT "user_poke_config_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "user"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
