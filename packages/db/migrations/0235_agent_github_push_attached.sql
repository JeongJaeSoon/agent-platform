-- migrate:no-transaction
-- Additive: a nullable column with no default, so no existing row changes and
-- a null reads as `ask` (what a push to an attached repository did before the
-- column). The CHECK is added NOT VALID and validated in its own statement, as
-- 0231 does, so the scan does not hold the ADD's lock. Every statement may run
-- again: a failure part way leaves the ones before it committed, and the next
-- run starts from the top.
ALTER TABLE "agent_github_settings" ADD COLUMN IF NOT EXISTS "push_attached" text;--> statement-breakpoint
ALTER TABLE "agent_github_settings" DROP CONSTRAINT IF EXISTS "agent_github_settings_push_attached_check";--> statement-breakpoint
ALTER TABLE "agent_github_settings" ADD CONSTRAINT "agent_github_settings_push_attached_check" CHECK ("agent_github_settings"."push_attached" IS NULL OR "agent_github_settings"."push_attached" IN ('allow','ask','deny')) NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_github_settings" VALIDATE CONSTRAINT "agent_github_settings_push_attached_check";
