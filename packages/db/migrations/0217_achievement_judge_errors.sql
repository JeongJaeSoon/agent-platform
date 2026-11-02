-- migrate:no-transaction
-- Every statement may run again: a failure part way leaves the ones before
-- it committed, and the next run starts from the top. The widened CHECK
-- accepts every row the old one did; it is added NOT VALID and validated
-- in its own statement, so the scan does not hold the ADD's lock.
ALTER TABLE "achievement_judgments" DROP CONSTRAINT IF EXISTS "achievement_judgments_error_code_check";--> statement-breakpoint
ALTER TABLE "achievement_judgments" ADD CONSTRAINT "achievement_judgments_error_code_check" CHECK ("achievement_judgments"."error_code" IS NULL OR "achievement_judgments"."error_code" IN ('judge_unavailable','outputs_unavailable','session_limit','judge_refused','judge_timeout','judge_http_error','judge_bad_response')) NOT VALID;--> statement-breakpoint
ALTER TABLE "achievement_judgments" VALIDATE CONSTRAINT "achievement_judgments_error_code_check";
