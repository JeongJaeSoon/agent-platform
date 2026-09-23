CREATE TABLE "control_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_turn_id" bigint,
	"attempt_id" text,
	"receipt_id" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "control_intents_kind_check" CHECK ("control_intents"."kind" IN ('interrupt', 'pause', 'terminate')),
	CONSTRAINT "control_intents_interrupt_target_check" CHECK ("control_intents"."kind" <> 'interrupt' OR ("control_intents"."target_turn_id" IS NOT NULL AND "control_intents"."attempt_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "control_intents" ADD CONSTRAINT "control_intents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_intents" ADD CONSTRAINT "control_intents_target_turn_id_turns_id_fk" FOREIGN KEY ("target_turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_intents" ADD CONSTRAINT "control_intents_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "control_intents_receipt_uniq" ON "control_intents" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "control_intents_open_attempt_idx" ON "control_intents" USING btree ("attempt_id","issued_at") WHERE "control_intents"."settled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "control_intents_open_turn_idx" ON "control_intents" USING btree ("target_turn_id") WHERE "control_intents"."settled_at" IS NULL;