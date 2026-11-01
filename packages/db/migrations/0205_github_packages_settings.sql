CREATE TABLE "github_packages_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"allowlist" jsonb NOT NULL,
	"token_login" text,
	"token_expires_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_packages_settings" ADD CONSTRAINT "github_packages_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;