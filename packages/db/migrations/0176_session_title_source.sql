CREATE TABLE "session_title_requests" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"auth_revision" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Existing rows are 'user': a given title and a derived one look the same.
ALTER TABLE "sessions" ADD COLUMN "title_source" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "title_source" SET DEFAULT 'derived';--> statement-breakpoint
ALTER TABLE "session_title_requests" ADD CONSTRAINT "session_title_requests_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_title_requests" ADD CONSTRAINT "session_title_requests_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_title_requests_token_uniq" ON "session_title_requests" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_title_source_check" CHECK ("sessions"."title_source" IN ('derived', 'user', 'generated'));