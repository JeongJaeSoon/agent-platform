CREATE TABLE "catalog_repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"github_repository_id" bigint,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"branch" text NOT NULL,
	"profiles" jsonb,
	"app_role" text DEFAULT 'author' NOT NULL,
	"source" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	CONSTRAINT "catalog_repositories_source_check" CHECK ("catalog_repositories"."source" IN ('seed', 'console')),
	CONSTRAINT "catalog_repositories_app_role_check" CHECK ("catalog_repositories"."app_role" = 'author'),
	CONSTRAINT "catalog_repositories_version_check" CHECK ("catalog_repositories"."version" >= 1),
	CONSTRAINT "catalog_repositories_console_id_check" CHECK ("catalog_repositories"."source" = 'seed' OR "catalog_repositories"."github_repository_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "catalog_repositories" ADD CONSTRAINT "catalog_repositories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_repositories" ADD CONSTRAINT "catalog_repositories_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_repositories" ADD CONSTRAINT "catalog_repositories_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_repositories_github_id_key" ON "catalog_repositories" USING btree ("github_repository_id") WHERE "catalog_repositories"."removed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_repositories_full_name_key" ON "catalog_repositories" USING btree (lower("owner"),lower("name")) WHERE "catalog_repositories"."removed_at" IS NULL;