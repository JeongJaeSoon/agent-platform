ALTER TABLE "approval_checkpoints" ADD COLUMN "runtime_engine" text;--> statement-breakpoint
ALTER TABLE "approval_checkpoints" ADD COLUMN "runtime_sdk_version" text;--> statement-breakpoint
ALTER TABLE "approval_checkpoints" ADD COLUMN "runtime_cli_version" text;--> statement-breakpoint
ALTER TABLE "approval_checkpoints" ADD COLUMN "runtime_profile_sha256" text;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "runtime_engine" text;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "runtime_sdk_version" text;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "runtime_cli_version" text;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "runtime_profile_sha256" text;