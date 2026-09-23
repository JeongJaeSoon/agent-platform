DROP INDEX "receipts_open_terminate_idx";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "execution_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "execution_revoked_reason" text;--> statement-breakpoint
CREATE INDEX "receipts_open_terminate_idx" ON "receipts" USING btree ("created_at") WHERE "receipts"."operation" IN ('terminate', 'revoke_execution') AND "receipts"."status" = 'accepted';--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_execution_revoked_check" CHECK (("sessions"."execution_revoked_at" IS NULL) = ("sessions"."execution_revoked_reason" IS NULL));