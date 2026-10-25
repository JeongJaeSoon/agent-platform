CREATE TABLE "session_model_usage" (
	"session_id" uuid NOT NULL,
	"model" text NOT NULL,
	"session_created_at" timestamp with time zone NOT NULL,
	"agent_id" uuid,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_read_input_tokens" bigint NOT NULL,
	"cache_creation_input_tokens" bigint NOT NULL,
	"cost_usd" numeric(14, 6) NOT NULL,
	CONSTRAINT "session_model_usage_session_id_model_pk" PRIMARY KEY("session_id","model")
);
--> statement-breakpoint
CREATE TABLE "session_pre_metering_cost" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"session_created_at" timestamp with time zone NOT NULL,
	"cost_usd" numeric(14, 6) NOT NULL
);
--> statement-breakpoint
-- Replacing the function takes no lock on provider_usage, so hold inserts
-- off until this commits: none may land between the sums below and the
-- function that counts it. Sessions are only read.
LOCK TABLE "provider_usage" IN SHARE MODE;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sessions_count_provider_tokens"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH "counted" AS (
    UPDATE "sessions"
      SET "provider_tokens" = LEAST(
        "provider_tokens"::numeric + NEW."input_tokens" + NEW."cache_creation_input_tokens" + NEW."cache_read_input_tokens" + NEW."output_tokens",
        9007199254740991
      )::bigint
      WHERE "id" = NEW."session_id"
      RETURNING "created_at", "agent_release_id"
  )
  INSERT INTO "session_model_usage" AS "pair" ("session_id", "model", "session_created_at", "agent_id",
    "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "cost_usd")
  SELECT NEW."session_id", NEW."model", "counted"."created_at",
         (SELECT "agent_id" FROM "agent_releases" WHERE "id" = "counted"."agent_release_id"),
         LEAST(NEW."input_tokens", 9007199254740991), LEAST(NEW."output_tokens", 9007199254740991),
         LEAST(NEW."cache_read_input_tokens", 9007199254740991),
         LEAST(NEW."cache_creation_input_tokens", 9007199254740991), NEW."cost_usd"
  FROM "counted"
  ON CONFLICT ("session_id", "model") DO UPDATE
    SET "input_tokens" = LEAST("pair"."input_tokens"::numeric + EXCLUDED."input_tokens", 9007199254740991)::bigint,
        "output_tokens" = LEAST("pair"."output_tokens"::numeric + EXCLUDED."output_tokens", 9007199254740991)::bigint,
        "cache_read_input_tokens" = LEAST("pair"."cache_read_input_tokens"::numeric + EXCLUDED."cache_read_input_tokens", 9007199254740991)::bigint,
        "cache_creation_input_tokens" = LEAST("pair"."cache_creation_input_tokens"::numeric + EXCLUDED."cache_creation_input_tokens", 9007199254740991)::bigint,
        "cost_usd" = LEAST("pair"."cost_usd" + EXCLUDED."cost_usd", 99999999.999999);
  RETURN NULL;
END
$$;--> statement-breakpoint
INSERT INTO "session_model_usage" ("session_id", "model", "session_created_at", "agent_id",
  "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "cost_usd")
SELECT "usage"."session_id", "usage"."model", "sessions"."created_at", "agent_releases"."agent_id",
       LEAST("usage"."input_tokens", 9007199254740991)::bigint,
       LEAST("usage"."output_tokens", 9007199254740991)::bigint,
       LEAST("usage"."cache_read_input_tokens", 9007199254740991)::bigint,
       LEAST("usage"."cache_creation_input_tokens", 9007199254740991)::bigint,
       LEAST("usage"."cost_usd", 99999999.999999)
FROM (
  SELECT "session_id", "model", sum("input_tokens") AS "input_tokens", sum("output_tokens") AS "output_tokens",
         sum("cache_read_input_tokens") AS "cache_read_input_tokens",
         sum("cache_creation_input_tokens") AS "cache_creation_input_tokens",
         sum("cost_usd") AS "cost_usd"
  FROM "provider_usage"
  GROUP BY "session_id", "model"
) AS "usage"
JOIN "sessions" ON "sessions"."id" = "usage"."session_id"
LEFT JOIN "agent_releases" ON "agent_releases"."id" = "sessions"."agent_release_id";--> statement-breakpoint
INSERT INTO "session_pre_metering_cost" ("session_id", "session_created_at", "cost_usd")
SELECT "sessions"."id", "sessions"."created_at", "sessions"."cost_usd" - coalesce("metered"."cost_usd", 0)
FROM "sessions"
LEFT JOIN (
  SELECT "session_id", sum("cost_usd") AS "cost_usd" FROM "session_model_usage" GROUP BY "session_id"
) AS "metered" ON "metered"."session_id" = "sessions"."id"
WHERE "sessions"."cost_usd" > coalesce("metered"."cost_usd", 0);--> statement-breakpoint
-- After the bulk insert, so it is built once rather than kept row by row.
CREATE INDEX "session_model_usage_created_at_idx" ON "session_model_usage" USING btree ("session_created_at");--> statement-breakpoint
CREATE INDEX "session_pre_metering_cost_created_at_idx" ON "session_pre_metering_cost" USING btree ("session_created_at");--> statement-breakpoint
ANALYZE "session_model_usage";--> statement-breakpoint
ANALYZE "session_pre_metering_cost";