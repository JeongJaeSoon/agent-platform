ALTER TABLE "slack_inbound_events" DROP CONSTRAINT "slack_inbound_events_team_event_key";--> statement-breakpoint
ALTER TABLE "slack_inbound_events" DROP CONSTRAINT "slack_inbound_events_status_check";--> statement-breakpoint
ALTER TABLE "slack_inbound_events" ADD COLUMN "conversation_key" text;--> statement-breakpoint
ALTER TABLE "slack_inbound_events" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "slack_inbound_events" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slack_inbound_events" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_inbound_events" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
-- Hand-written: the key the events route now computes (slackConversationKey), for rows stored before it did.
UPDATE "slack_inbound_events" SET "conversation_key" = "slack_app_id"::text || ':' || ("payload"->'event'->>'channel') || ':' || COALESCE("payload"->'event'->>'thread_ts', "payload"->'event'->>'ts') WHERE "status" <> 'dropped' AND "payload"->'event'->>'channel' IS NOT NULL AND COALESCE("payload"->'event'->>'thread_ts', "payload"->'event'->>'ts') IS NOT NULL;--> statement-breakpoint
CREATE INDEX "slack_inbound_events_due_idx" ON "slack_inbound_events" USING btree ("next_attempt_at") WHERE "slack_inbound_events"."status" = 'received';--> statement-breakpoint
CREATE INDEX "slack_inbound_events_conversation_idx" ON "slack_inbound_events" USING btree ("conversation_key","event_time","received_at") WHERE "slack_inbound_events"."status" = 'received';--> statement-breakpoint
ALTER TABLE "slack_inbound_events" ADD CONSTRAINT "slack_inbound_events_app_event_key" UNIQUE("app_id","event_id");--> statement-breakpoint
ALTER TABLE "slack_inbound_events" ADD CONSTRAINT "slack_inbound_events_conversation_check" CHECK ("slack_inbound_events"."status" <> 'dropped' OR "slack_inbound_events"."conversation_key" IS NULL);--> statement-breakpoint
ALTER TABLE "slack_inbound_events" ADD CONSTRAINT "slack_inbound_events_claim_check" CHECK (("slack_inbound_events"."claim_token" IS NULL) = ("slack_inbound_events"."lease_expires_at" IS NULL) AND ("slack_inbound_events"."status" = 'received' OR "slack_inbound_events"."claim_token" IS NULL));--> statement-breakpoint
ALTER TABLE "slack_inbound_events" ADD CONSTRAINT "slack_inbound_events_status_check" CHECK ("slack_inbound_events"."status" IN ('received','dropped','processed','failed'));