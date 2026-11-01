-- migrate:no-transaction
-- Every statement may run again: a failure part way leaves the ones before
-- it committed, and the next run starts from the top.
CREATE TABLE IF NOT EXISTS "session_event_archives" (
	"session_id" uuid NOT NULL,
	"from_id" bigint NOT NULL,
	"through_id" bigint NOT NULL,
	"object_key" text NOT NULL,
	"version_id" text NOT NULL,
	"sha256" text NOT NULL,
	"event_count" integer NOT NULL,
	"bytes" bigint NOT NULL,
	"last_created_at" timestamp with time zone NOT NULL,
	"last_occurred_at" timestamp with time zone NOT NULL,
	"activity" jsonb NOT NULL,
	"activity_through" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_event_archives_session_id_from_id_pk" PRIMARY KEY("session_id","from_id"),
	CONSTRAINT "session_event_archives_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "session_event_archives_range_check" CHECK ("session_event_archives"."from_id" <= "session_event_archives"."through_id" AND "session_event_archives"."event_count" > 0)
);
--> statement-breakpoint
-- A build cut short leaves an invalid index that IF NOT EXISTS would keep.
DROP INDEX CONCURRENTLY IF EXISTS "web_sessions_expires_at_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "web_sessions_expires_at_idx" ON "web_sessions" USING btree ("expires_at");
