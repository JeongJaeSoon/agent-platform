-- migrate:no-transaction
-- Every statement may run again: a failure part way leaves the ones before
-- it committed, and the next run starts from the top. The pending index is
-- built last, so once it is valid the migration is done and no re-run drops
-- it; the queued index it replaces stays until the next migration, so ON
-- CONFLICT always has one. The widened CHECK accepts every row the old one did.
CREATE TABLE IF NOT EXISTS "achievement_judgment_usage" (
	"exchange_id" text PRIMARY KEY NOT NULL,
	"judgment_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"input_tokens" bigint NOT NULL,
	"cost_usd" numeric(14, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_judgment_usage_judgment_id_achievement_judgments_id_fk" FOREIGN KEY ("judgment_id") REFERENCES "public"."achievement_judgments"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "achievement_judgment_usage_amounts_check" CHECK ("achievement_judgment_usage"."input_tokens" >= 0 AND "achievement_judgment_usage"."cost_usd" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "achievement_judgment_usage_workspace_idx" ON "achievement_judgment_usage" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "achievement_judgments" ADD COLUMN IF NOT EXISTS "token_hash" bytea;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "achievement_judgments_pending_due_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "achievement_judgments_pending_due_idx" ON "achievement_judgments" USING btree ("next_attempt_at") WHERE "achievement_judgments"."status" IN ('queued', 'running', 'deferred');--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "achievement_judgments_due_idx";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "achievement_judgments_token_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "achievement_judgments_token_uniq" ON "achievement_judgments" USING btree ("token_hash") WHERE "achievement_judgments"."token_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "achievement_judgments" DROP CONSTRAINT IF EXISTS "achievement_judgments_error_code_check";--> statement-breakpoint
ALTER TABLE "achievement_judgments" ADD CONSTRAINT "achievement_judgments_error_code_check" CHECK ("achievement_judgments"."error_code" IS NULL OR "achievement_judgments"."error_code" IN ('judge_unavailable','outputs_unavailable','session_limit')) NOT VALID;--> statement-breakpoint
ALTER TABLE "achievement_judgments" VALIDATE CONSTRAINT "achievement_judgments_error_code_check";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "achievement_judgments_pending_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "achievement_judgments_pending_uniq" ON "achievement_judgments" USING btree ("session_id") WHERE "achievement_judgments"."status" IN ('queued', 'deferred');
