ALTER TABLE "pending_requests" ADD COLUMN "tool_use_id" text;--> statement-breakpoint
ALTER TABLE "pending_requests" ADD COLUMN "tool" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "input_announced" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "sessions_input_announced_idx" ON "sessions" USING btree ("id") WHERE "sessions"."input_announced";