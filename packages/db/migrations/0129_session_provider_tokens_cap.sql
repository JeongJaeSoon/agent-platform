-- The count stops at 2^53-1, where readers can still hold it as a JS number,
-- and sums in numeric so no token values can overflow it: a trigger error
-- would roll back the usage row, and with it the call's cost.
CREATE OR REPLACE FUNCTION "sessions_count_provider_tokens"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "sessions"
    SET "provider_tokens" = LEAST(
      "provider_tokens"::numeric + NEW."input_tokens" + NEW."cache_creation_input_tokens" + NEW."cache_read_input_tokens" + NEW."output_tokens",
      9007199254740991
    )::bigint
    WHERE "id" = NEW."session_id";
  RETURN NULL;
END
$$;
