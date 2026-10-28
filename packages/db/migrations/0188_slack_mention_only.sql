ALTER TABLE "agents" DROP CONSTRAINT "agents_slack_default_mode_check";--> statement-breakpoint
ALTER TABLE "surface_bindings" DROP CONSTRAINT "surface_bindings_mode_check";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "slack_mention_only" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- The agent's choice for new channels now covers every channel; each channel's own choice is dropped.
UPDATE "agents" SET "slack_mention_only" = false WHERE "slack_default_mode" = 'ambient';--> statement-breakpoint
UPDATE "surface_bindings" SET "mode" = 'on' WHERE "mode" <> 'off';--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD CONSTRAINT "surface_bindings_mode_check" CHECK ("surface_bindings"."mode" IN ('off','on'));
