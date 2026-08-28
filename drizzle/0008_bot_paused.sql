ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "bot_paused" boolean DEFAULT false NOT NULL;
