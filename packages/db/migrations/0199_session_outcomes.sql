CREATE TABLE "outcome_refresh_quotas" (
	"quota_key" text PRIMARY KEY NOT NULL,
	"rate_limit" integer,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"paused_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session_outcomes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"agent_release_id" text,
	"agent_id" uuid,
	"type" text NOT NULL,
	"url" text NOT NULL,
	"repository_id" text,
	"external_id" text,
	"state" text NOT NULL,
	"state_changed_at" timestamp with time zone NOT NULL,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"state_checked_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"check_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"receipt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_outcomes_session_type_url_key" UNIQUE("session_id","type","url"),
	CONSTRAINT "session_outcomes_type_check" CHECK ("session_outcomes"."type" IN ('github_pull_request')),
	CONSTRAINT "session_outcomes_pull_request_state_check" CHECK ("session_outcomes"."type" <> 'github_pull_request' OR "session_outcomes"."state" IN ('open','merged','closed')),
	CONSTRAINT "session_outcomes_check_error_check" CHECK ("session_outcomes"."check_error" IS NULL OR "session_outcomes"."check_error" IN ('not_found','forge_failed','github_refused')),
	CONSTRAINT "session_outcomes_lease_check" CHECK (("session_outcomes"."lease_token" IS NULL) = ("session_outcomes"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "session_outcomes" ADD CONSTRAINT "session_outcomes_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_outcomes" ADD CONSTRAINT "session_outcomes_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_outcomes_refresh_idx" ON "session_outcomes" USING btree ("state_checked_at") WHERE "session_outcomes"."type" = 'github_pull_request' AND "session_outcomes"."state" <> 'merged';