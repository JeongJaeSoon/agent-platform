CREATE TABLE "achievement_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	CONSTRAINT "achievement_categories_name_check" CHECK (char_length("achievement_categories"."name") BETWEEN 1 AND 32),
	CONSTRAINT "achievement_categories_position_check" CHECK ("achievement_categories"."position" >= 0),
	CONSTRAINT "achievement_categories_archived_check" CHECK (("achievement_categories"."archived_at" IS NULL) = ("achievement_categories"."archived_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "achievement_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"category_id" uuid NOT NULL,
	"title" text NOT NULL,
	"type_id" uuid NOT NULL,
	"definition" text NOT NULL,
	"judge" text NOT NULL,
	"agent_ids" uuid[],
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_by" uuid,
	"disabled_at" timestamp with time zone,
	"disabled_by" uuid,
	CONSTRAINT "achievement_rules_family_version_uniq" UNIQUE("family_id","version"),
	CONSTRAINT "achievement_rules_version_check" CHECK ("achievement_rules"."version" >= 1),
	CONSTRAINT "achievement_rules_title_check" CHECK (char_length("achievement_rules"."title") BETWEEN 1 AND 80),
	CONSTRAINT "achievement_rules_definition_check" CHECK (char_length("achievement_rules"."definition") BETWEEN 1 AND 2000),
	CONSTRAINT "achievement_rules_judge_check" CHECK ("achievement_rules"."judge" IN ('always','luna')),
	CONSTRAINT "achievement_rules_disabled_check" CHECK (("achievement_rules"."disabled_at" IS NULL) = ("achievement_rules"."disabled_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "achievement_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"evidence_kind" text NOT NULL,
	"builtin" boolean NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	CONSTRAINT "achievement_types_key_uniq" UNIQUE("workspace_id","key"),
	CONSTRAINT "achievement_types_key_check" CHECK ("achievement_types"."key" ~ '^[a-z][a-z0-9_]{1,40}$'),
	CONSTRAINT "achievement_types_name_check" CHECK (char_length("achievement_types"."name") BETWEEN 1 AND 40),
	CONSTRAINT "achievement_types_evidence_kind_check" CHECK ("achievement_types"."evidence_kind" IN ('github_pull_request','github_review','out_file','conversation')),
	CONSTRAINT "achievement_types_builtin_check" CHECK ("achievement_types"."builtin" = ("achievement_types"."created_by" IS NULL)),
	CONSTRAINT "achievement_types_archived_check" CHECK (("achievement_types"."archived_at" IS NULL) = ("achievement_types"."archived_by" IS NULL) AND (NOT "achievement_types"."builtin" OR "achievement_types"."archived_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "achievement_categories" ADD CONSTRAINT "achievement_categories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_categories" ADD CONSTRAINT "achievement_categories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_categories" ADD CONSTRAINT "achievement_categories_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_rules" ADD CONSTRAINT "achievement_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_rules" ADD CONSTRAINT "achievement_rules_category_id_achievement_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."achievement_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_rules" ADD CONSTRAINT "achievement_rules_type_id_achievement_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."achievement_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_rules" ADD CONSTRAINT "achievement_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_rules" ADD CONSTRAINT "achievement_rules_disabled_by_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_types" ADD CONSTRAINT "achievement_types_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_types" ADD CONSTRAINT "achievement_types_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_types" ADD CONSTRAINT "achievement_types_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "achievement_categories_live_name_uniq" ON "achievement_categories" USING btree ("workspace_id","name") WHERE "achievement_categories"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "achievement_rules_type_in_use_uniq" ON "achievement_rules" USING btree ("type_id") WHERE "achievement_rules"."superseded_by" IS NULL AND "achievement_rules"."disabled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "achievement_rules_workspace_idx" ON "achievement_rules" USING btree ("workspace_id");--> statement-breakpoint
-- Every existing workspace gets the built-in types a new one is created with.
INSERT INTO "achievement_types" ("id", "workspace_id", "key", "name", "evidence_kind", "builtin")
SELECT gen_random_uuid(), "workspaces"."id", builtin."type_key", builtin."type_name", builtin."evidence_kind", true
FROM "workspaces"
CROSS JOIN (VALUES
  ('pull_request', 'GitHub PR', 'github_pull_request'),
  ('code_review', '코드 리뷰', 'github_review'),
  ('document', '문서', 'out_file')
) AS builtin ("type_key", "type_name", "evidence_kind");