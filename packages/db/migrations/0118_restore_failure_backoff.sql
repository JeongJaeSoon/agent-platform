ALTER TABLE "sessions" ADD COLUMN "restore_attempt_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "restore_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "restore_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "restore_failure_reason" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_restore_failure_count_check" CHECK ("sessions"."restore_failure_count" >= 0);