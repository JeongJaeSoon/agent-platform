ALTER TABLE "sessions" ADD COLUMN "checkpoint_fallback_revision" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "checkpoint_fallback_attempt_id" text;