ALTER TABLE "sessions" ADD COLUMN "first_worker_image" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "runtime_engine" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "runtime_sdk_version" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "runtime_cli_version" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "runtime_profile_sha256" text;