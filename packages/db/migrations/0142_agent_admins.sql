CREATE TABLE "agent_admins" (
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_admins_agent_id_user_id_pk" PRIMARY KEY("agent_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "invites" DROP CONSTRAINT "invites_role_check";--> statement-breakpoint
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_role_check";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
-- The composite foreign keys below reference it, so it comes first.
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_key" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "agent_admins" ADD CONSTRAINT "agent_admins_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_admins" ADD CONSTRAINT "agent_admins_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_admins" ADD CONSTRAINT "agent_admins_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_admins_user_idx" ON "agent_admins" USING btree ("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_agent_idx" ON "api_keys" USING btree ("agent_id") WHERE "api_keys"."agent_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_agent_check" CHECK ("api_keys"."agent_id" IS NULL OR ("api_keys"."kind" = 'service' AND "api_keys"."workspace_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_role_check" CHECK ("invites"."role" IN ('owner', 'admin', 'member'));--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_check" CHECK ("memberships"."role" IN ('owner', 'admin', 'member'));--> statement-breakpoint
-- Backfill (94S-574, D3): an agent's creator is its first admin. Agents made
-- before this migration were made by an owner, who manages every agent
-- anyway; the row keeps that true after a demotion, as it would have been
-- for an agent made today. A creator who is no longer a member gets none.
DO $$
DECLARE
  filled bigint;
BEGIN
  INSERT INTO "agent_admins" ("workspace_id", "agent_id", "user_id", "created_by")
  SELECT a."workspace_id", a."id", a."created_by", a."created_by"
  FROM "agents" AS a
  JOIN "memberships" AS m
    ON m."workspace_id" = a."workspace_id" AND m."user_id" = a."created_by"
  WHERE a."created_by" IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS filled = ROW_COUNT;
  RAISE NOTICE '0139: agent_admins filled from agents.created_by on % rows', filled;
END $$;
