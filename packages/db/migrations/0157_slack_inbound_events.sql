CREATE TABLE "slack_inbound_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"slack_app_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"app_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_subtype" text,
	"event_time" timestamp with time zone,
	"status" text NOT NULL,
	"drop_reason" text,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_inbound_events_team_event_key" UNIQUE("team_id","event_id"),
	CONSTRAINT "slack_inbound_events_status_check" CHECK ("slack_inbound_events"."status" IN ('received','dropped','processed')),
	CONSTRAINT "slack_inbound_events_drop_reason_check" CHECK ("slack_inbound_events"."drop_reason" IS NULL OR "slack_inbound_events"."drop_reason" IN ('not_installed','installation_unverified','installation_revoked','unidentified','identity_revoked','bot_mismatch','agent_mismatch','agent_archived','app_mismatch','bot_message','own_bot_user','message_subtype','unsupported_event','user_tokens_only')),
	CONSTRAINT "slack_inbound_events_dropped_check" CHECK (("slack_inbound_events"."status" = 'dropped') = ("slack_inbound_events"."drop_reason" IS NOT NULL) AND ("slack_inbound_events"."status" = 'dropped') = ("slack_inbound_events"."payload" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "slack_inbound_events" ADD CONSTRAINT "slack_inbound_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_inbound_events" ADD CONSTRAINT "slack_inbound_events_slack_app_id_slack_apps_id_fk" FOREIGN KEY ("slack_app_id") REFERENCES "public"."slack_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_inbound_events" ADD CONSTRAINT "slack_inbound_events_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;