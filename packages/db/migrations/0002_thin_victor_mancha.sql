CREATE TYPE "public"."admission_state" AS ENUM('active', 'pausing', 'paused', 'resuming', 'stopping', 'stopped', 'recovery_required', 'closed');--> statement-breakpoint
CREATE TYPE "public"."receipt_status" AS ENUM('accepted', 'succeeded', 'failed', 'unknown');--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"session_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"manifest_ref" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"turn_id" bigint,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkpoints_session_id_revision_pk" PRIMARY KEY("session_id","revision")
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"backend" text NOT NULL,
	"provider_ref" text,
	"launch_operation_id" text,
	"generation" integer NOT NULL,
	"desired_state" text NOT NULL,
	"observed_state" text NOT NULL,
	"observed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"principal" text NOT NULL,
	"operation" text NOT NULL,
	"resource" text NOT NULL,
	"key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"receipt_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_principal_operation_resource_key_pk" PRIMARY KEY("principal","operation","resource","key")
);
--> statement-breakpoint
CREATE TABLE "pending_requests" (
	"request_id" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_id" bigint NOT NULL,
	"attempt_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"operation" text NOT NULL,
	"target_ref" jsonb NOT NULL,
	"status" "receipt_status" DEFAULT 'accepted' NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "turn_id" bigint;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "attempt_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "source_sequence" integer;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "admission_state" "admission_state" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "lease_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "execution_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "profile_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "repository_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "checkpoint_revision" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "checkpoint_committed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "attempt_id" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "delivery_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "terminal_reason" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "outcome_unknown" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "unassigned_sessions" ADD COLUMN "partition" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_requests" ADD CONSTRAINT "pending_requests_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_requests" ADD CONSTRAINT "pending_requests_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "executions_launch_operation_id_uniq" ON "executions" USING btree ("launch_operation_id") WHERE "executions"."launch_operation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "executions_session_generation_idx" ON "executions" USING btree ("session_id","generation");--> statement-breakpoint
CREATE INDEX "pending_requests_unresolved_session_idx" ON "pending_requests" USING btree ("session_id") WHERE "pending_requests"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "receipts_owner_created_at_idx" ON "receipts" USING btree ("owner_id","created_at");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_attempt_sequence_uniq" ON "events" USING btree ("session_id","attempt_id","source_sequence") WHERE "events"."attempt_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "turns" SET "status" = 'completed' WHERE "status" = 'done';
--> statement-breakpoint
UPDATE "events" SET "payload" = ("payload" - 'status') || jsonb_build_object('phase', "payload"->'status') WHERE "type" = 'status' AND "payload" ? 'status' AND NOT ("payload" ? 'phase');
--> statement-breakpoint
UPDATE "sessions" SET "admission_state" = 'stopped' WHERE "status" = 'stopped';
