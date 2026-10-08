ALTER TABLE "sessions" ADD COLUMN "provider_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Every metered call adds its tokens to its session, whoever wrote the row:
-- an API build from before this migration, still serving during a rollout
-- or back after a rollback, knows nothing of the counter. The limit check is
-- the gates'; the count is here so no writer can skip it.
CREATE FUNCTION "sessions_count_provider_tokens"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "sessions"
    SET "provider_tokens" = "provider_tokens" + NEW."input_tokens" + NEW."cache_creation_input_tokens" + NEW."cache_read_input_tokens" + NEW."output_tokens"
    WHERE "id" = NEW."session_id";
  RETURN NULL;
END
$$;--> statement-breakpoint
-- Before the backfill: creating the trigger locks out usage inserts until
-- this migration commits, so none lands between the sum and the trigger.
CREATE TRIGGER "provider_usage_count_tokens" AFTER INSERT ON "provider_usage"
  FOR EACH ROW EXECUTE FUNCTION "sessions_count_provider_tokens"();--> statement-breakpoint
UPDATE "sessions" SET "provider_tokens" = "usage"."tokens"
FROM (
	SELECT "session_id",
		sum("input_tokens" + "cache_creation_input_tokens" + "cache_read_input_tokens" + "output_tokens") AS "tokens"
	FROM "provider_usage"
	GROUP BY "session_id"
) AS "usage"
WHERE "sessions"."id" = "usage"."session_id";
