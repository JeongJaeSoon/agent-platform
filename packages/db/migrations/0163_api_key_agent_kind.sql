ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_agent_check";--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_kind_check";--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "name" text;--> statement-breakpoint
-- 94S-929: no key reaches a whole workspace as itself any more. A service key
-- bound to an agent becomes that agent's key; one outside any workspace is
-- the key CLI's operator key, unless its owner partition is a workspace's id,
-- which reaches that workspace as surely. A workspace-wide key has no successor:
-- moving it to an agent or a person would hand them authority nobody chose,
-- and nothing ran in production yet, so it is deleted. Its sessions stay and
-- lose their creating key, which leaves them to the people D21 names for a
-- session nobody made.
DO $$
DECLARE
  detached bigint;
  dropped bigint;
BEGIN
  UPDATE "api_keys" SET "kind" = 'agent'
  WHERE "kind" = 'service' AND "agent_id" IS NOT NULL;
  UPDATE "api_keys" AS k SET "kind" = 'operator'
  WHERE k."kind" = 'service' AND k."workspace_id" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "workspaces" AS w WHERE w."id"::text = k."owner_id");
  UPDATE "sessions" AS s
  SET "created_by_api_key_id" = NULL
  FROM "api_keys" AS k
  WHERE s."created_by_api_key_id" = k."id" AND k."kind" = 'service';
  GET DIAGNOSTICS detached = ROW_COUNT;
  DELETE FROM "api_keys" WHERE "kind" = 'service';
  GET DIAGNOSTICS dropped = ROW_COUNT;
  RAISE NOTICE '0163: % workspace keys deleted, % sessions detached from them', dropped, detached;
END $$;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_operator_check" CHECK ("api_keys"."kind" <> 'operator' OR "api_keys"."workspace_id" IS NULL);--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_name_check" CHECK ("api_keys"."name" IS NULL OR (char_length("api_keys"."name") BETWEEN 1 AND 64 AND "api_keys"."name" = btrim("api_keys"."name")));--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_agent_check" CHECK (("api_keys"."kind" = 'agent') = ("api_keys"."agent_id" IS NOT NULL) AND ("api_keys"."kind" <> 'agent' OR "api_keys"."workspace_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_kind_check" CHECK ("api_keys"."kind" IN ('personal', 'agent', 'operator'));
