ALTER TABLE "sessions" ADD COLUMN "partition" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
-- Backfill: the partition the session last ran in, as the retired
-- lastLaunchPartition read it from launch history (94S-212). The last claimed
-- launch by lease epoch; a reservation never claimed ranks after every claimed
-- one. A session that never ran stays 'default': a signal alone was never an
-- owner, only a claim made it one.
UPDATE "sessions" AS s
SET "partition" = latest."partition"
FROM (
  SELECT DISTINCT ON (e."session_id") e."session_id", wl."partition"
  FROM "executions" AS e
  JOIN "worker_launches" AS wl ON wl."execution_id" = e."id"
  LEFT JOIN "attempts" AS a ON a."id" = wl."claimed_attempt_id"
  ORDER BY e."session_id", a."lease_epoch" DESC NULLS LAST, e."generation" DESC
) AS latest
WHERE latest."session_id" = s."id";--> statement-breakpoint
-- A launch still holding its slot was placed by the old rule; moving it would
-- hand an issued nonce to another pool, so a disagreement stops the migration
-- for an operator to settle instead.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "worker_launches" AS wl
    JOIN "executions" AS e ON e."id" = wl."execution_id"
    JOIN "sessions" AS s ON s."id" = e."session_id"
    WHERE wl."slot_released_at" IS NULL AND wl."partition" <> s."partition"
  ) THEN
    RAISE EXCEPTION 'open worker launch in a partition other than its session''s backfilled one (94S-367)';
  END IF;
END $$;--> statement-breakpoint
-- A waiting signal follows its session, or the scheduler would reserve in the
-- session's partition a launch the claim looks for in the signal's.
UPDATE "unassigned_sessions" AS u
SET "partition" = s."partition"
FROM "sessions" AS s
WHERE s."id" = u."session_id" AND u."partition" <> s."partition";
