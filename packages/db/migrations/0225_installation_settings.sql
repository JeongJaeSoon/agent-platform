CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"credential_ref" text NOT NULL,
	"auth" jsonb NOT NULL,
	"credential_source" text NOT NULL,
	"workspaces" jsonb NOT NULL,
	"origin" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_credential_source_check" CHECK ("mcp_servers"."credential_source" IN ('stored', 'external')),
	CONSTRAINT "mcp_servers_origin_check" CHECK ("mcp_servers"."origin" IN ('import', 'console')),
	CONSTRAINT "mcp_servers_console_stored_check" CHECK ("mcp_servers"."origin" <> 'console' OR "mcp_servers"."credential_source" = 'stored'),
	CONSTRAINT "mcp_servers_github_reserved_check" CHECK ("mcp_servers"."id" <> 'github')
);
--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"definition" jsonb NOT NULL,
	"credential_source" text NOT NULL,
	"origin" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_connections_credential_source_check" CHECK ("provider_connections"."credential_source" IN ('stored', 'external')),
	CONSTRAINT "provider_connections_origin_check" CHECK ("provider_connections"."origin" IN ('import', 'console')),
	CONSTRAINT "provider_connections_console_stored_check" CHECK ("provider_connections"."origin" <> 'console' OR "provider_connections"."credential_source" = 'stored')
);
--> statement-breakpoint
CREATE TABLE "settings_generation" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "settings_generation_single_check" CHECK ("settings_generation"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "catalog_repositories" DROP CONSTRAINT "catalog_repositories_source_check";--> statement-breakpoint
ALTER TABLE "catalog_repositories" DROP CONSTRAINT "catalog_repositories_console_id_check";--> statement-breakpoint
DROP INDEX "catalog_repositories_full_name_key";--> statement-breakpoint
ALTER TABLE "catalog_repositories" ADD COLUMN "auth_kind" text DEFAULT 'github_app' NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_repositories" ADD COLUMN "auth" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_repositories" ADD COLUMN "credential_source" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_disabled_by_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_disabled_by_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_repositories_full_name_key" ON "catalog_repositories" USING btree (lower("owner"),lower("name")) WHERE "catalog_repositories"."removed_at" IS NULL AND "catalog_repositories"."auth_kind" = 'github_app';--> statement-breakpoint
ALTER TABLE "catalog_repositories" ADD CONSTRAINT "catalog_repositories_auth_kind_check" CHECK ("catalog_repositories"."auth_kind" IN ('github_app', 'none', 'basic', 'bearer', 'github_app_explicit'));--> statement-breakpoint
ALTER TABLE "catalog_repositories" ADD CONSTRAINT "catalog_repositories_credential_check" CHECK (CASE "catalog_repositories"."auth_kind"
        WHEN 'github_app' THEN "catalog_repositories"."auth" IS NULL AND "catalog_repositories"."credential_source" IS NULL
        WHEN 'none' THEN "catalog_repositories"."auth" IS NULL AND "catalog_repositories"."credential_source" IS NULL
        WHEN 'github_app_explicit' THEN "catalog_repositories"."auth" IS NOT NULL AND "catalog_repositories"."credential_source" = 'external'
        ELSE "catalog_repositories"."auth" IS NOT NULL AND "catalog_repositories"."credential_source" IN ('stored', 'external')
      END);--> statement-breakpoint
ALTER TABLE "catalog_repositories" ADD CONSTRAINT "catalog_repositories_source_check" CHECK ("catalog_repositories"."source" IN ('seed', 'console', 'selection', 'import'));--> statement-breakpoint
ALTER TABLE "catalog_repositories" ADD CONSTRAINT "catalog_repositories_console_id_check" CHECK ("catalog_repositories"."auth_kind" <> 'github_app' OR "catalog_repositories"."source" = 'seed' OR "catalog_repositories"."github_repository_id" IS NOT NULL);--> statement-breakpoint
INSERT INTO "settings_generation" ("id", "generation") VALUES (1, 0) ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "bump_settings_generation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "settings_generation" SET "generation" = "generation" + 1 WHERE "id" = 1;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "provider_connections_settings_generation" AFTER INSERT OR UPDATE OR DELETE ON "provider_connections" FOR EACH ROW EXECUTE FUNCTION "bump_settings_generation"();--> statement-breakpoint
CREATE TRIGGER "mcp_servers_settings_generation" AFTER INSERT OR UPDATE OR DELETE ON "mcp_servers" FOR EACH ROW EXECUTE FUNCTION "bump_settings_generation"();--> statement-breakpoint
CREATE TRIGGER "catalog_repositories_settings_generation" AFTER INSERT OR UPDATE OR DELETE ON "catalog_repositories" FOR EACH ROW EXECUTE FUNCTION "bump_settings_generation"();--> statement-breakpoint
CREATE TRIGGER "installation_profiles_settings_generation" AFTER INSERT OR UPDATE OR DELETE ON "installation_profiles" FOR EACH ROW EXECUTE FUNCTION "bump_settings_generation"();