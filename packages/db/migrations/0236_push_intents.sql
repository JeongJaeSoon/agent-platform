CREATE TABLE "push_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_id" bigint NOT NULL,
	"attempt_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"target_branch" text NOT NULL,
	"status" text DEFAULT 'deferred' NOT NULL,
	"pinned_revision" integer,
	"push_request_id" uuid,
	"refusal_code" text,
	"actor" jsonb NOT NULL,
	"approval_basis" text,
	"policy_source" text,
	"pull_request" jsonb,
	"claim_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "push_intents_status_check" CHECK ("push_intents"."status" IN ('deferred','pinned','requested','failed','cancelled')),
	CONSTRAINT "push_intents_refusal_check" CHECK ("push_intents"."refusal_code" IS NULL OR "push_intents"."refusal_code" IN ('turn_ended_without_checkpoint','turn_finalized_without_pin','session_closed','rejected_before','request_open','github_disabled','over_workspace_ceiling','repository_not_allowed','checkpoint_unavailable','source_missing','attribution_mismatch','uncommitted_changes','pinned_source_invalid')),
	CONSTRAINT "push_intents_shape_check" CHECK (("push_intents"."status" NOT IN ('pinned','requested') OR "push_intents"."pinned_revision" IS NOT NULL) AND (("push_intents"."status" = 'requested') = ("push_intents"."push_request_id" IS NOT NULL)) AND (("push_intents"."status" IN ('failed','cancelled')) = ("push_intents"."refusal_code" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN "origin" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN "flow" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN "pull_request_intent" jsonb;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN "pr_state" text;--> statement-breakpoint
ALTER TABLE "push_intents" ADD CONSTRAINT "push_intents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_intents" ADD CONSTRAINT "push_intents_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_intents" ADD CONSTRAINT "push_intents_push_request_id_push_requests_id_fk" FOREIGN KEY ("push_request_id") REFERENCES "public"."push_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_intents_turn_target_idx" ON "push_intents" USING btree ("turn_id","repository_id","target_branch");--> statement-breakpoint
CREATE INDEX "push_intents_session_idx" ON "push_intents" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "push_intents_open_idx" ON "push_intents" USING btree ("status","created_at") WHERE "push_intents"."status" IN ('deferred','pinned');--> statement-breakpoint
CREATE INDEX "push_requests_pr_open_idx" ON "push_requests" USING btree ("session_id","repository_id","target_branch") WHERE "push_requests"."pr_state" IN ('due','opening');--> statement-breakpoint
ALTER TABLE "push_requests" ADD CONSTRAINT "push_requests_origin_check" CHECK ("push_requests"."origin" IN ('direct','intent'));--> statement-breakpoint
ALTER TABLE "push_requests" ADD CONSTRAINT "push_requests_flow_check" CHECK ("push_requests"."flow" IN ('legacy','actions'));--> statement-breakpoint
ALTER TABLE "push_requests" ADD CONSTRAINT "push_requests_pr_state_check" CHECK ("push_requests"."pr_state" IS NULL OR "push_requests"."pr_state" IN ('due','opening','opened','closed_unrecorded','uncertain','failed','cancelled'));