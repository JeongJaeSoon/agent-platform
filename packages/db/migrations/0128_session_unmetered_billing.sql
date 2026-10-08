ALTER TABLE "provider_usage" DROP CONSTRAINT "provider_usage_priced_by_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "unmetered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_priced_by_check" CHECK ("provider_usage"."priced_by" IN ('table', 'fallback', 'unmetered'));