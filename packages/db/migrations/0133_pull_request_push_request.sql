ALTER TABLE "pull_requests" ADD COLUMN "push_request_id" uuid;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "repository_id" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "head" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "base" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_push_request_id_push_requests_id_fk" FOREIGN KEY ("push_request_id") REFERENCES "public"."push_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_push_request_idx" ON "pull_requests" USING btree ("push_request_id");