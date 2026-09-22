CREATE TABLE "attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"execution_id" text NOT NULL,
	"lease_epoch" integer NOT NULL,
	"execution_generation" integer NOT NULL,
	"auth_revision" integer NOT NULL,
	"state" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text
);
--> statement-breakpoint
CREATE TABLE "worker_credentials" (
	"token_hash" "bytea" PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_launches" (
	"execution_id" text PRIMARY KEY NOT NULL,
	"generation" integer NOT NULL,
	"partition" text DEFAULT 'default' NOT NULL,
	"backend" text NOT NULL,
	"nonce_hash" "bytea" NOT NULL,
	"nonce_expires_at" timestamp with time zone NOT NULL,
	"claimed_attempt_id" text,
	"slot_reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"slot_released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_launches_nonce_hash_unique" UNIQUE("nonce_hash")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "execution_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "auth_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_credentials" ADD CONSTRAINT "worker_credentials_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_launches" ADD CONSTRAINT "worker_launches_claimed_attempt_id_attempts_id_fk" FOREIGN KEY ("claimed_attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempts_session_started_idx" ON "attempts" USING btree ("session_id","started_at");--> statement-breakpoint
CREATE INDEX "worker_credentials_live_idx" ON "worker_credentials" USING btree ("attempt_id") WHERE "worker_credentials"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "worker_launches_open_slot_idx" ON "worker_launches" USING btree ("partition") WHERE "worker_launches"."slot_released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "queue_messages_head_idx" ON "queue_messages" USING btree ("session_id","kind","id");