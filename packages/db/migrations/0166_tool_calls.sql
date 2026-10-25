CREATE TABLE "tool_call_progress" (
	"id" integer PRIMARY KEY NOT NULL,
	"applied_through" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_call_progress_one_row" CHECK ("tool_call_progress"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"use_event_id" bigint NOT NULL,
	"ord" integer NOT NULL,
	"session_id" uuid NOT NULL,
	"attempt_key" text NOT NULL,
	"tool_use_id" text,
	"name" text NOT NULL,
	"used_at" timestamp with time zone,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"result_event_id" bigint,
	"result_at" timestamp with time zone,
	"outcome" text DEFAULT 'unknown' NOT NULL,
	"ms" bigint,
	CONSTRAINT "tool_calls_use_event_id_ord_pk" PRIMARY KEY("use_event_id","ord"),
	CONSTRAINT "tool_calls_outcome_check" CHECK ("tool_calls"."outcome" IN ('ok', 'failed', 'unknown')),
	CONSTRAINT "tool_calls_ms_check" CHECK ("tool_calls"."ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tool_call_days" (
	"scope_key" text NOT NULL,
	"agent_key" text NOT NULL,
	"day" date NOT NULL,
	"name" text NOT NULL,
	"calls" integer NOT NULL,
	"failed" integer NOT NULL,
	"timed" integer NOT NULL,
	"total_ms" bigint NOT NULL,
	"max_ms" bigint NOT NULL,
	"hist" integer[] NOT NULL,
	CONSTRAINT "tool_call_days_scope_key_agent_key_day_name_pk" PRIMARY KEY("scope_key","agent_key","day","name"),
	CONSTRAINT "tool_call_days_hist_check" CHECK (array_length("tool_call_days"."hist", 1) = 161)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tool_calls_pair_uniq" ON "tool_calls" USING btree ("session_id","attempt_key","tool_use_id") WHERE "tool_calls"."tool_use_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tool_calls_recent_idx" ON "tool_calls" USING btree ("name","at" DESC NULLS LAST,"use_event_id" DESC NULLS LAST,"ord" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tool_calls_slowest_idx" ON "tool_calls" USING btree ("name","ms" DESC NULLS LAST,"use_event_id" DESC NULLS LAST,"ord" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tool_calls_created_at_idx" ON "tool_calls" USING btree ("created_at");--> statement-breakpoint
-- From 0: the reconciler's projection fills tool_calls from every existing
-- event in its own batches, so this migration copies nothing.
INSERT INTO "tool_call_progress" ("id", "applied_through") VALUES (1, 0);--> statement-breakpoint
-- A duration's histogram bucket: 0 for 0ms, then one bucket per 10% from 1ms
-- (bucket b holds [1.1^(b-1), 1.1^b) ms), the last one everything from about
-- 65 minutes up. Reading a bucket back as its geometric middle is within 5%
-- (tool-calls-hist.ts).
CREATE FUNCTION "tool_ms_bucket"("ms" bigint) RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN ms IS NULL THEN NULL WHEN ms < 1 THEN 0
    ELSE least(160, 1 + floor(ln(ms) / ln(1.1))::integer) END
$$;--> statement-breakpoint
CREATE FUNCTION "tool_hist_step"("state" integer[], "bucket" integer, "delta" integer) RETURNS integer[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN bucket IS NULL THEN s
    ELSE s[1:bucket] || (s[bucket + 1] + delta) || s[bucket + 2:161] END
  FROM (SELECT coalesce(state, array_fill(0, ARRAY[161])) AS s) AS z
$$;--> statement-breakpoint
-- tool_hist(bucket, delta): the histogram of a group's (bucket, delta) pairs.
CREATE AGGREGATE "tool_hist"(integer, integer) (SFUNC = "tool_hist_step", STYPE = integer[]);--> statement-breakpoint
CREATE FUNCTION "tool_hist_add"("a" integer[], "b" integer[]) RETURNS integer[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT array_agg(coalesce(x, 0) + coalesce(y, 0) ORDER BY i)
  FROM unnest(coalesce(a, array_fill(0, ARRAY[161])), coalesce(b, array_fill(0, ARRAY[161]))) WITH ORDINALITY AS t(x, y, i)
$$;--> statement-breakpoint
-- tool_hist_sum(hist): histograms added bucket by bucket.
CREATE AGGREGATE "tool_hist_sum"(integer[]) (SFUNC = "tool_hist_add", STYPE = integer[]);
