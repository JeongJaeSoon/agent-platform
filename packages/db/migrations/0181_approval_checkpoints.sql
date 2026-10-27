CREATE TABLE "approval_checkpoints" (
	"manifest_ref" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"manifest_sha256" text NOT NULL,
	"manifest_version" text,
	"versions_held" boolean NOT NULL,
	"transcript_bytes" bigint,
	"attempt_id" text NOT NULL,
	"turn_id" bigint NOT NULL,
	"answers_through" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"invalidated_at" timestamp with time zone,
	"promoted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pending_requests" ADD COLUMN "checkpoint_ref" text;--> statement-breakpoint
ALTER TABLE "approval_checkpoints" ADD CONSTRAINT "approval_checkpoints_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_checkpoints" ADD CONSTRAINT "approval_checkpoints_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_checkpoints" ADD CONSTRAINT "approval_checkpoints_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_requests" ADD CONSTRAINT "pending_requests_checkpoint_ref_approval_checkpoints_manifest_ref_fk" FOREIGN KEY ("checkpoint_ref") REFERENCES "public"."approval_checkpoints"("manifest_ref") ON DELETE no action ON UPDATE no action;