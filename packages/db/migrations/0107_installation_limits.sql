CREATE TABLE "storage_usage" (
	"scope" text PRIMARY KEY NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_usage_bytes_nonneg" CHECK ("storage_usage"."bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "cost_usd" numeric(14, 6) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_cost_usd_nonneg" CHECK ("sessions"."cost_usd" >= 0);--> statement-breakpoint
-- Every turn insert charges the installation's storage, whoever wrote it:
-- an API build from before this migration, still serving during a rollout,
-- knows nothing of the counter. The limit check is admitInput's; the charge
-- is here so no writer can skip it.
CREATE FUNCTION "storage_usage_charge_turn"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "storage_usage" ("scope", "bytes")
  VALUES ('installation', octet_length(NEW."message"))
  ON CONFLICT ("scope") DO UPDATE
    SET "bytes" = "storage_usage"."bytes" + EXCLUDED."bytes", "updated_at" = now();
  RETURN NULL;
END
$$;--> statement-breakpoint
-- Before the backfill: creating the trigger locks out turn inserts until this
-- migration commits, so none lands between the sum and the trigger.
CREATE TRIGGER "turns_charge_storage" AFTER INSERT ON "turns"
  FOR EACH ROW EXECUTE FUNCTION "storage_usage_charge_turn"();--> statement-breakpoint
-- Everything already retained counts against STORAGE_LIMIT_BYTES from the
-- first acceptance after this migration, not only what arrives later.
INSERT INTO "storage_usage" ("scope", "bytes")
SELECT 'installation', coalesce(sum(octet_length("message")), 0) FROM "turns";
