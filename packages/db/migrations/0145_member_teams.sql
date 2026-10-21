CREATE TABLE "agent_admin_teams" (
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_admin_teams_agent_id_team_id_pk" PRIMARY KEY("agent_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "member_team_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "member_teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "member_teams_workspace_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "member_teams_name_check" CHECK (length("member_teams"."name") BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "agent_admin_teams" ADD CONSTRAINT "agent_admin_teams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_admin_teams" ADD CONSTRAINT "agent_admin_teams_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_admin_teams" ADD CONSTRAINT "agent_admin_teams_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."member_teams"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_team_members" ADD CONSTRAINT "member_team_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_team_members" ADD CONSTRAINT "member_team_members_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."member_teams"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_team_members" ADD CONSTRAINT "member_team_members_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_teams" ADD CONSTRAINT "member_teams_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_teams" ADD CONSTRAINT "member_teams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_admin_teams_team_idx" ON "agent_admin_teams" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_team_members_live_uniq" ON "member_team_members" USING btree ("team_id","user_id") WHERE "member_team_members"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "member_team_members_user_idx" ON "member_team_members" USING btree ("workspace_id","user_id") WHERE "member_team_members"."removed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "member_teams_live_name_uniq" ON "member_teams" USING btree ("workspace_id","name") WHERE "member_teams"."archived_at" IS NULL;