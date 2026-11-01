-- migrate:no-transaction
-- Every statement may run again: a failure part way leaves the ones before
-- it committed, and the next run starts from the top. Between the drop and
-- the add nothing checks the type; only the server writes outcomes, and the
-- widened CHECK accepts every row the old one did.
ALTER TABLE "session_outcomes" DROP CONSTRAINT IF EXISTS "session_outcomes_review_state_check";--> statement-breakpoint
ALTER TABLE "session_outcomes" ADD CONSTRAINT "session_outcomes_review_state_check" CHECK ("session_outcomes"."type" <> 'github_review' OR "session_outcomes"."state" IN ('submitted')) NOT VALID;--> statement-breakpoint
ALTER TABLE "session_outcomes" VALIDATE CONSTRAINT "session_outcomes_review_state_check";--> statement-breakpoint
ALTER TABLE "session_outcomes" DROP CONSTRAINT IF EXISTS "session_outcomes_type_check";--> statement-breakpoint
ALTER TABLE "session_outcomes" ADD CONSTRAINT "session_outcomes_type_check" CHECK ("session_outcomes"."type" IN ('github_pull_request','github_review')) NOT VALID;--> statement-breakpoint
ALTER TABLE "session_outcomes" VALIDATE CONSTRAINT "session_outcomes_type_check";
