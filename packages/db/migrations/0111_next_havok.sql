ALTER TABLE "worker_launches" ADD COLUMN "launch_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_launches" ADD COLUMN "launch_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_launches" ADD COLUMN "launch_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "worker_launches" ADD COLUMN "last_launch_error" text;--> statement-breakpoint
ALTER TABLE "worker_launches" ADD CONSTRAINT "worker_launches_launch_failure_count_check" CHECK ("worker_launches"."launch_failure_count" >= 0);--> statement-breakpoint
ALTER TABLE "worker_launches" ADD CONSTRAINT "worker_launches_launch_attempts_check" CHECK ("worker_launches"."launch_attempts" >= 0);