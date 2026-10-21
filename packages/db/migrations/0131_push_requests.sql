CREATE TABLE "push_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"checkpoint_revision" integer NOT NULL,
	"git_commit" text NOT NULL,
	"target_branch" text NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"requested_by" jsonb NOT NULL,
	"request_receipt_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" jsonb,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"decision_receipt_id" uuid,
	"push_started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"push_error" jsonb,
	"push_receipt_id" uuid,
	CONSTRAINT "push_requests_state_check" CHECK ("push_requests"."state" IN ('requested','approved','rejected','pushing','pushed','failed')),
	CONSTRAINT "push_requests_git_commit_check" CHECK ("push_requests"."git_commit" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "push_requests_checkpoint_revision_check" CHECK ("push_requests"."checkpoint_revision" >= 0),
	CONSTRAINT "push_requests_target_branch_check" CHECK ("push_requests"."target_branch" = 'agent/' || "push_requests"."session_id"::text),
	CONSTRAINT "push_requests_decision_check" CHECK (("push_requests"."state" = 'requested') = ("push_requests"."decided_at" IS NULL) AND ("push_requests"."decided_at" IS NULL) = ("push_requests"."decided_by" IS NULL) AND ("push_requests"."decided_at" IS NULL) = ("push_requests"."decision_receipt_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "push_requests" ADD CONSTRAINT "push_requests_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_requests" ADD CONSTRAINT "push_requests_request_receipt_id_receipts_id_fk" FOREIGN KEY ("request_receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_requests" ADD CONSTRAINT "push_requests_decision_receipt_id_receipts_id_fk" FOREIGN KEY ("decision_receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_requests" ADD CONSTRAINT "push_requests_push_receipt_id_receipts_id_fk" FOREIGN KEY ("push_receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_requests_open_session_idx" ON "push_requests" USING btree ("session_id") WHERE "push_requests"."state" IN ('requested','approved','pushing');--> statement-breakpoint
CREATE INDEX "push_requests_session_created_idx" ON "push_requests" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "push_requests_approved_idx" ON "push_requests" USING btree ("created_at") WHERE "push_requests"."state" = 'approved';