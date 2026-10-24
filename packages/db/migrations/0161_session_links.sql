CREATE TABLE "session_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"session_id" uuid,
	"surface" text DEFAULT 'slack' NOT NULL,
	"installation_id" uuid NOT NULL,
	"surface_binding_id" uuid NOT NULL,
	"surface_ref" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"opened_by_ts" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"release_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"role" text DEFAULT 'primary' NOT NULL,
	"visibility" text DEFAULT 'full' NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "session_links_surface_ref_key" UNIQUE("installation_id","surface_ref"),
	CONSTRAINT "session_links_surface_check" CHECK ("session_links"."surface" = 'slack'),
	CONSTRAINT "session_links_role_check" CHECK ("session_links"."role" IN ('primary', 'mirror')),
	CONSTRAINT "session_links_visibility_check" CHECK ("session_links"."visibility" IN ('full', 'summary')),
	CONSTRAINT "session_links_revision_check" CHECK ("session_links"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "session_links" ADD CONSTRAINT "session_links_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_links" ADD CONSTRAINT "session_links_surface_binding_id_surface_bindings_id_fk" FOREIGN KEY ("surface_binding_id") REFERENCES "public"."surface_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_links" ADD CONSTRAINT "session_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_links" ADD CONSTRAINT "session_links_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_links" ADD CONSTRAINT "session_links_release_fk" FOREIGN KEY ("agent_id","release_id") REFERENCES "public"."agent_releases"("agent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_links" ADD CONSTRAINT "session_links_installation_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."slack_installations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_links_session_uniq" ON "session_links" USING btree ("session_id") WHERE "session_links"."session_id" IS NOT NULL;