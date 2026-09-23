ALTER TABLE "worker_credentials" ADD COLUMN "purpose" text DEFAULT 'gateway' NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_credentials" ADD COLUMN "binding" text;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_credentials_live_purpose_idx" ON "worker_credentials" USING btree ("attempt_id","purpose") WHERE "worker_credentials"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "worker_credentials" ADD CONSTRAINT "worker_credentials_purpose_check" CHECK ("worker_credentials"."purpose" IN ('gateway', 'provider', 'repository'));--> statement-breakpoint
ALTER TABLE "worker_credentials" ADD CONSTRAINT "worker_credentials_binding_check" CHECK (("worker_credentials"."purpose" = 'gateway') = ("worker_credentials"."binding" IS NULL));