CREATE TABLE "github_apps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"app_id" bigint NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"html_url" text NOT NULL,
	"api_base" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_apps_workspace_uniq" UNIQUE("workspace_id"),
	CONSTRAINT "github_apps_app_id_check" CHECK ("github_apps"."app_id" > 0)
);
--> statement-breakpoint
ALTER TABLE "github_apps" ADD CONSTRAINT "github_apps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;