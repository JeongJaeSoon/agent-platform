ALTER TABLE "api_keys" ADD COLUMN "kind" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "created_by_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "takeover_required_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_created_by_api_key_id_api_keys_id_fk" FOREIGN KEY ("created_by_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_personal_creator_idx" ON "api_keys" USING btree ("created_by_user_id") WHERE "api_keys"."kind" = 'personal';--> statement-breakpoint
CREATE INDEX "sessions_created_by_user_idx" ON "sessions" USING btree ("created_by_user_id") WHERE "sessions"."created_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sessions_takeover_idx" ON "sessions" USING btree ("workspace_id","takeover_required_at") WHERE "sessions"."takeover_required_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_kind_check" CHECK ("api_keys"."kind" IN ('personal', 'service'));--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_personal_check" CHECK ("api_keys"."kind" <> 'personal' OR ("api_keys"."created_by_user_id" IS NOT NULL AND "api_keys"."workspace_id" IS NOT NULL));--> statement-breakpoint
-- Backfill (94S-152). Nothing here guesses a person.
-- * api_keys: every existing key becomes a service key (the column default)
--   with no known issuer (created_by_user_id NULL) and no expiry, so each
--   one keeps answering exactly as before (design D10, D17).
-- * sessions.workspace_id: filled only where owner_id is itself a
--   workspace id, which is what a cookie user's partition has been since
--   94S-151. Legacy owner partitions stay NULL; owner_workspace_map is not
--   read (94S-458).
-- * sessions.created_by_user_id, sessions.created_by_api_key_id,
--   turns.actor_id and receipts.actor stay NULL on existing rows: who asked
--   was never recorded, and an owner partition names no person.
-- The number of sessions filled is raised as a NOTICE when this runs.
DO $$
DECLARE
  filled bigint;
BEGIN
  UPDATE "sessions" AS s
  SET "workspace_id" = w."id"
  FROM "workspaces" AS w
  WHERE s."workspace_id" IS NULL AND s."owner_id" = w."id"::text;
  GET DIAGNOSTICS filled = ROW_COUNT;
  RAISE NOTICE '0132: sessions.workspace_id filled from owner_id on % rows', filled;
END $$;
