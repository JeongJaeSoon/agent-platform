ALTER TABLE "agents" ADD COLUMN "managing_team_id" uuid;--> statement-breakpoint
ALTER TABLE "member_team_members" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_managing_team_fk" FOREIGN KEY ("workspace_id","managing_team_id") REFERENCES "public"."member_teams"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_managing_team_idx" ON "agents" USING btree ("managing_team_id") WHERE "agents"."managing_team_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "member_team_members" ADD CONSTRAINT "member_team_members_role_check" CHECK ("member_team_members"."role" IN ('lead','member'));