ALTER TABLE "sessions" ADD COLUMN "checkpoint_pending_reason" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "checkpoint_pending_attempt_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_transcript_persisted_at" timestamp with time zone;