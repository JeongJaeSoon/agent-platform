-- migrate:no-transaction
-- Additive only: both columns are null or their constant default on every
-- row, and an image from before neither reads nor writes them. A statement
-- may run again after a failure part way.
ALTER TABLE "github_workspace_settings" ADD COLUMN IF NOT EXISTS "pull_request" jsonb;--> statement-breakpoint
ALTER TABLE "github_workspace_settings" ADD COLUMN IF NOT EXISTS "pull_request_revision" integer DEFAULT 0 NOT NULL;
