CREATE TABLE "github_workspace_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"ceiling" jsonb NOT NULL,
	"oauth_client_secret_set" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_apps" DROP CONSTRAINT "github_apps_workspace_uniq";--> statement-breakpoint
ALTER TABLE "linked_accounts" DROP CONSTRAINT "linked_accounts_provider_check";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "github_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "github_apps" ADD COLUMN "role" text DEFAULT 'author' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_apps" ADD COLUMN "permissions" jsonb;--> statement-breakpoint
ALTER TABLE "github_apps" ADD COLUMN "permissions_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_workspace_settings" ADD CONSTRAINT "github_workspace_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_apps" ADD CONSTRAINT "github_apps_workspace_role_uniq" UNIQUE("workspace_id","role");--> statement-breakpoint
ALTER TABLE "github_apps" ADD CONSTRAINT "github_apps_role_check" CHECK ("github_apps"."role" IN ('author', 'reviewer'));--> statement-breakpoint
ALTER TABLE "github_apps" ADD CONSTRAINT "github_apps_permissions_check" CHECK (("github_apps"."permissions" IS NULL) = ("github_apps"."permissions_checked_at" IS NULL));--> statement-breakpoint
ALTER TABLE "linked_accounts" ADD CONSTRAINT "linked_accounts_provider_check" CHECK ("linked_accounts"."provider" IN ('slack', 'github'));