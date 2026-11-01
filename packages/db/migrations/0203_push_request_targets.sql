-- migrate:no-transaction
-- Every statement may run again: a failure part way leaves the ones before
-- it committed, and the next run starts from the top. The new index goes up
-- before the old one comes down, so an open request stays unique throughout.
DROP INDEX CONCURRENTLY IF EXISTS "push_requests_open_target_idx";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "push_requests_open_target_idx" ON "push_requests" USING btree ("session_id","repository_id","target_branch") WHERE "push_requests"."state" IN ('requested','approved','pushing');--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "push_requests_open_session_idx";--> statement-breakpoint
ALTER TABLE "push_requests" DROP CONSTRAINT IF EXISTS "push_requests_target_branch_check";--> statement-breakpoint
ALTER TABLE "push_requests" ADD CONSTRAINT "push_requests_target_branch_check" CHECK ("push_requests"."target_branch" = 'agent/' || "push_requests"."session_id"::text OR "push_requests"."target_branch" ~ ('^agent/' || "push_requests"."session_id"::text || '-[a-z0-9][a-z0-9-]{0,39}$')) NOT VALID;--> statement-breakpoint
ALTER TABLE "push_requests" VALIDATE CONSTRAINT "push_requests_target_branch_check";
