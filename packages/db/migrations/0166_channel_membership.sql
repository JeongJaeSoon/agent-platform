ALTER TABLE "slack_outbox" DROP CONSTRAINT "slack_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD COLUMN "membership" text;--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD COLUMN "membership_error" text;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_kind_check" CHECK ("slack_outbox"."kind" IN ('reply', 'notice', 'failure_notice', 'input_notice', 'welcome'));--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD CONSTRAINT "surface_bindings_membership_check" CHECK (("surface_bindings"."membership" IS NULL OR "surface_bindings"."membership" IN ('joined','awaiting_invite','config_error','join_failed')) AND ("surface_bindings"."membership_error" IS NULL OR "surface_bindings"."membership" IS NOT NULL));