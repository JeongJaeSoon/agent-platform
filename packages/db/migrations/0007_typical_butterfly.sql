ALTER TABLE "worker_launches" ALTER COLUMN "nonce_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_launches" ALTER COLUMN "nonce_expires_at" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "worker_launches_open_session_idx" ON "worker_launches" USING btree ("session_id") WHERE "worker_launches"."slot_released_at" IS NULL AND "worker_launches"."session_id" IS NOT NULL;--> statement-breakpoint
-- Every execution that still holds a slot moves into the one registry, or it
-- would vanish from it: the scheduler only reconciles launches, so a live row
-- with none would have its container reclaimed as an orphan and its session
-- left bound to an execution nobody ever confirms gone.
--
-- Only the hash survives the move. A row from before the intent columns
-- existed has no nonce to carry, and its launch keeps both columns null: it
-- was never claimable and must not become so, and the scheduler closes it out
-- rather than relaunching. Ten minutes is the gateway's own nonce lifetime,
-- measured from when the intent was committed.
--
-- The partition comes from where the session is actually waiting, because
-- that is what a claim matches on; `default` only when nothing is signalled.
-- An execution the gateway already registered is left alone.
INSERT INTO "worker_launches" (
  "execution_id", "generation", "partition", "session_id", "backend",
  "nonce_hash", "nonce_expires_at", "slot_reserved_at", "created_at"
)
SELECT
  e."id",
  e."generation",
  COALESCE(u."partition", 'default'),
  e."session_id",
  e."backend",
  CASE
    WHEN e."bootstrap_nonce" IS NULL THEN NULL
    ELSE sha256(convert_to(e."bootstrap_nonce", 'UTF8'))
  END,
  CASE
    WHEN e."bootstrap_nonce" IS NULL THEN NULL
    ELSE e."created_at" + interval '10 minutes'
  END,
  e."created_at",
  e."created_at"
FROM "executions" e
LEFT JOIN "unassigned_sessions" u ON u."session_id" = e."session_id"
WHERE e."desired_state" = 'running'
  AND e."observed_state" <> 'terminated'
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "executions" DROP COLUMN "bootstrap_nonce";
