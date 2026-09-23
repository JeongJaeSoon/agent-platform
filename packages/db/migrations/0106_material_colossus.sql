ALTER TABLE "checkpoints" ADD COLUMN "manifest_version" text;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "versions_held" boolean DEFAULT false NOT NULL;