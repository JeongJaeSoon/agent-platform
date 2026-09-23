ALTER TABLE "worker_launches" DROP CONSTRAINT "worker_launches_replacement_reason_check";--> statement-breakpoint
ALTER TABLE "worker_launches" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "worker_launches" ADD COLUMN "resources" jsonb;--> statement-breakpoint
ALTER TABLE "worker_launches" ADD CONSTRAINT "worker_launches_launch_spec_check" CHECK (("worker_launches"."image" IS NULL) = ("worker_launches"."resources" IS NULL));--> statement-breakpoint
ALTER TABLE "worker_launches" ADD CONSTRAINT "worker_launches_replacement_reason_check" CHECK ("worker_launches"."replacement_reason" IS NULL OR "worker_launches"."replacement_reason" IN ('credential_mismatch', 'nonce_expired', 'spec_mismatch', 'stale_isolation'));