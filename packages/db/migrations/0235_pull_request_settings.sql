-- migrate:no-transaction
-- Every statement may run again: a failure part way leaves the ones before
-- it committed, and the next run starts from the top. The new columns are
-- null or their constant default on every row, and the new table starts
-- empty; an image from before neither reads nor writes them.
CREATE TABLE IF NOT EXISTS "agent_pull_request_settings" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"formatting" text NOT NULL,
	"template" text,
	"template_name" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_pull_request_settings_formatting_check" CHECK ("agent_pull_request_settings"."formatting" IN ('inherit', 'on', 'off'))
);--> statement-breakpoint
ALTER TABLE "github_workspace_settings" ADD COLUMN IF NOT EXISTS "pull_request" jsonb;--> statement-breakpoint
ALTER TABLE "github_workspace_settings" ADD COLUMN IF NOT EXISTS "pull_request_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_pull_request_settings" DROP CONSTRAINT IF EXISTS "agent_pull_request_settings_agent_fk";--> statement-breakpoint
ALTER TABLE "agent_pull_request_settings" ADD CONSTRAINT "agent_pull_request_settings_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;
