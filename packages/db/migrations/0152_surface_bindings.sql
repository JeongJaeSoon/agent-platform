CREATE TABLE "surface_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"surface" text DEFAULT 'slack' NOT NULL,
	"installation_id" uuid,
	"external_surface_id" text,
	"surface_kind" text,
	"mode" text NOT NULL,
	"ceiling_actions" text[] NOT NULL,
	"ceiling_disclosure" text NOT NULL,
	"home" boolean DEFAULT false NOT NULL,
	"memory_write_policy" text DEFAULT 'deny' NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "surface_bindings_surface_check" CHECK ("surface_bindings"."surface" IN ('web','slack','api')),
	CONSTRAINT "surface_bindings_surface_kind_check" CHECK ("surface_bindings"."surface_kind" IN ('public_channel','private_channel','dm')),
	CONSTRAINT "surface_bindings_mode_check" CHECK ("surface_bindings"."mode" IN ('off','mention','ambient')),
	CONSTRAINT "surface_bindings_ceiling_check" CHECK ("surface_bindings"."ceiling_actions" <@ ARRAY['session.read','session.submit','session.control','session.approve']::text[] AND "surface_bindings"."ceiling_disclosure" IN ('full','summary')),
	CONSTRAINT "surface_bindings_memory_write_policy_check" CHECK ("surface_bindings"."memory_write_policy" IN ('deny','allow_explicit')),
	CONSTRAINT "surface_bindings_status_check" CHECK ("surface_bindings"."status" IN ('ready','partial','failed','revoked')),
	CONSTRAINT "surface_bindings_revoked_check" CHECK (("surface_bindings"."status" = 'revoked') = ("surface_bindings"."revoked_at" IS NOT NULL)),
	CONSTRAINT "surface_bindings_dm_check" CHECK ("surface_bindings"."surface_kind" IS DISTINCT FROM 'dm' OR ("surface_bindings"."external_surface_id" IS NULL AND NOT "surface_bindings"."home")),
	CONSTRAINT "surface_bindings_ready_check" CHECK ("surface_bindings"."surface" <> 'slack' OR "surface_bindings"."status" <> 'ready' OR ("surface_bindings"."installation_id" IS NOT NULL AND "surface_bindings"."surface_kind" IS NOT NULL AND ("surface_bindings"."external_surface_id" IS NOT NULL OR "surface_bindings"."surface_kind" = 'dm'))),
	CONSTRAINT "surface_bindings_revision_check" CHECK ("surface_bindings"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD CONSTRAINT "surface_bindings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD CONSTRAINT "surface_bindings_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD CONSTRAINT "surface_bindings_installation_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."slack_installations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "surface_bindings_channel_live_uniq" ON "surface_bindings" USING btree ("installation_id","external_surface_id") WHERE "surface_bindings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "surface_bindings_dm_live_uniq" ON "surface_bindings" USING btree ("installation_id") WHERE "surface_bindings"."surface_kind" = 'dm' AND "surface_bindings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "surface_bindings_home_live_uniq" ON "surface_bindings" USING btree ("agent_id") WHERE "surface_bindings"."home" AND "surface_bindings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "surface_bindings_agent_idx" ON "surface_bindings" USING btree ("agent_id");