CREATE TABLE "slack_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"slack_app_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"slack_user_id" text,
	"session_id" uuid,
	"body" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claim_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"slack_ts" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigserial NOT NULL,
	CONSTRAINT "slack_outbox_dedupe_key" UNIQUE("dedupe_key"),
	CONSTRAINT "slack_outbox_kind_check" CHECK ("slack_outbox"."kind" IN ('reply', 'notice', 'failure_notice', 'input_notice')),
	CONSTRAINT "slack_outbox_status_check" CHECK ("slack_outbox"."status" IN ('pending', 'sending', 'sent', 'failed', 'uncertain')),
	CONSTRAINT "slack_outbox_user_check" CHECK (("slack_outbox"."kind" = 'notice') = ("slack_outbox"."slack_user_id" IS NOT NULL)),
	CONSTRAINT "slack_outbox_claim_check" CHECK (("slack_outbox"."claim_token" IS NULL) = ("slack_outbox"."lease_expires_at" IS NULL) AND ("slack_outbox"."status" IN ('pending', 'sending') OR "slack_outbox"."claim_token" IS NULL) AND ("slack_outbox"."status" <> 'sending' OR "slack_outbox"."claim_token" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_slack_app_id_slack_apps_id_fk" FOREIGN KEY ("slack_app_id") REFERENCES "public"."slack_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_outbox_due_idx" ON "slack_outbox" USING btree ("next_attempt_at") WHERE "slack_outbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "slack_outbox_sending_idx" ON "slack_outbox" USING btree ("lease_expires_at") WHERE "slack_outbox"."status" = 'sending';--> statement-breakpoint
CREATE INDEX "slack_outbox_session_idx" ON "slack_outbox" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "slack_outbox_uncertain_idx" ON "slack_outbox" USING btree ("seq") WHERE "slack_outbox"."status" = 'uncertain' AND "slack_outbox"."kind" = 'reply';