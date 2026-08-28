CREATE TABLE IF NOT EXISTS "sso_token" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "redirect_to" text NOT NULL DEFAULT '/inbox',
  "used_at" timestamp,
  "expires_at" timestamp NOT NULL
);
