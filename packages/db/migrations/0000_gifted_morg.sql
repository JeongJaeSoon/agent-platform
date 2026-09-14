CREATE TYPE "public"."session_status" AS ENUM('queued', 'running', 'needs_input', 'idle', 'failed', 'stopped');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key_hash" "bytea" NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"session_id" uuid,
	"url" text NOT NULL,
	CONSTRAINT "pull_requests_session_id_url_pk" PRIMARY KEY("session_id","url")
);
--> statement-breakpoint
CREATE TABLE "queue_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_id" bigint,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"visible_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"claude_session_id" text,
	"owner_id" text NOT NULL,
	"repo_url" text NOT NULL,
	"branch" text NOT NULL,
	"status" "session_status" DEFAULT 'queued' NOT NULL,
	"pod_id" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"last_turn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"message" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"result_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "unassigned_sessions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"signaled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"pod_id" text PRIMARY KEY NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_messages" ADD CONSTRAINT "queue_messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_messages" ADD CONSTRAINT "queue_messages_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unassigned_sessions" ADD CONSTRAINT "unassigned_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_session_id_idx" ON "events" USING btree ("session_id","id");--> statement-breakpoint
CREATE INDEX "queue_messages_pick_idx" ON "queue_messages" USING btree ("session_id","id") WHERE "queue_messages"."claimed_by" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_pod_uniq" ON "sessions" USING btree ("pod_id") WHERE "sessions"."pod_id" IS NOT NULL;--> statement-breakpoint
CREATE FUNCTION queue_unassigned_session_count()
RETURNS DOUBLE PRECISION
LANGUAGE SQL
STABLE
AS $$
  SELECT COUNT(*)::DOUBLE PRECISION FROM unassigned_sessions
$$;
