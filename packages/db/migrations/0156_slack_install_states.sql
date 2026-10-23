CREATE TABLE "slack_install_states" (
	"state_hash" "bytea" PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"slack_app_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"redirect_url" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_install_states" ADD CONSTRAINT "slack_install_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_install_states" ADD CONSTRAINT "slack_install_states_slack_app_id_slack_apps_id_fk" FOREIGN KEY ("slack_app_id") REFERENCES "public"."slack_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_install_states_expires_idx" ON "slack_install_states" USING btree ("expires_at");