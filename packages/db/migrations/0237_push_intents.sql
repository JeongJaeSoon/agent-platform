-- migrate:no-transaction
-- Additive. push_intents is a new table. The four push_requests columns are
-- null or their constant default everywhere, so existing rows keep reading
-- as origin `direct`, flow `legacy` and no pull request stage, which is what
-- they were. Each CHECK on push_requests is added NOT VALID and validated in
-- its own statement, and its index is built CONCURRENTLY, so no scan holds a
-- write lock. Every statement may run again: a failure part way leaves the
-- ones before it committed, and the next run starts from the top.
CREATE TABLE IF NOT EXISTS "push_intents" (
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
);--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "flow" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "pull_request_intent" jsonb;--> statement-breakpoint
ALTER TABLE "push_requests" ADD COLUMN IF NOT EXISTS "pr_state" text;--> statement-breakpoint
ALTER TABLE "push_intents" DROP CONSTRAINT IF EXISTS "push_intents_session_id_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "push_intents" ADD CONSTRAINT "push_intents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_intents" DROP CONSTRAINT IF EXISTS "push_intents_turn_id_turns_id_fk";--> statement-breakpoint
ALTER TABLE "push_intents" ADD CONSTRAINT "push_intents_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_intents" DROP CONSTRAINT IF EXISTS "push_intents_push_request_id_push_requests_id_fk";--> statement-breakpoint
ALTER TABLE "push_intents" ADD CONSTRAINT "push_intents_push_request_id_push_requests_id_fk" FOREIGN KEY ("push_request_id") REFERENCES "public"."push_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_intents_turn_target_idx" ON "push_intents" USING btree ("turn_id","repository_id","target_branch");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_intents_session_idx" ON "push_intents" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_intents_open_idx" ON "push_intents" USING btree ("status","created_at") WHERE "push_intents"."status" IN ('deferred','pinned');--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "push_requests_pr_open_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "push_requests_pr_open_idx" ON "push_requests" USING btree ("session_id","repository_id","target_branch") WHERE "push_requests"."pr_state" IN ('due','opening');--> statement-breakpoint
ALTER TABLE "push_requests" DROP CONSTRAINT IF EXISTS "push_requests_origin_check";--> statement-breakpoint
ALTER TABLE "push_requests" ADD CONSTRAINT "push_requests_origin_check" CHECK ("push_requests"."origin" IN ('direct','intent')) NOT VALID;--> statement-breakpoint
ALTER TABLE "push_requests" VALIDATE CONSTRAINT "push_requests_origin_check";--> statement-breakpoint
ALTER TABLE "push_requests" DROP CONSTRAINT IF EXISTS "push_requests_flow_check";--> statement-breakpoint
ALTER TABLE "push_requests" ADD CONSTRAINT "push_requests_flow_check" CHECK ("push_requests"."flow" IN ('legacy','actions')) NOT VALID;--> statement-breakpoint
ALTER TABLE "push_requests" VALIDATE CONSTRAINT "push_requests_flow_check";--> statement-breakpoint
ALTER TABLE "push_requests" DROP CONSTRAINT IF EXISTS "push_requests_pr_state_check";--> statement-breakpoint
ALTER TABLE "push_requests" ADD CONSTRAINT "push_requests_pr_state_check" CHECK ("push_requests"."pr_state" IS NULL OR "push_requests"."pr_state" IN ('due','opening','opened','closed_unrecorded','uncertain','failed','cancelled')) NOT VALID;--> statement-breakpoint
ALTER TABLE "push_requests" VALIDATE CONSTRAINT "push_requests_pr_state_check";--> statement-breakpoint
-- A push intent or pull request stage change marks the session's Slack thread
-- status due at commit, like a push request's state does (0226).
DROP TRIGGER IF EXISTS "push_intents_slack_thread_status_insert" ON "push_intents";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "push_intents_slack_thread_status_insert" AFTER INSERT ON "push_intents"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "slack_thread_status_of_row"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "push_intents_slack_thread_status_update" ON "push_intents";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "push_intents_slack_thread_status_update" AFTER UPDATE ON "push_intents"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION "slack_thread_status_of_row"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "push_requests_slack_thread_status_pr_state" ON "push_requests";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "push_requests_slack_thread_status_pr_state" AFTER UPDATE ON "push_requests"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."pr_state" IS DISTINCT FROM NEW."pr_state")
  EXECUTE FUNCTION "slack_thread_status_of_row"();
