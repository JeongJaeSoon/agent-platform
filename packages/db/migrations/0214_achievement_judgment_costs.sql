-- migrate:no-transaction
-- Every statement may run again: a failure part way leaves the ones before
-- it committed, and the next run starts from the top. The pending index is
-- built before the queued one goes, so a session never has two pending
-- judgments in between; the widened CHECK accepts every row the old one did.
ALTER TABLE "achievement_judgments" ADD COLUMN IF NOT EXISTS "token_hash" bytea;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "achievement_judgments_pending_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "achievement_judgments_pending_uniq" ON "achievement_judgments" USING btree ("session_id") WHERE "achievement_judgments"."status" IN ('queued', 'deferred');--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "achievement_judgments_queued_uniq";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "achievement_judgments_pending_due_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "achievement_judgments_pending_due_idx" ON "achievement_judgments" USING btree ("next_attempt_at") WHERE "achievement_judgments"."status" IN ('queued', 'running', 'deferred');--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "achievement_judgments_due_idx";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "achievement_judgments_token_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "achievement_judgments_token_uniq" ON "achievement_judgments" USING btree ("token_hash") WHERE "achievement_judgments"."token_hash" IS NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "achievement_judgments_workspace_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "achievement_judgments_workspace_idx" ON "achievement_judgments" USING btree ("workspace_id","finished_at");--> statement-breakpoint
ALTER TABLE "achievement_judgments" DROP CONSTRAINT IF EXISTS "achievement_judgments_error_code_check";--> statement-breakpoint
ALTER TABLE "achievement_judgments" ADD CONSTRAINT "achievement_judgments_error_code_check" CHECK ("achievement_judgments"."error_code" IS NULL OR "achievement_judgments"."error_code" IN ('judge_unavailable','outputs_unavailable','session_limit')) NOT VALID;--> statement-breakpoint
ALTER TABLE "achievement_judgments" VALIDATE CONSTRAINT "achievement_judgments_error_code_check";
