ALTER TABLE "sessions" ADD COLUMN "provider_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "sessions" SET "provider_tokens" = "usage"."tokens"
FROM (
	SELECT "session_id",
		sum("input_tokens" + "cache_creation_input_tokens" + "cache_read_input_tokens" + "output_tokens") AS "tokens"
	FROM "provider_usage"
	GROUP BY "session_id"
) AS "usage"
WHERE "sessions"."id" = "usage"."session_id";
