ALTER TABLE "turns" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "turns" SET "created_at" = "started_at" WHERE "started_at" IS NOT NULL;
