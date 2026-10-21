ALTER TABLE "attempts" ADD COLUMN "profile_id" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "profile_fingerprint" text;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "profile_id" text;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "profile_fingerprint" text;--> statement-breakpoint
-- No session changed its profile before these columns: every earlier
-- attempt and checkpoint ran the profile its session names now.
UPDATE "attempts" SET "profile_id" = "sessions"."profile_id", "profile_fingerprint" = "sessions"."profile_fingerprint" FROM "sessions" WHERE "attempts"."session_id" = "sessions"."id";--> statement-breakpoint
UPDATE "checkpoints" SET "profile_id" = "sessions"."profile_id", "profile_fingerprint" = "sessions"."profile_fingerprint" FROM "sessions" WHERE "checkpoints"."session_id" = "sessions"."id";
