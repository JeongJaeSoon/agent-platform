CREATE TABLE "github_workflow_dispatches" (
	"run_id" bigint NOT NULL,
	"repository_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"agent_release_id" text,
	"workflow" text NOT NULL,
	"ref" text NOT NULL,
	"receipt_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_workflow_dispatches_pkey" PRIMARY KEY("repository_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "github_workflow_dispatches" ADD CONSTRAINT "github_workflow_dispatches_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_workflow_dispatches" ADD CONSTRAINT "github_workflow_dispatches_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;