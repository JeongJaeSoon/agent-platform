CREATE TABLE "agent_activation_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"release_id" text NOT NULL,
	"previous_release_id" text,
	"activation_revision" integer,
	"actor_user_id" uuid NOT NULL,
	"actor" jsonb,
	"receipt_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_activation_events_kind_check" CHECK ("agent_activation_events"."kind" IN ('release_created','activated')),
	CONSTRAINT "agent_activation_events_revision_check" CHECK (("agent_activation_events"."kind" = 'activated') = ("agent_activation_events"."activation_revision" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "agent_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"card_sha256" text NOT NULL,
	"runtime_profile_id" text NOT NULL,
	"profile_digest" text NOT NULL,
	"runtime_config_snapshot" jsonb NOT NULL,
	"effective_tools" jsonb NOT NULL,
	"policy_pins" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	CONSTRAINT "agent_releases_agent_id_key" UNIQUE("agent_id","id"),
	CONSTRAINT "agent_releases_approval_check" CHECK (("agent_releases"."approved_by" IS NULL) = ("agent_releases"."approved_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"card" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_versions_agent_id_key" UNIQUE("agent_id","id"),
	CONSTRAINT "agent_versions_number_check" CHECK ("agent_versions"."version_no" > 0),
	CONSTRAINT "agent_versions_content_check" CHECK ("agent_versions"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"active_release_id" text,
	"activation_revision" integer DEFAULT -1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_status_check" CHECK ("agents"."status" IN ('active','paused','archived')),
	CONSTRAINT "agents_slug_check" CHECK (length("agents"."slug") BETWEEN 1 AND 64 AND "agents"."slug" ~ '^[a-z0-9][a-z0-9-]*$'),
	CONSTRAINT "agents_activation_check" CHECK ("agents"."activation_revision" >= -1 AND ("agents"."active_release_id" IS NULL) = ("agents"."activation_revision" = -1))
);
--> statement-breakpoint
ALTER TABLE "agent_activation_events" ADD CONSTRAINT "agent_activation_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_activation_events" ADD CONSTRAINT "agent_activation_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_activation_events" ADD CONSTRAINT "agent_activation_events_release_id_agent_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."agent_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_activation_events" ADD CONSTRAINT "agent_activation_events_previous_release_id_agent_releases_id_fk" FOREIGN KEY ("previous_release_id") REFERENCES "public"."agent_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_activation_events" ADD CONSTRAINT "agent_activation_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_activation_events" ADD CONSTRAINT "agent_activation_events_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_releases" ADD CONSTRAINT "agent_releases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_releases" ADD CONSTRAINT "agent_releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_releases" ADD CONSTRAINT "agent_releases_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_releases" ADD CONSTRAINT "agent_releases_version_fk" FOREIGN KEY ("agent_id","version_id") REFERENCES "public"."agent_versions"("agent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_active_release_fk" FOREIGN KEY ("id","active_release_id") REFERENCES "public"."agent_releases"("agent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_activation_events_agent_idx" ON "agent_activation_events" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_versions_number_idx" ON "agent_versions" USING btree ("agent_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_versions_content_idx" ON "agent_versions" USING btree ("agent_id","content_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_workspace_slug_idx" ON "agents" USING btree ("workspace_id","slug");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_release_id_agent_releases_id_fk" FOREIGN KEY ("agent_release_id") REFERENCES "public"."agent_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Versions and activation events are insert-only, and so is a release apart
-- from its approval, which the first activation sets once. Enforced here so
-- that no writer, present or future, can rewrite what a release id names.
CREATE FUNCTION "agents_reject_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are insert-only', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END $$;--> statement-breakpoint
CREATE FUNCTION "agent_releases_approve_once"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."approved_by" IS NULL
     AND (to_jsonb(NEW) - 'approved_by' - 'approved_at')
       = (to_jsonb(OLD) - 'approved_by' - 'approved_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'agent_releases rows are insert-only apart from their first approval'
    USING ERRCODE = 'integrity_constraint_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "agent_versions_insert_only" BEFORE UPDATE OR DELETE ON "agent_versions"
  FOR EACH ROW EXECUTE FUNCTION "agents_reject_mutation"();--> statement-breakpoint
CREATE TRIGGER "agent_activation_events_insert_only" BEFORE UPDATE OR DELETE ON "agent_activation_events"
  FOR EACH ROW EXECUTE FUNCTION "agents_reject_mutation"();--> statement-breakpoint
CREATE TRIGGER "agent_releases_approve_once" BEFORE UPDATE OR DELETE ON "agent_releases"
  FOR EACH ROW EXECUTE FUNCTION "agent_releases_approve_once"();
