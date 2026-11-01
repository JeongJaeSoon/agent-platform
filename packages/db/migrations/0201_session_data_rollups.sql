-- migrate:no-transaction
-- Every statement may run again: a failure part way leaves the ones before
-- it committed, and the next run starts from the top.
CREATE TABLE IF NOT EXISTS "checkpoint_output_objects" (
	"session_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"bytes" bigint NOT NULL,
	"live_refs" integer NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "checkpoint_output_objects_session_id_object_key_pk" PRIMARY KEY("session_id","object_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "checkpoint_output_totals" (
	"scope" text PRIMARY KEY NOT NULL,
	"kept_bytes" bigint NOT NULL,
	CONSTRAINT "checkpoint_output_totals_kept_nonneg" CHECK ("checkpoint_output_totals"."kept_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_usage_totals" (
	"model" text NOT NULL,
	"priced_by" text NOT NULL,
	"calls" bigint NOT NULL,
	"input_tokens" numeric NOT NULL,
	"output_tokens" numeric NOT NULL,
	"cache_read_input_tokens" numeric NOT NULL,
	"cache_creation_input_tokens" numeric NOT NULL,
	"cost_usd" numeric NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	CONSTRAINT "provider_usage_totals_model_priced_by_pk" PRIMARY KEY("model","priced_by")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tool_call_outcomes" (
	"name" text NOT NULL,
	"outcome" text NOT NULL,
	"calls" bigint NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tool_call_outcomes_name_outcome_pk" PRIMARY KEY("name","outcome")
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tool_call_outcomes_add"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "tool_call_outcomes" AS "t" ("name", "outcome", "calls", "first_at")
  SELECT "name", "outcome", count(*), min("created_at") FROM "added_rows" GROUP BY "name", "outcome"
  ON CONFLICT ("name", "outcome") DO UPDATE
    SET "calls" = "t"."calls" + EXCLUDED."calls", "first_at" = LEAST("t"."first_at", EXCLUDED."first_at");
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- Two statements: one update may move a call out of a pair and another into
-- it, and a single statement may not change the same row twice.
CREATE OR REPLACE FUNCTION "tool_call_outcomes_move"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "tool_call_outcomes" AS "t" SET "calls" = "t"."calls" - "moved"."calls"
  FROM (
    SELECT "o"."name", "o"."outcome", count(*) AS "calls"
    FROM "old_rows" "o" JOIN "new_rows" "n" USING ("use_event_id", "ord")
    WHERE ("o"."name", "o"."outcome") IS DISTINCT FROM ("n"."name", "n"."outcome")
    GROUP BY 1, 2
  ) AS "moved"
  WHERE "t"."name" = "moved"."name" AND "t"."outcome" = "moved"."outcome";
  INSERT INTO "tool_call_outcomes" AS "t" ("name", "outcome", "calls", "first_at")
  SELECT "n"."name", "n"."outcome", count(*), min("n"."created_at")
  FROM "old_rows" "o" JOIN "new_rows" "n" USING ("use_event_id", "ord")
  WHERE ("o"."name", "o"."outcome") IS DISTINCT FROM ("n"."name", "n"."outcome")
  GROUP BY 1, 2
  ON CONFLICT ("name", "outcome") DO UPDATE
    SET "calls" = "t"."calls" + EXCLUDED."calls", "first_at" = LEAST("t"."first_at", EXCLUDED."first_at");
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- Nothing deletes calls but a person at psql; their names are counted again.
CREATE OR REPLACE FUNCTION "tool_call_outcomes_recount"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "tool_call_outcomes" WHERE "name" IN (SELECT "name" FROM "removed_rows");
  INSERT INTO "tool_call_outcomes" ("name", "outcome", "calls", "first_at")
  SELECT "name", "outcome", count(*), min("created_at") FROM "tool_calls"
  WHERE "name" IN (SELECT "name" FROM "removed_rows")
  GROUP BY "name", "outcome";
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tool_call_outcomes_clear"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "tool_call_outcomes";
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "provider_usage_totals_add"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "provider_usage_totals" AS "t" ("model", "priced_by", "calls", "input_tokens", "output_tokens",
    "cache_read_input_tokens", "cache_creation_input_tokens", "cost_usd", "first_at")
  SELECT "model", "priced_by", count(*), sum("input_tokens"), sum("output_tokens"),
         sum("cache_read_input_tokens"), sum("cache_creation_input_tokens"), sum("cost_usd"), min("recorded_at")
  FROM "added_rows" GROUP BY "model", "priced_by"
  ON CONFLICT ("model", "priced_by") DO UPDATE
    SET "calls" = "t"."calls" + EXCLUDED."calls",
        "input_tokens" = "t"."input_tokens" + EXCLUDED."input_tokens",
        "output_tokens" = "t"."output_tokens" + EXCLUDED."output_tokens",
        "cache_read_input_tokens" = "t"."cache_read_input_tokens" + EXCLUDED."cache_read_input_tokens",
        "cache_creation_input_tokens" = "t"."cache_creation_input_tokens" + EXCLUDED."cache_creation_input_tokens",
        "cost_usd" = "t"."cost_usd" + EXCLUDED."cost_usd",
        "first_at" = LEAST("t"."first_at", EXCLUDED."first_at");
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "provider_usage_totals_recount"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "provider_usage_totals" AS "t"
  USING (SELECT DISTINCT "model", "priced_by" FROM "removed_rows") AS "r"
  WHERE "t"."model" = "r"."model" AND "t"."priced_by" = "r"."priced_by";
  INSERT INTO "provider_usage_totals" ("model", "priced_by", "calls", "input_tokens", "output_tokens",
    "cache_read_input_tokens", "cache_creation_input_tokens", "cost_usd", "first_at")
  SELECT "u"."model", "u"."priced_by", count(*), sum("u"."input_tokens"), sum("u"."output_tokens"),
         sum("u"."cache_read_input_tokens"), sum("u"."cache_creation_input_tokens"), sum("u"."cost_usd"),
         min("u"."recorded_at")
  FROM "provider_usage" "u"
  JOIN (SELECT DISTINCT "model", "priced_by" FROM "removed_rows") AS "r"
    ON "r"."model" = "u"."model" AND "r"."priced_by" = "u"."priced_by"
  GROUP BY "u"."model", "u"."priced_by";
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "provider_usage_totals_clear"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "provider_usage_totals";
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- Every writer of checkpoint_output_objects locks the totals row first, in a
-- statement of its own. Writers then queue on that one row instead of
-- deadlocking over keys, and the statements after the lock read a snapshot
-- that holds every write committed before it.
--
-- The planner has no row count for a transition table. Once these tables
-- were analyzed while small, a join put them outside and rescanned the
-- transition table for each of their rows: 1,000 keys took 15 s. A LATERAL
-- with LIMIT is not pulled up into a join, so the transition table stays
-- outside and each row is one key lookup; seq scans are off so the lookup
-- uses the key's index however small the table looks.
--
-- The kept bytes change by what the touched keys hold after the statement
-- less what they held before it, both summed over the same keys.
CREATE OR REPLACE FUNCTION "checkpoint_output_objects_add"() RETURNS trigger LANGUAGE plpgsql
SET "enable_seqscan" = off AS $$
DECLARE
  "was_kept" bigint;
  "now_kept" bigint;
BEGIN
  PERFORM 1 FROM "checkpoint_output_totals" WHERE "scope" = 'installation' FOR UPDATE;
  SELECT coalesce(sum("o"."bytes") FILTER (WHERE "o"."live_refs" > 0), 0) INTO "was_kept"
  FROM (SELECT DISTINCT "session_id", "object_key" FROM "added_rows") "a"
  CROSS JOIN LATERAL (
    SELECT "bytes", "live_refs" FROM "checkpoint_output_objects"
    WHERE "session_id" = "a"."session_id" AND "object_key" = "a"."object_key" LIMIT 1
  ) "o";
  WITH "added" AS (
    SELECT "a"."session_id", "a"."object_key", max("a"."bytes") AS "bytes",
           (count(*) FILTER (WHERE "c"."objects_purged_at" IS NULL))::integer AS "live_refs",
           min("c"."committed_at") AS "first_at", max("c"."objects_purged_at") AS "released_at"
    FROM "added_rows" "a"
    CROSS JOIN LATERAL (
      SELECT "committed_at", "objects_purged_at" FROM "checkpoints"
      WHERE "session_id" = "a"."session_id" AND "revision" = "a"."revision" LIMIT 1
    ) "c"
    GROUP BY "a"."session_id", "a"."object_key"
  ),
  "now" AS (
    INSERT INTO "checkpoint_output_objects" AS "o" ("session_id", "object_key", "bytes", "live_refs", "first_at", "released_at")
    SELECT "session_id", "object_key", "bytes", "live_refs", "first_at", "released_at" FROM "added"
    ON CONFLICT ("session_id", "object_key") DO UPDATE
      SET "bytes" = GREATEST("o"."bytes", EXCLUDED."bytes"),
          "live_refs" = "o"."live_refs" + EXCLUDED."live_refs",
          "first_at" = LEAST("o"."first_at", EXCLUDED."first_at"),
          "released_at" = GREATEST("o"."released_at", EXCLUDED."released_at")
    RETURNING "o"."bytes", "o"."live_refs"
  )
  SELECT coalesce(sum("bytes") FILTER (WHERE "live_refs" > 0), 0) INTO "now_kept" FROM "now";
  UPDATE "checkpoint_output_totals" SET "kept_bytes" = "kept_bytes" + "now_kept" - "was_kept"
  WHERE "scope" = 'installation';
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "checkpoint_output_objects_recount"("affected" uuid[]) RETURNS void LANGUAGE plpgsql
SET "enable_seqscan" = off AS $$
DECLARE
  "dropped" bigint;
  "counted" bigint;
BEGIN
  IF coalesce(cardinality("affected"), 0) = 0 THEN
    RETURN;
  END IF;
  PERFORM 1 FROM "checkpoint_output_totals" WHERE "scope" = 'installation' FOR UPDATE;
  WITH "gone" AS (
    DELETE FROM "checkpoint_output_objects" WHERE "session_id" = ANY("affected")
    RETURNING "bytes", "live_refs"
  )
  SELECT coalesce(sum("bytes") FILTER (WHERE "live_refs" > 0), 0) INTO "dropped" FROM "gone";
  WITH "kept" AS (
    INSERT INTO "checkpoint_output_objects" ("session_id", "object_key", "bytes", "live_refs", "first_at", "released_at")
    SELECT "co"."session_id", "co"."object_key", max("co"."bytes"),
           (count(*) FILTER (WHERE "c"."objects_purged_at" IS NULL))::integer,
           min("c"."committed_at"), max("c"."objects_purged_at")
    FROM "checkpoint_outputs" "co"
    JOIN "checkpoints" "c" ON "c"."session_id" = "co"."session_id" AND "c"."revision" = "co"."revision"
    WHERE "co"."session_id" = ANY("affected")
    GROUP BY "co"."session_id", "co"."object_key"
    RETURNING "bytes", "live_refs"
  )
  SELECT coalesce(sum("bytes") FILTER (WHERE "live_refs" > 0), 0) INTO "counted" FROM "kept";
  UPDATE "checkpoint_output_totals" SET "kept_bytes" = "kept_bytes" - "dropped" + "counted"
  WHERE "scope" = 'installation';
END
$$;
--> statement-breakpoint
-- A collection pass purges a revision once, which releases each key it was
-- the last unpurged revision to name. Any other change to the columns the
-- figures read (none is made today) counts the session again.
CREATE OR REPLACE FUNCTION "checkpoint_output_objects_release"() RETURNS trigger LANGUAGE plpgsql
SET "enable_seqscan" = off AS $$
BEGIN
  -- Most checkpoint updates (collected_at, profile fingerprints) touch
  -- neither column, and must not queue on the totals row.
  IF NOT EXISTS (
    SELECT 1 FROM "old_rows" "o" JOIN "new_rows" "n" USING ("session_id", "revision")
    WHERE "o"."committed_at" IS DISTINCT FROM "n"."committed_at"
       OR "o"."objects_purged_at" IS DISTINCT FROM "n"."objects_purged_at"
  ) THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM "checkpoint_output_totals" WHERE "scope" = 'installation' FOR UPDATE;
  WITH "purged" AS (
    SELECT "n"."session_id", "n"."revision", "n"."objects_purged_at"
    FROM "old_rows" "o" JOIN "new_rows" "n" USING ("session_id", "revision")
    WHERE "o"."objects_purged_at" IS NULL AND "n"."objects_purged_at" IS NOT NULL
      AND "o"."committed_at" = "n"."committed_at"
  ),
  "named" AS (
    SELECT "co"."session_id", "co"."object_key", count(*)::integer AS "refs",
           max("p"."objects_purged_at") AS "released_at"
    FROM "purged" "p"
    JOIN "checkpoint_outputs" "co" ON "co"."session_id" = "p"."session_id" AND "co"."revision" = "p"."revision"
    GROUP BY "co"."session_id", "co"."object_key"
  ),
  "released" AS (
    UPDATE "checkpoint_output_objects" AS "o"
    SET "live_refs" = "o"."live_refs" - "named"."refs",
        "released_at" = GREATEST("o"."released_at", "named"."released_at")
    FROM "named"
    WHERE "o"."session_id" = "named"."session_id" AND "o"."object_key" = "named"."object_key"
    RETURNING "o"."bytes", "o"."live_refs"
  )
  UPDATE "checkpoint_output_totals"
  SET "kept_bytes" = "kept_bytes" - (SELECT coalesce(sum("bytes"), 0) FROM "released" WHERE "live_refs" = 0)
  WHERE "scope" = 'installation' AND EXISTS (SELECT 1 FROM "released" WHERE "live_refs" = 0);
  PERFORM "checkpoint_output_objects_recount"(ARRAY(
    SELECT DISTINCT "n"."session_id"
    FROM "old_rows" "o" JOIN "new_rows" "n" USING ("session_id", "revision")
    WHERE "o"."committed_at" IS DISTINCT FROM "n"."committed_at"
       OR ("o"."objects_purged_at" IS NOT NULL
           AND "o"."objects_purged_at" IS DISTINCT FROM "n"."objects_purged_at")
  ));
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "checkpoint_output_objects_forget"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "checkpoint_output_objects_recount"(ARRAY(SELECT DISTINCT "session_id" FROM "removed_rows"));
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "checkpoint_output_objects_clear"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "checkpoint_output_objects";
  UPDATE "checkpoint_output_totals" SET "kept_bytes" = 0 WHERE "scope" = 'installation';
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- One transaction: writes to the four tables wait until it commits, so none
-- lands between a sum below and the trigger that counts it. Run again, it
-- counts from scratch.
DO $$
BEGIN
  LOCK TABLE "tool_calls", "provider_usage", "checkpoints", "checkpoint_outputs" IN SHARE ROW EXCLUSIVE MODE;
  DROP TRIGGER IF EXISTS "tool_calls_count_insert" ON "tool_calls";
  DROP TRIGGER IF EXISTS "tool_calls_count_update" ON "tool_calls";
  DROP TRIGGER IF EXISTS "tool_calls_count_delete" ON "tool_calls";
  DROP TRIGGER IF EXISTS "tool_calls_count_truncate" ON "tool_calls";
  DROP TRIGGER IF EXISTS "provider_usage_count_insert" ON "provider_usage";
  DROP TRIGGER IF EXISTS "provider_usage_count_delete" ON "provider_usage";
  DROP TRIGGER IF EXISTS "provider_usage_count_truncate" ON "provider_usage";
  DROP TRIGGER IF EXISTS "checkpoint_outputs_count_insert" ON "checkpoint_outputs";
  DROP TRIGGER IF EXISTS "checkpoint_outputs_count_delete" ON "checkpoint_outputs";
  DROP TRIGGER IF EXISTS "checkpoint_outputs_count_truncate" ON "checkpoint_outputs";
  DROP TRIGGER IF EXISTS "checkpoints_count_release" ON "checkpoints";
  CREATE TRIGGER "tool_calls_count_insert" AFTER INSERT ON "tool_calls"
    REFERENCING NEW TABLE AS "added_rows" FOR EACH STATEMENT EXECUTE FUNCTION "tool_call_outcomes_add"();
  CREATE TRIGGER "tool_calls_count_update" AFTER UPDATE ON "tool_calls"
    REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "tool_call_outcomes_move"();
  CREATE TRIGGER "tool_calls_count_delete" AFTER DELETE ON "tool_calls"
    REFERENCING OLD TABLE AS "removed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "tool_call_outcomes_recount"();
  CREATE TRIGGER "tool_calls_count_truncate" AFTER TRUNCATE ON "tool_calls"
    FOR EACH STATEMENT EXECUTE FUNCTION "tool_call_outcomes_clear"();
  CREATE TRIGGER "provider_usage_count_insert" AFTER INSERT ON "provider_usage"
    REFERENCING NEW TABLE AS "added_rows" FOR EACH STATEMENT EXECUTE FUNCTION "provider_usage_totals_add"();
  CREATE TRIGGER "provider_usage_count_delete" AFTER DELETE ON "provider_usage"
    REFERENCING OLD TABLE AS "removed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "provider_usage_totals_recount"();
  CREATE TRIGGER "provider_usage_count_truncate" AFTER TRUNCATE ON "provider_usage"
    FOR EACH STATEMENT EXECUTE FUNCTION "provider_usage_totals_clear"();
  CREATE TRIGGER "checkpoint_outputs_count_insert" AFTER INSERT ON "checkpoint_outputs"
    REFERENCING NEW TABLE AS "added_rows" FOR EACH STATEMENT EXECUTE FUNCTION "checkpoint_output_objects_add"();
  CREATE TRIGGER "checkpoint_outputs_count_delete" AFTER DELETE ON "checkpoint_outputs"
    REFERENCING OLD TABLE AS "removed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "checkpoint_output_objects_forget"();
  CREATE TRIGGER "checkpoint_outputs_count_truncate" AFTER TRUNCATE ON "checkpoint_outputs"
    FOR EACH STATEMENT EXECUTE FUNCTION "checkpoint_output_objects_clear"();
  CREATE TRIGGER "checkpoints_count_release" AFTER UPDATE ON "checkpoints"
    REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "checkpoint_output_objects_release"();
  DELETE FROM "tool_call_outcomes";
  INSERT INTO "tool_call_outcomes" ("name", "outcome", "calls", "first_at")
  SELECT "name", "outcome", count(*), min("created_at") FROM "tool_calls" GROUP BY "name", "outcome";
  DELETE FROM "provider_usage_totals";
  INSERT INTO "provider_usage_totals" ("model", "priced_by", "calls", "input_tokens", "output_tokens",
    "cache_read_input_tokens", "cache_creation_input_tokens", "cost_usd", "first_at")
  SELECT "model", "priced_by", count(*), sum("input_tokens"), sum("output_tokens"),
         sum("cache_read_input_tokens"), sum("cache_creation_input_tokens"), sum("cost_usd"), min("recorded_at")
  FROM "provider_usage" GROUP BY "model", "priced_by";
  DELETE FROM "checkpoint_output_objects";
  INSERT INTO "checkpoint_output_objects" ("session_id", "object_key", "bytes", "live_refs", "first_at", "released_at")
  SELECT "co"."session_id", "co"."object_key", max("co"."bytes"),
         (count(*) FILTER (WHERE "c"."objects_purged_at" IS NULL))::integer,
         min("c"."committed_at"), max("c"."objects_purged_at")
  FROM "checkpoint_outputs" "co"
  JOIN "checkpoints" "c" ON "c"."session_id" = "co"."session_id" AND "c"."revision" = "co"."revision"
  GROUP BY "co"."session_id", "co"."object_key";
  INSERT INTO "checkpoint_output_totals" ("scope", "kept_bytes")
  SELECT 'installation', coalesce(sum("bytes") FILTER (WHERE "live_refs" > 0), 0) FROM "checkpoint_output_objects"
  ON CONFLICT ("scope") DO UPDATE SET "kept_bytes" = EXCLUDED."kept_bytes";
END
$$;
--> statement-breakpoint
-- After the bulk insert, so each is built once rather than kept row by row.
CREATE INDEX IF NOT EXISTS "checkpoint_output_objects_first_at_idx" ON "checkpoint_output_objects" USING btree ("first_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checkpoint_output_objects_released_at_idx" ON "checkpoint_output_objects" USING btree ("released_at") WHERE "checkpoint_output_objects"."live_refs" = 0;
--> statement-breakpoint
ANALYZE "tool_call_outcomes";
--> statement-breakpoint
ANALYZE "provider_usage_totals";
--> statement-breakpoint
ANALYZE "checkpoint_output_objects";
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "checkpoint_collection_settled_at" timestamp with time zone;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "sessions_collection_unsettled_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "sessions_collection_unsettled_idx" ON "sessions" USING btree ("id") WHERE "sessions"."checkpoint_collection_settled_at" IS NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "turns_unsettled_status_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "turns_unsettled_status_idx" ON "turns" USING btree ("status") WHERE "turns"."status" IN ('queued', 'running', 'needs_input', 'outcome_unknown');
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "pending_requests_denied_tool_use_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "pending_requests_denied_tool_use_idx" ON "pending_requests" USING btree ("session_id","tool_use_id") WHERE "pending_requests"."kind" = 'permission' AND ("pending_requests"."answer" ->> 'decision') = 'deny' AND "pending_requests"."tool_use_id" IS NOT NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "checkpoints_outputs_unrecorded_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "checkpoints_outputs_unrecorded_idx" ON "checkpoints" USING btree ("session_id") WHERE "checkpoints"."objects_purged_at" IS NULL AND NOT "checkpoints"."outputs_recorded";
--> statement-breakpoint
-- The same pairs as tool_calls_pair_uniq, tool_use id first. The old index
-- goes only once this one is valid; only a run that failed after dropping it
-- leaves the pairs unguarded while the next run rebuilds this one.
DROP INDEX CONCURRENTLY IF EXISTS "tool_calls_session_tool_use_uniq";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "tool_calls_session_tool_use_uniq" ON "tool_calls" USING btree ("session_id","tool_use_id","attempt_key") WHERE "tool_calls"."tool_use_id" IS NOT NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "tool_calls_pair_uniq";
