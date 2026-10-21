ALTER TABLE "push_requests" ADD COLUMN "repository_binding" text;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN "push_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "push_requests_pushing_lease_idx" ON "push_requests" USING btree ("lease_expires_at") WHERE "push_requests"."state" = 'pushing';