-- migrate:no-transaction
-- Every statement may run again: a failure part way leaves the ones before
-- it committed, and the next run starts from the top. The new columns are
-- null or their constant default everywhere, and no row has a pull request
-- stage yet. The outbox CHECK is added NOT VALID and validated in its own
-- statement, so the scan does not hold the ADD's lock.
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "pr_claim_token" uuid;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "pr_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "pr_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "pr_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "pr_error" text;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "pr_error_details" jsonb;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "pr_verified_number" integer;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "pr_verified_head_sha" text;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "dup_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "dup_check_claim_token" uuid;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "dup_check_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "dup_check_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "push_requests_pr_drain_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "push_requests_pr_drain_idx" ON "push_requests" USING btree ("pr_state","pr_next_attempt_at") WHERE "push_requests"."pr_state" IN ('due','opening');--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "push_requests_dup_check_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "push_requests_dup_check_idx" ON "push_requests" USING btree ("dup_check_at") WHERE "push_requests"."dup_check_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_kind_check" CHECK ("slack_outbox"."kind" IN ('instruction', 'reply', 'notice', 'failure_notice', 'input_notice', 'welcome', 'action_notice')) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_kind_check";
