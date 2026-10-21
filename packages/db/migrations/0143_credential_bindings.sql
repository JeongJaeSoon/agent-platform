CREATE TABLE "credential_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"credential_ref" text NOT NULL,
	"target" text NOT NULL,
	"target_id" uuid NOT NULL,
	"bound_by" uuid NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "credential_bindings_target_check" CHECK ("credential_bindings"."target" IN ('agent','agent_identity')),
	CONSTRAINT "credential_bindings_ref_check" CHECK ("credential_bindings"."credential_ref" ~ '^[a-z0-9][a-z0-9._:/-]{0,127}$')
);
--> statement-breakpoint
ALTER TABLE "credential_bindings" ADD CONSTRAINT "credential_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_bindings" ADD CONSTRAINT "credential_bindings_bound_by_users_id_fk" FOREIGN KEY ("bound_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credential_bindings_live_idx" ON "credential_bindings" USING btree ("target","target_id","credential_ref") WHERE "credential_bindings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "credential_bindings_ref_idx" ON "credential_bindings" USING btree ("workspace_id","credential_ref") WHERE "credential_bindings"."revoked_at" IS NULL;--> statement-breakpoint
-- A credential an agent identity runs on (a Slack bot token) is that
-- identity's alone: no agent session may be handed it, and a name already
-- bound to an agent cannot become an identity's. Checked here rather than in
-- one store so every writer meets it; the advisory lock serialises two
-- writers of the same name, which no index can express across targets.
CREATE FUNCTION "credential_bindings_exclusive_target"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."revoked_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('credential_bindings:' || NEW."workspace_id"::text || ':' || NEW."credential_ref", 0)
  );
  IF EXISTS (
    SELECT 1 FROM "credential_bindings"
    WHERE "workspace_id" = NEW."workspace_id"
      AND "credential_ref" = NEW."credential_ref"
      AND "revoked_at" IS NULL
      AND (NEW."target" = 'agent_identity' OR "target" = 'agent_identity')
      AND "id" <> NEW."id"
  ) THEN
    RAISE EXCEPTION 'credential % is bound to another target kind', NEW."credential_ref"
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'credential_bindings_exclusive_target';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "credential_bindings_exclusive_target" BEFORE INSERT OR UPDATE ON "credential_bindings"
  FOR EACH ROW EXECUTE FUNCTION "credential_bindings_exclusive_target"();
