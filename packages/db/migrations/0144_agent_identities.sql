CREATE TABLE "agent_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"installation_id" uuid NOT NULL,
	"external_principal_id" text NOT NULL,
	"credential_ref" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_identities_provider_check" CHECK ("agent_identities"."provider" IN ('slack_bot')),
	CONSTRAINT "agent_identities_status_check" CHECK ("agent_identities"."status" IN ('active','revoked')),
	CONSTRAINT "agent_identities_revoked_check" CHECK (("agent_identities"."status" = 'revoked') = ("agent_identities"."revoked_at" IS NOT NULL)),
	CONSTRAINT "agent_identities_credential_ref_check" CHECK ("agent_identities"."credential_ref" ~ '^[a-z0-9][a-z0-9._:/-]{0,127}$')
);
--> statement-breakpoint
-- The installation foreign key below references it, so it comes first.
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_workspace_id_key" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_installation_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."slack_installations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_identities_installation_live_uniq" ON "agent_identities" USING btree ("installation_id") WHERE "agent_identities"."status" = 'active';--> statement-breakpoint
CREATE INDEX "agent_identities_agent_idx" ON "agent_identities" USING btree ("agent_id");