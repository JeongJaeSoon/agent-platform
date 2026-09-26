ALTER TABLE "provider_usage" ADD COLUMN "speed" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN "web_search_requests" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN "web_fetch_requests" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN "code_execution_requests" bigint DEFAULT 0 NOT NULL;