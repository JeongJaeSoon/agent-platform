ALTER TABLE "agents" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_description_check" CHECK ("agents"."description" IS NULL OR length("agents"."description") <= 2000);--> statement-breakpoint
-- The card's `role` was asked for as "what this agent takes on", which is
-- what a description says. Taken from the version people talk to, else the
-- newest one. Versions are not touched: their hashes cover the stored card.
UPDATE "agents" AS a
SET "description" = v."card"->>'role'
FROM "agent_versions" AS v
WHERE a."description" IS NULL
  AND v."agent_id" = a."id"
  AND v."card"->>'role' IS NOT NULL
  AND v."id" = COALESCE(
    (
      SELECT r."version_id"
      FROM "agent_releases" AS r
      WHERE r."id" = a."active_release_id" AND r."agent_id" = a."id"
    ),
    (
      SELECT latest."id"
      FROM "agent_versions" AS latest
      WHERE latest."agent_id" = a."id"
      ORDER BY latest."version_no" DESC
      LIMIT 1
    )
  );
