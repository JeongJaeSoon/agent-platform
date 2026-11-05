-- migrate:no-transaction
-- Additive only: no row changes and no image writes the new columns or
-- tables yet. Every statement may run again (a failure part way leaves the
-- ones before it committed); each constraint on an existing table is added
-- NOT VALID and validated in its own statement.
-- Dropping NOT NULL on `repository_scope` and `github_app_repositories`
-- lets a row say nothing about repositories; their defaults stay, as images
-- from before still insert through them.
CREATE TABLE IF NOT EXISTS "profile_rollouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target_profile_id" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_rollouts_target_kind_key" UNIQUE("target_profile_id","kind"),
	CONSTRAINT "profile_rollouts_kind_check" CHECK ("profile_rollouts"."kind" IN ('profile_update','tool_unlock'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profile_rollout_items" (
	"rollout_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_rollout_items_pkey" PRIMARY KEY("rollout_id","agent_id","generation"),
	CONSTRAINT "profile_rollout_items_generation_check" CHECK ("profile_rollout_items"."generation" >= -1),
	CONSTRAINT "profile_rollout_items_attempts_check" CHECK ("profile_rollout_items"."attempts" >= 0),
	CONSTRAINT "profile_rollout_items_status_check" CHECK ("profile_rollout_items"."status" IN ('pending','applied','superseded','failed')),
	CONSTRAINT "profile_rollout_items_failed_check" CHECK ("profile_rollout_items"."status" <> 'failed' OR "profile_rollout_items"."reason_code" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD COLUMN IF NOT EXISTS "derived_from" text;--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD COLUMN IF NOT EXISTS "display_name" text;--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD COLUMN IF NOT EXISTS "migrated_from" text;--> statement-breakpoint
ALTER TABLE "installation_profiles" ALTER COLUMN "github_app_repositories" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "installation_profiles" ALTER COLUMN "repository_scope" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "installation_profiles" DROP CONSTRAINT IF EXISTS "installation_profiles_repository_ids_check";--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD CONSTRAINT "installation_profiles_repository_ids_check" CHECK ("installation_profiles"."repository_ids" IS NOT NULL OR "installation_profiles"."origin" = 'catalog' OR "installation_profiles"."repository_scope" IS NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "installation_profiles" VALIDATE CONSTRAINT "installation_profiles_repository_ids_check";--> statement-breakpoint
ALTER TABLE "installation_profiles" DROP CONSTRAINT IF EXISTS "installation_profiles_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD CONSTRAINT "installation_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "installation_profiles" VALIDATE CONSTRAINT "installation_profiles_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "installation_profiles" DROP CONSTRAINT IF EXISTS "installation_profiles_derived_from_fk";--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD CONSTRAINT "installation_profiles_derived_from_fk" FOREIGN KEY ("derived_from") REFERENCES "public"."installation_profiles"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "installation_profiles" VALIDATE CONSTRAINT "installation_profiles_derived_from_fk";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "installation_profiles_migrated_from_key" ON "installation_profiles" USING btree ("migrated_from") WHERE "installation_profiles"."migrated_from" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "installation_profiles_workspace_lineage_key" ON "installation_profiles" USING btree ("workspace_id","display_name","version") WHERE "installation_profiles"."workspace_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "profile_tracking" text DEFAULT 'follow' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "behavior_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "model_source" text DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "draft_version_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "draft_profile_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "draft_model_source" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "draft_failure" text;--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_profile_tracking_check";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_profile_tracking_check" CHECK ("agents"."profile_tracking" IN ('follow', 'pinned')) NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_profile_tracking_check";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_model_source_check";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_model_source_check" CHECK ("agents"."model_source" IN ('fixed', 'profile')) NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_model_source_check";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_behavior_revision_check";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_behavior_revision_check" CHECK ("agents"."behavior_revision" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_behavior_revision_check";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_draft_check";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_draft_check" CHECK (("agents"."draft_version_id" IS NULL) = ("agents"."draft_profile_id" IS NULL) AND ("agents"."draft_version_id" IS NULL) = ("agents"."draft_model_source" IS NULL) AND ("agents"."draft_model_source" IS NULL OR "agents"."draft_model_source" IN ('fixed', 'profile')) AND ("agents"."draft_failure" IS NULL OR "agents"."draft_version_id" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_draft_check";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_draft_version_fk";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_draft_version_fk" FOREIGN KEY ("id","draft_version_id") REFERENCES "public"."agent_versions"("agent_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_draft_version_fk";--> statement-breakpoint
ALTER TABLE "profile_rollouts" DROP CONSTRAINT IF EXISTS "profile_rollouts_target_profile_id_installation_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "profile_rollouts" ADD CONSTRAINT "profile_rollouts_target_profile_id_installation_profiles_id_fk" FOREIGN KEY ("target_profile_id") REFERENCES "public"."installation_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_rollouts" DROP CONSTRAINT IF EXISTS "profile_rollouts_created_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "profile_rollouts" ADD CONSTRAINT "profile_rollouts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_rollout_items" DROP CONSTRAINT IF EXISTS "profile_rollout_items_rollout_id_profile_rollouts_id_fk";--> statement-breakpoint
ALTER TABLE "profile_rollout_items" ADD CONSTRAINT "profile_rollout_items_rollout_id_profile_rollouts_id_fk" FOREIGN KEY ("rollout_id") REFERENCES "public"."profile_rollouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_rollout_items" DROP CONSTRAINT IF EXISTS "profile_rollout_items_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "profile_rollout_items" ADD CONSTRAINT "profile_rollout_items_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_rollout_items_pending_idx" ON "profile_rollout_items" USING btree ("locked_until") WHERE "profile_rollout_items"."status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_rollout_items_agent_idx" ON "profile_rollout_items" USING btree ("agent_id");
