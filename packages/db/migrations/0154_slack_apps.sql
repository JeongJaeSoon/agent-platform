CREATE TABLE "slack_apps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"agent_id" uuid,
	"state" text NOT NULL,
	"app_id" text,
	"client_id" text,
	"redirect_url" text NOT NULL,
	"created_by_token_user" text,
	"created_by" uuid,
	"signing_secret_ref" text,
	"client_secret_ref" text,
	"bot_token_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_apps_app_id_key" UNIQUE("app_id"),
	CONSTRAINT "slack_apps_kind_check" CHECK ("slack_apps"."kind" IN ('agent','link','manual')),
	CONSTRAINT "slack_apps_state_check" CHECK ("slack_apps"."state" IN ('creating','created','failed','abandoned','deleting','deleted')),
	CONSTRAINT "slack_apps_agent_check" CHECK (("slack_apps"."kind" = 'agent') = ("slack_apps"."agent_id" IS NOT NULL)),
	CONSTRAINT "slack_apps_created_check" CHECK ("slack_apps"."state" NOT IN ('created', 'deleting', 'deleted') OR ("slack_apps"."app_id" IS NOT NULL AND "slack_apps"."client_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "slack_config_tokens" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"access_expires_at" timestamp with time zone,
	"issuer_user_id" text,
	"issuer_team_id" text,
	"previous_issuer_user_id" text,
	"issuer_changed_at" timestamp with time zone,
	"lease_id" uuid,
	"lease_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_config_tokens_state_check" CHECK ("slack_config_tokens"."state" IN ('active', 'needs_reentry')),
	CONSTRAINT "slack_config_tokens_lease_check" CHECK (("slack_config_tokens"."lease_id" IS NULL) = ("slack_config_tokens"."lease_until" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "slack_apps" ADD CONSTRAINT "slack_apps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_apps" ADD CONSTRAINT "slack_apps_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_config_tokens" ADD CONSTRAINT "slack_config_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_apps_live_agent_idx" ON "slack_apps" USING btree ("workspace_id","agent_id") WHERE "slack_apps"."kind" = 'agent' AND "slack_apps"."state" IN ('creating', 'created', 'deleting');--> statement-breakpoint
CREATE UNIQUE INDEX "slack_apps_live_link_idx" ON "slack_apps" USING btree ("workspace_id") WHERE "slack_apps"."kind" = 'link' AND "slack_apps"."state" IN ('creating', 'created', 'deleting');