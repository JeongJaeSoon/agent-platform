ALTER TABLE "installation_profiles" ALTER COLUMN "repository_ids" DROP NOT NULL;--> statement-breakpoint
-- Imported rows held [] while repositories.yaml decided their repositories;
-- null marks them for the api role to fill once from that file.
UPDATE "installation_profiles" SET "repository_ids" = NULL WHERE "origin" = 'catalog';--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD COLUMN "blocked_by" uuid;--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD CONSTRAINT "installation_profiles_blocked_by_users_id_fk" FOREIGN KEY ("blocked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD CONSTRAINT "installation_profiles_blocked_check" CHECK (("installation_profiles"."blocked_at" IS NULL) = ("installation_profiles"."blocked_by" IS NULL));--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD CONSTRAINT "installation_profiles_repository_ids_check" CHECK ("installation_profiles"."repository_ids" IS NOT NULL OR "installation_profiles"."origin" = 'catalog');