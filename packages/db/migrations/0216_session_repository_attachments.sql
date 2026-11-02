CREATE TABLE "session_repository_attachments" (
	"session_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"branch" text NOT NULL,
	"status" text NOT NULL,
	"git_commit" text,
	"failure" text,
	"receipt_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "session_repository_attachments_session_id_repository_id_pk" PRIMARY KEY("session_id","repository_id"),
	CONSTRAINT "session_repository_attachments_status_check" CHECK ("session_repository_attachments"."status" IN ('pending','attached','failed')),
	CONSTRAINT "session_repository_attachments_settled_check" CHECK (("session_repository_attachments"."status" = 'attached') = ("session_repository_attachments"."git_commit" IS NOT NULL) AND ("session_repository_attachments"."status" = 'failed') = ("session_repository_attachments"."failure" IS NOT NULL) AND ("session_repository_attachments"."status" = 'pending') = ("session_repository_attachments"."settled_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "session_repository_attachments" ADD CONSTRAINT "session_repository_attachments_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_repository_attachments" ADD CONSTRAINT "session_repository_attachments_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_repository_attachments_pending_idx" ON "session_repository_attachments" USING btree ("session_id") WHERE "session_repository_attachments"."status" = 'pending';