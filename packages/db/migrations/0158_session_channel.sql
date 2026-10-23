ALTER TABLE "sessions" ADD COLUMN "channel" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_channel_check" CHECK ("sessions"."channel" IN ('web','slack','api'));--> statement-breakpoint
-- Only what the row proves. A creator key is written only for an API key
-- caller, and a creator person without one only for a web-session login,
-- the one way a person signs in. Rows with neither stay null.
UPDATE "sessions" SET "channel" = 'api' WHERE "created_by_api_key_id" IS NOT NULL;--> statement-breakpoint
UPDATE "sessions" SET "channel" = 'web' WHERE "created_by_api_key_id" IS NULL AND "created_by_user_id" IS NOT NULL;
