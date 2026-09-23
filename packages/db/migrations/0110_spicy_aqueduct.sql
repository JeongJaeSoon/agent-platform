ALTER TABLE "sessions" ADD COLUMN "workspace_reclaim_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "workspace_reclaim_workspace_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "workspace_reclaim_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "workspace_reclaimed_at" timestamp with time zone;