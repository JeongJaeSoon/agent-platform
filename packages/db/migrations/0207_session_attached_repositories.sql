-- migrate:no-transaction
-- Every statement may run again: a failure part way leaves the ones before
-- it committed, and the next run starts from the top. The CHECK goes on NOT
-- VALID so adding it takes no scan under a write lock; VALIDATE then scans
-- without blocking writes.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "attached_repository_ids" text[];--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_attached_repositories_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_attached_repositories_check" CHECK ("sessions"."attached_repository_ids" IS NULL OR "sessions"."repository_mode" = 'repository') NOT VALID;--> statement-breakpoint
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_attached_repositories_check";
