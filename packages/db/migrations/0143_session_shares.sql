CREATE TABLE "session_share_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid,
	"team_id" uuid,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_share_targets_one_check" CHECK (("session_share_targets"."user_id" IS NULL) <> ("session_share_targets"."team_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "session_shares" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "session_shares_workspace_session_key" UNIQUE("workspace_id","session_id"),
	CONSTRAINT "session_shares_scope_check" CHECK ("session_shares"."scope" IN ('private', 'people', 'team', 'workspace'))
);
--> statement-breakpoint
ALTER TABLE "session_share_targets" ADD CONSTRAINT "session_share_targets_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_share_targets" ADD CONSTRAINT "session_share_targets_share_fk" FOREIGN KEY ("workspace_id","session_id") REFERENCES "public"."session_shares"("workspace_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_share_targets" ADD CONSTRAINT "session_share_targets_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_share_targets" ADD CONSTRAINT "session_share_targets_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."member_teams"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_shares" ADD CONSTRAINT "session_shares_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_shares" ADD CONSTRAINT "session_shares_session_fk" FOREIGN KEY ("session_id","owner_id","workspace_id") REFERENCES "public"."sessions"("id","owner_id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_share_targets_user_uniq" ON "session_share_targets" USING btree ("session_id","user_id") WHERE "session_share_targets"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "session_share_targets_team_uniq" ON "session_share_targets" USING btree ("session_id","team_id") WHERE "session_share_targets"."team_id" IS NOT NULL;