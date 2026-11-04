-- migrate:no-transaction
-- Every statement may run again: a failure part way leaves the ones before
-- it committed, and the next run starts from the top. The new columns are
-- null or their constant default everywhere; each CHECK is added NOT VALID
-- and validated in its own statement, so the scan does not hold the ADD's
-- lock. Cards posted before this keep a null settle_rendered, which every
-- reader takes as open, so no backfill is needed.
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "settle_state" text;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "settle_rendered" text;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "settle_inflight_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "settle_uncertain_rev" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "settle_uncertain_latest_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "settle_claim_token" uuid;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "settle_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "settle_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "settle_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "settle_error" text;--> statement-breakpoint
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_settle_state_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_settle_state_check" CHECK ("slack_outbox"."settle_state" IN ('due', 'settled', 'abandoned')) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_settle_state_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_settle_claim_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_settle_claim_check" CHECK (("slack_outbox"."settle_claim_token" IS NULL) = ("slack_outbox"."settle_lease_expires_at" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_settle_claim_check";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "slack_outbox_settle_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "slack_outbox_settle_idx" ON "slack_outbox" USING btree ("settle_next_at") WHERE "slack_outbox"."kind" = 'input_notice' AND "slack_outbox"."status" = 'sent' AND "slack_outbox"."settle_state" IS DISTINCT FROM 'abandoned' AND ("slack_outbox"."settle_state" IS DISTINCT FROM 'settled' OR "slack_outbox"."settle_uncertain_latest_at" IS NOT NULL);
