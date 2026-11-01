-- Every existing row has the new column NULL and so already meets the CHECK;
-- NOT VALID only skips that scan of sessions, new writes are still checked.
ALTER TABLE "sessions" ADD COLUMN "attached_repository_ids" text[];--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_attached_repositories_check" CHECK ("sessions"."attached_repository_ids" IS NULL OR "sessions"."repository_mode" = 'repository') NOT VALID;
