CREATE TABLE "linked_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_tenant" text NOT NULL,
	"external_user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_reason" text,
	"verified_via" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "linked_accounts_provider_check" CHECK ("linked_accounts"."provider" IN ('slack')),
	CONSTRAINT "linked_accounts_status_check" CHECK ("linked_accounts"."status" IN ('active', 'stale', 'revoked')),
	CONSTRAINT "linked_accounts_revoked_check" CHECK (("linked_accounts"."status" = 'revoked') = ("linked_accounts"."revoked_at" IS NOT NULL) AND ("linked_accounts"."status" = 'revoked') = ("linked_accounts"."revoked_reason" IS NOT NULL)),
	CONSTRAINT "linked_accounts_revoked_reason_check" CHECK ("linked_accounts"."revoked_reason" IS NULL OR "linked_accounts"."revoked_reason" IN ('unlinked', 'offboarded'))
);
--> statement-breakpoint
ALTER TABLE "linked_accounts" ADD CONSTRAINT "linked_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linked_accounts" ADD CONSTRAINT "linked_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linked_accounts_external_live_uniq" ON "linked_accounts" USING btree ("provider","external_tenant","external_user_id") WHERE "linked_accounts"."status" <> 'revoked';--> statement-breakpoint
CREATE UNIQUE INDEX "linked_accounts_user_live_uniq" ON "linked_accounts" USING btree ("user_id","provider","external_tenant") WHERE "linked_accounts"."status" <> 'revoked';--> statement-breakpoint
CREATE INDEX "linked_accounts_workspace_user_idx" ON "linked_accounts" USING btree ("workspace_id","user_id");