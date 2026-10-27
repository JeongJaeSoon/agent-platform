ALTER TABLE "agents" DROP CONSTRAINT "agents_slack_default_mode_check";--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "slack_default_mode" SET DEFAULT 'mention';--> statement-breakpoint
-- A new channel is always in use now; the default only says whether it waits for a mention.
UPDATE "agents" SET "slack_default_mode" = 'mention' WHERE "slack_default_mode" = 'off';--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_slack_default_mode_check" CHECK ("agents"."slack_default_mode" IN ('mention', 'ambient'));