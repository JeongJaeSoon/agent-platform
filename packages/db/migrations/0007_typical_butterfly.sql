ALTER TABLE "worker_launches" ALTER COLUMN "nonce_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_launches" ALTER COLUMN "nonce_expires_at" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "worker_launches_open_session_idx" ON "worker_launches" USING btree ("session_id") WHERE "worker_launches"."slot_released_at" IS NULL AND "worker_launches"."session_id" IS NOT NULL;--> statement-breakpoint
-- Carry the launches the scheduler still owns into the one registry before
-- the plaintext column goes: only the hash survives the move, and an
-- execution that already has a launch row is left alone. Ten minutes is the
-- gateway's own nonce lifetime, measured from when the intent was committed.
INSERT INTO "worker_launches" (
  "execution_id", "generation", "partition", "session_id", "backend",
  "nonce_hash", "nonce_expires_at", "slot_reserved_at", "created_at"
)
SELECT
  "id", "generation", 'default', "session_id", "backend",
  sha256(convert_to("bootstrap_nonce", 'UTF8')),
  "created_at" + interval '10 minutes',
  "created_at", "created_at"
FROM "executions"
WHERE "bootstrap_nonce" IS NOT NULL
  AND "desired_state" = 'running'
  AND "observed_state" <> 'terminated'
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "executions" DROP COLUMN "bootstrap_nonce";
