ALTER TABLE "pending_requests" ADD COLUMN "answer" jsonb;--> statement-breakpoint
ALTER TABLE "pending_requests" ADD COLUMN "answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pending_requests" ADD COLUMN "answer_sequence" integer;--> statement-breakpoint
ALTER TABLE "pending_requests" ADD COLUMN "answer_receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "pending_requests" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pending_requests" ADD COLUMN "settled_outcome" text;--> statement-breakpoint
ALTER TABLE "pending_requests" ADD CONSTRAINT "pending_requests_answer_receipt_id_receipts_id_fk" FOREIGN KEY ("answer_receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pending_requests_session_answer_sequence_idx" ON "pending_requests" USING btree ("session_id","answer_sequence");--> statement-breakpoint
CREATE INDEX "pending_requests_undelivered_attempt_idx" ON "pending_requests" USING btree ("attempt_id","answer_sequence") WHERE "pending_requests"."answered_at" IS NOT NULL AND "pending_requests"."settled_at" IS NULL;