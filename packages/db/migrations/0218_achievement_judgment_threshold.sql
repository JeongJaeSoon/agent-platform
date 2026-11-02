-- migrate:no-transaction
-- Every statement may run again: a failure part way leaves the ones before
-- it committed, and the next run starts from the top. The new column is
-- null everywhere; the CHECK is added NOT VALID and validated in its own
-- statement, so the scan does not hold the ADD's lock.
ALTER TABLE "achievement_judgments" ADD COLUMN IF NOT EXISTS "threshold" double precision;--> statement-breakpoint
ALTER TABLE "achievement_judgments" DROP CONSTRAINT IF EXISTS "achievement_judgments_threshold_check";--> statement-breakpoint
ALTER TABLE "achievement_judgments" ADD CONSTRAINT "achievement_judgments_threshold_check" CHECK ("achievement_judgments"."threshold" IS NULL OR "achievement_judgments"."threshold" BETWEEN 0 AND 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "achievement_judgments" VALIDATE CONSTRAINT "achievement_judgments_threshold_check";
