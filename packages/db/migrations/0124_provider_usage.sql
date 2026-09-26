CREATE TABLE "provider_usage" (
	"exchange_id" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"attempt_id" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_creation_input_tokens" bigint NOT NULL,
	"cache_creation_1h_input_tokens" bigint NOT NULL,
	"cache_read_input_tokens" bigint NOT NULL,
	"estimated" boolean NOT NULL,
	"cost_usd" numeric(14, 6) NOT NULL,
	"priced_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_usage_priced_by_check" CHECK ("provider_usage"."priced_by" IN ('table', 'fallback')),
	CONSTRAINT "provider_usage_cost_usd_nonneg" CHECK ("provider_usage"."cost_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_usage_session_idx" ON "provider_usage" USING btree ("session_id");