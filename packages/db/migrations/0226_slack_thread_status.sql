CREATE TABLE "slack_thread_status" (
	"session_link_id" uuid PRIMARY KEY NOT NULL,
	"dirty_rev" bigint DEFAULT 1 NOT NULL,
	"sent_rev" bigint DEFAULT 0 NOT NULL,
	"sent_status" text,
	"sent_at" timestamp with time zone,
	"claim_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"next_at" timestamp with time zone,
	"inflight_at" timestamp with time zone,
	"uncertain_rev" integer DEFAULT 0 NOT NULL,
	"uncertain_latest_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"disabled_reason" text,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "slack_thread_status_claim_check" CHECK (("slack_thread_status"."claim_token" IS NULL) = ("slack_thread_status"."lease_expires_at" IS NULL)),
	CONSTRAINT "slack_thread_status_disabled_check" CHECK (("slack_thread_status"."disabled_reason" IS NULL) = ("slack_thread_status"."disabled_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "slack_thread_status" ADD CONSTRAINT "slack_thread_status_session_link_id_session_links_id_fk" FOREIGN KEY ("session_link_id") REFERENCES "public"."session_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_thread_status_reconciled_idx" ON "slack_thread_status" USING btree ("reconciled_at");--> statement-breakpoint
-- Deferred to commit, so the status row is the transaction's last lock and
-- a rolled-back write raises nothing. A link without a row gets one, due.
CREATE FUNCTION "slack_thread_status_touch"("session" uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO "slack_thread_status" ("session_link_id")
  SELECT l."id" FROM "session_links" l
  WHERE l."session_id" = "session" AND l."revoked_at" IS NULL
  ORDER BY l."id"
  ON CONFLICT ("session_link_id") DO UPDATE
    SET "dirty_rev" = "slack_thread_status"."dirty_rev" + 1;
$$;--> statement-breakpoint
CREATE FUNCTION "slack_thread_status_of_row"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "slack_thread_status_touch"(NEW."session_id");
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "slack_thread_status_of_session"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "slack_thread_status_touch"(NEW."id");
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "turns_slack_thread_status_insert" AFTER INSERT ON "turns"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "slack_thread_status_of_row"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "turns_slack_thread_status_update" AFTER UPDATE ON "turns"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION "slack_thread_status_of_row"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pending_requests_slack_thread_status_insert" AFTER INSERT ON "pending_requests"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "slack_thread_status_of_row"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pending_requests_slack_thread_status_update" AFTER UPDATE ON "pending_requests"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (
    OLD."resolved_at" IS DISTINCT FROM NEW."resolved_at"
    OR OLD."answered_at" IS DISTINCT FROM NEW."answered_at"
    OR OLD."parked_at" IS DISTINCT FROM NEW."parked_at"
    OR OLD."expires_at" IS DISTINCT FROM NEW."expires_at"
  )
  EXECUTE FUNCTION "slack_thread_status_of_row"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "push_requests_slack_thread_status_insert" AFTER INSERT ON "push_requests"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "slack_thread_status_of_row"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "push_requests_slack_thread_status_update" AFTER UPDATE ON "push_requests"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."state" IS DISTINCT FROM NEW."state")
  EXECUTE FUNCTION "slack_thread_status_of_row"();--> statement-breakpoint
-- Only the columns the status reads: a session row is also written on every
-- lease renewal and usage roll-up.
CREATE CONSTRAINT TRIGGER "sessions_slack_thread_status_update" AFTER UPDATE ON "sessions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (
    OLD."admission_state" IS DISTINCT FROM NEW."admission_state"
    OR OLD."execution_revoked_at" IS DISTINCT FROM NEW."execution_revoked_at"
    OR OLD."checkpoint_revision" IS DISTINCT FROM NEW."checkpoint_revision"
  )
  EXECUTE FUNCTION "slack_thread_status_of_session"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "session_links_slack_thread_status_insert" AFTER INSERT ON "session_links"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW."session_id" IS NOT NULL)
  EXECUTE FUNCTION "slack_thread_status_of_row"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "session_links_slack_thread_status_update" AFTER UPDATE ON "session_links"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (
    NEW."session_id" IS NOT NULL AND (
      OLD."session_id" IS DISTINCT FROM NEW."session_id"
      OR OLD."revoked_at" IS DISTINCT FROM NEW."revoked_at"
      OR OLD."muted" IS DISTINCT FROM NEW."muted"
    )
  )
  EXECUTE FUNCTION "slack_thread_status_of_row"();