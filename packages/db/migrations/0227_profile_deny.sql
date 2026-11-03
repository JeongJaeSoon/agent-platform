ALTER TABLE "installation_profiles" ADD COLUMN "deny" jsonb;--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD COLUMN "tool_catalog_id" text;--> statement-breakpoint
ALTER TABLE "workspace_profiles" ADD COLUMN "deny" jsonb;--> statement-breakpoint
ALTER TABLE "workspace_profiles" ADD COLUMN "tool_catalog_id" text;--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD CONSTRAINT "installation_profiles_deny_check" CHECK ("installation_profiles"."deny" IS NULL OR (jsonb_typeof("installation_profiles"."deny") = 'array' AND "installation_profiles"."tool_catalog_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "workspace_profiles" ADD CONSTRAINT "workspace_profiles_deny_check" CHECK ("workspace_profiles"."deny" IS NULL OR (jsonb_typeof("workspace_profiles"."deny") = 'array' AND "workspace_profiles"."tool_catalog_id" IS NOT NULL));