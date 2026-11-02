CREATE TABLE "catalog_repository_github_apps" (
	"repository_id" text NOT NULL,
	"role" text NOT NULL,
	"connection_id" uuid,
	"app_id" bigint NOT NULL,
	"pinned_by" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_repository_github_apps_repository_id_role_pk" PRIMARY KEY("repository_id","role"),
	CONSTRAINT "catalog_repository_github_apps_role_check" CHECK ("catalog_repository_github_apps"."role" IN ('author', 'reviewer')),
	CONSTRAINT "catalog_repository_github_apps_pinned_by_check" CHECK ("catalog_repository_github_apps"."pinned_by" IN ('selection', 'first_mint', 'admin'))
);
--> statement-breakpoint
ALTER TABLE "github_apps" DROP CONSTRAINT "github_apps_workspace_role_uniq";--> statement-breakpoint
ALTER TABLE "github_workspace_settings" ADD COLUMN "user_link_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "catalog_repository_github_apps" ADD CONSTRAINT "catalog_repository_github_apps_connection_id_github_apps_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_repository_github_apps_connection_idx" ON "catalog_repository_github_apps" USING btree ("connection_id");--> statement-breakpoint
ALTER TABLE "github_workspace_settings" ADD CONSTRAINT "github_workspace_settings_user_link_connection_id_github_apps_id_fk" FOREIGN KEY ("user_link_connection_id") REFERENCES "public"."github_apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_apps" ADD CONSTRAINT "github_apps_workspace_app_uniq" UNIQUE("workspace_id","app_id");--> statement-breakpoint
-- The author App a workspace already has is the one people link with. A
-- settings row made here reads as the never-saved ceiling, revision 0, as
-- writeOAuthSecret makes it.
INSERT INTO "github_workspace_settings" ("workspace_id", "ceiling", "revision", "user_link_connection_id")
SELECT "workspace_id", '{"workflows":false,"actions":false,"checks":false,"issues":false,"review":false}'::jsonb, 0, "id"
FROM "github_apps" WHERE "role" = 'author'
ON CONFLICT ("workspace_id") DO UPDATE SET "user_link_connection_id" = EXCLUDED."user_link_connection_id";