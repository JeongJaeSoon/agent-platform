ALTER TABLE "agents" ADD COLUMN "slack_default_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_apps" ADD COLUMN "events_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_apps" ADD COLUMN "events_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slack_apps" ADD COLUMN "events_error" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_slack_default_mode_check" CHECK ("agents"."slack_default_mode" IN ('off', 'mention'));--> statement-breakpoint
ALTER TABLE "slack_apps" ADD CONSTRAINT "slack_apps_events_state_check" CHECK ("slack_apps"."events_state" IN ('pending', 'verified', 'failed'));