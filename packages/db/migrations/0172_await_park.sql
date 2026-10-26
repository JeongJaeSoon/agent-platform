CREATE TABLE "permission_grants" (
	"request_id" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_id" bigint NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pending_requests" ADD COLUMN "park_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pending_requests" ADD COLUMN "parked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pending_requests" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "permission_wait_override" jsonb;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_request_id_pending_requests_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."pending_requests"("request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_requests_park_due" ON "pending_requests" USING btree ("park_at") WHERE "pending_requests"."parked_at" IS NULL AND "pending_requests"."resolved_at" IS NULL AND "pending_requests"."park_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_pause_reason_check" CHECK ("sessions"."pause_reason" IS NULL OR ("sessions"."pause_reason" IN ('awaiting_input') AND "sessions"."admission_state" IN ('pausing', 'paused')));--> statement-breakpoint
-- A system pause's reason ends with the pause, whichever write moves the
-- session on: resume, close, terminate, a recovery decision or a failed
-- drain. Cleared here rather than at each of them, so a new path cannot
-- forget it and trip the check above.
CREATE FUNCTION "sessions_clear_pause_reason"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."pause_reason" := NULL;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "sessions_clear_pause_reason" BEFORE UPDATE ON "sessions"
  FOR EACH ROW WHEN (NEW."pause_reason" IS NOT NULL AND NEW."admission_state" NOT IN ('pausing', 'paused'))
  EXECUTE FUNCTION "sessions_clear_pause_reason"();
