ALTER TABLE "worker_launches" ADD COLUMN "replacement_reason" text;--> statement-breakpoint
ALTER TABLE "worker_launches" ADD COLUMN "replacement_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_launches" ADD CONSTRAINT "worker_launches_replacement_reason_check" CHECK ("worker_launches"."replacement_reason" IS NULL OR "worker_launches"."replacement_reason" IN ('nonce_expired', 'stale_isolation'));--> statement-breakpoint
ALTER TABLE "worker_launches" ADD CONSTRAINT "worker_launches_replacement_count_check" CHECK ("worker_launches"."replacement_count" >= 0);