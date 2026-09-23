-- Rows from before the column get the moment they were last seen: already
-- past, so a legacy pod row is judged expired rather than given a TTL this
-- migration would have to guess. A gateway row is rewritten by its next
-- heartbeat, and the orphan reconciler never looks at those sessions.
ALTER TABLE "workers" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "workers" SET "lease_expires_at" = "last_seen";--> statement-breakpoint
ALTER TABLE "workers" ALTER COLUMN "lease_expires_at" SET NOT NULL;
