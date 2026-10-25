CREATE INDEX "sessions_created_at_idx" ON "sessions" USING btree ("created_at");--> statement-breakpoint
-- The usage series groups sessions by this exact expression. Without its
-- statistics the planner guesses a group per session and sorts every turn of
-- the period to disk instead of hashing into one group per day. Analyzed
-- here so the first read after the migration does not wait for autovacuum.
CREATE STATISTICS "sessions_created_day_stats" ON ((("created_at" AT TIME ZONE 'UTC'))::date) FROM "sessions";--> statement-breakpoint
ANALYZE "sessions";
