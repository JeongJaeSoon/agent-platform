CREATE TABLE "grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"service_principal_id" text,
	"actions" text[] NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"audience_kind" text NOT NULL,
	"audience_id" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grants_actor_kind_check" CHECK ("grants"."actor_kind" IN ('user', 'service')),
	CONSTRAINT "grants_resource_kind_check" CHECK ("grants"."resource_kind" IN ('workspace','session','invite','agent','agent_release','surface_binding','session_link','dispatch','memory','routine','artifact')),
	CONSTRAINT "grants_audience_kind_check" CHECK ("grants"."audience_kind" IN ('workspace','surface_binding','session_link','session')),
	CONSTRAINT "grants_actions_check" CHECK (cardinality("grants"."actions") > 0 AND coalesce(array_ndims("grants"."actions"), 1) = 1 AND "grants"."actions" <@ ARRAY['workspace.read','workspace.manage','agent.manage','binding.manage','routine.manage','session.read','session.submit','session.approve','session.control','session.recover','memory.read','memory.write','artifact.read','delivery.send']::text[]),
	CONSTRAINT "grants_actions_resource_check" CHECK ("grants"."actions" <@ CASE "resource_kind" WHEN 'workspace' THEN ARRAY['workspace.read','workspace.manage','agent.manage','binding.manage','routine.manage','memory.read','memory.write']::text[] WHEN 'session' THEN ARRAY['session.read','session.submit','session.approve','session.control','session.recover','artifact.read','delivery.send']::text[] WHEN 'invite' THEN ARRAY[]::text[] WHEN 'agent' THEN ARRAY['agent.manage','binding.manage','routine.manage','memory.read','memory.write']::text[] WHEN 'agent_release' THEN ARRAY[]::text[] WHEN 'surface_binding' THEN ARRAY['binding.manage','session.submit','delivery.send']::text[] WHEN 'session_link' THEN ARRAY['session.read','session.submit','session.approve','session.control','delivery.send']::text[] WHEN 'dispatch' THEN ARRAY[]::text[] WHEN 'memory' THEN ARRAY['memory.read','memory.write']::text[] WHEN 'routine' THEN ARRAY['routine.manage']::text[] WHEN 'artifact' THEN ARRAY['artifact.read']::text[] ELSE ARRAY[]::text[] END),
	CONSTRAINT "grants_scopes_check" CHECK (coalesce(array_ndims("grants"."scopes"), 1) = 1 AND "grants"."scopes" <@ ARRAY['sessions:read','sessions:write','sessions:approve','sessions:control','sessions:recover']::text[]),
	CONSTRAINT "grants_revision_check" CHECK ("grants"."revision" >= 0),
	CONSTRAINT "grants_id_length_check" CHECK (length("grants"."actor_id") BETWEEN 1 AND 128 AND ("grants"."service_principal_id" IS NULL OR length("grants"."service_principal_id") BETWEEN 1 AND 128) AND length("grants"."resource_id") BETWEEN 1 AND 512 AND length("grants"."audience_id") BETWEEN 1 AND 512),
	CONSTRAINT "grants_workspace_ref_check" CHECK (("grants"."resource_kind" <> 'workspace' OR "grants"."resource_id" = "grants"."workspace_id"::text) AND ("grants"."audience_kind" <> 'workspace' OR "grants"."audience_id" = "grants"."workspace_id"::text))
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invites_role_check" CHECK ("invites"."role" IN ('owner', 'member')),
	CONSTRAINT "invites_email_lower_check" CHECK ("invites"."email" = lower("invites"."email")),
	CONSTRAINT "invites_single_outcome_check" CHECK ("invites"."accepted_at" IS NULL OR "invites"."revoked_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "memberships_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "memberships_role_check" CHECK ("memberships"."role" IN ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE "owner_workspace_map" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"mapped_by" uuid NOT NULL,
	"mapped_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_lower_check" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"user_agent" text,
	CONSTRAINT "web_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "scopes" text[];--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "actor" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "agent_release_id" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "actor_id" uuid;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_workspace_map" ADD CONSTRAINT "owner_workspace_map_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_workspace_map" ADD CONSTRAINT "owner_workspace_map_mapped_by_users_id_fk" FOREIGN KEY ("mapped_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grants_lookup_idx" ON "grants" USING btree ("workspace_id","actor_kind","actor_id","resource_kind","resource_id") WHERE "grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invites_live_email_uniq" ON "invites" USING btree ("workspace_id","email") WHERE "invites"."accepted_at" IS NULL AND "invites"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "web_sessions_user_live_idx" ON "web_sessions" USING btree ("user_id") WHERE "web_sessions"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_workspace_idx" ON "api_keys" USING btree ("workspace_id") WHERE "api_keys"."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sessions_workspace_idx" ON "sessions" USING btree ("workspace_id") WHERE "sessions"."workspace_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_id_owner_workspace_uniq" UNIQUE("id","owner_id","workspace_id");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_scopes_check" CHECK ("api_keys"."scopes" IS NULL OR (coalesce(array_ndims("api_keys"."scopes"), 1) = 1 AND "api_keys"."scopes" <@ ARRAY['sessions:read','sessions:write','sessions:approve','sessions:control','sessions:recover']::text[]));