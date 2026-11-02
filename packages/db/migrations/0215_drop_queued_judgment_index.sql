-- migrate:no-transaction
-- Apart from the migration that built achievement_judgments_pending_uniq:
-- a re-run of that one drops and rebuilds it, and the running code's ON
-- CONFLICT finds this index meanwhile.
DROP INDEX CONCURRENTLY IF EXISTS "achievement_judgments_queued_uniq";
