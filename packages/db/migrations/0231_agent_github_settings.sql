-- migrate:no-transaction
-- Every statement may run again: a failure part way leaves the ones before
-- it committed, and the next run starts from the top. The new columns are
-- null or their constant default everywhere, and no image writes another
-- value yet; each CHECK on a growing table is added NOT VALID and validated
-- in its own statement, so the scan does not hold the ADD's lock.
CREATE TABLE IF NOT EXISTS "agent_github_settings" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repositories" jsonb NOT NULL,
	"push_approval" boolean NOT NULL,
	"features" jsonb NOT NULL,
	"actions_allow" jsonb NOT NULL,
	"start_repository_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_github_settings_repositories_check" CHECK (jsonb_typeof("agent_github_settings"."repositories") = 'array' AND jsonb_array_length("agent_github_settings"."repositories") <= 32),
	CONSTRAINT "agent_github_settings_start_check" CHECK ("agent_github_settings"."start_repository_id" IS NULL OR "agent_github_settings"."repositories" ? "agent_github_settings"."start_repository_id")
);--> statement-breakpoint
ALTER TABLE "agent_github_settings" DROP CONSTRAINT IF EXISTS "agent_github_settings_agent_fk";--> statement-breakpoint
ALTER TABLE "agent_github_settings" ADD CONSTRAINT "agent_github_settings_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_workspace_settings" ADD COLUMN IF NOT EXISTS "repository_ceiling" jsonb;--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD COLUMN IF NOT EXISTS "repository_scope" text DEFAULT 'profile' NOT NULL;--> statement-breakpoint
ALTER TABLE "installation_profiles" DROP CONSTRAINT IF EXISTS "installation_profiles_repository_scope_check";--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD CONSTRAINT "installation_profiles_repository_scope_check" CHECK ("installation_profiles"."repository_scope" IN ('profile','workspace'));--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "approval_basis" text;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "approval_settings_revision" integer;--> statement-breakpoint
ALTER TABLE "push_requests" DROP CONSTRAINT IF EXISTS "push_requests_approval_basis_check";--> statement-breakpoint
ALTER TABLE "push_requests" ADD CONSTRAINT "push_requests_approval_basis_check" CHECK ("push_requests"."approval_basis" IS NULL OR "push_requests"."approval_basis" IN ('human','policy')) NOT VALID;--> statement-breakpoint
ALTER TABLE "push_requests" VALIDATE CONSTRAINT "push_requests_approval_basis_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "github_policy_source" text DEFAULT 'release' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_github_policy_source_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_github_policy_source_check" CHECK ("sessions"."github_policy_source" IN ('release','agent')) NOT VALID;--> statement-breakpoint
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_github_policy_source_check";
