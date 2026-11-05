-- migrate:no-transaction
-- Additive: a nullable column, and a CHECK that only gets looser (the
-- repository list loses its cap of 32). No existing row is changed. Every
-- statement may run again: a failure part way leaves the ones before it
-- committed, and the next run starts from the top. The CHECK is added NOT
-- VALID and validated in its own statement, as 0231 does, so the scan does
-- not hold the ADD's lock.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "github_policy_start" jsonb;--> statement-breakpoint
ALTER TABLE "agent_github_settings" DROP CONSTRAINT IF EXISTS "agent_github_settings_repositories_check";--> statement-breakpoint
ALTER TABLE "agent_github_settings" ADD CONSTRAINT "agent_github_settings_repositories_check" CHECK (jsonb_typeof("agent_github_settings"."repositories") = 'array') NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_github_settings" VALIDATE CONSTRAINT "agent_github_settings_repositories_check";
