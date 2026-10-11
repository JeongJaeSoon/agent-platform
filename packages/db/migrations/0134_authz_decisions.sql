CREATE TABLE "authz_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_id" text NOT NULL,
	"workspace_id" uuid,
	"principal_kind" text,
	"principal_id" text,
	"actor_user_id" uuid,
	"agent_id" uuid,
	"agent_release_id" text,
	"linked_account_id" text,
	"linked_account_revision" integer,
	"surface" jsonb NOT NULL,
	"action" text NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text,
	"outcome" text NOT NULL,
	"reason_code" text NOT NULL,
	"justification" text,
	"policy_version" text NOT NULL,
	"request_id" text NOT NULL,
	CONSTRAINT "authz_decisions_outcome_check" CHECK ("authz_decisions"."outcome" IN ('allow', 'deny', 'redact', 'require_approval')),
	CONSTRAINT "authz_decisions_principal_check" CHECK (("authz_decisions"."principal_kind" IS NULL) = ("authz_decisions"."principal_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "request_id" text;--> statement-breakpoint
CREATE INDEX "authz_decisions_request_idx" ON "authz_decisions" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "authz_decisions_at_idx" ON "authz_decisions" USING btree ("at");--> statement-breakpoint
CREATE INDEX "receipts_request_idx" ON "receipts" USING btree ("request_id");--> statement-breakpoint
CREATE FUNCTION "authz_decisions_refuse_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'authz_decisions is append-only';
END
$$;--> statement-breakpoint
CREATE TRIGGER "authz_decisions_append_only" BEFORE UPDATE ON "authz_decisions"
  FOR EACH ROW EXECUTE FUNCTION "authz_decisions_refuse_update"();
