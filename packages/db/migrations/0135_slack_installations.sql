CREATE TABLE "slack_installations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"app_id" text NOT NULL,
	"team_id" text NOT NULL,
	"bot_user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "slack_installations_app_team_uniq" UNIQUE("app_id","team_id"),
	CONSTRAINT "slack_installations_status_check" CHECK ("slack_installations"."status" IN ('pending', 'verified', 'revoked')),
	CONSTRAINT "slack_installations_verified_check" CHECK ("slack_installations"."status" <> 'verified' OR ("slack_installations"."bot_user_id" IS NOT NULL AND "slack_installations"."verified_at" IS NOT NULL)),
	CONSTRAINT "slack_installations_revoked_check" CHECK (("slack_installations"."status" = 'revoked') = ("slack_installations"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;