CREATE TABLE "turn_continuations" (
	"turn_id" bigint PRIMARY KEY NOT NULL,
	"parked_turn_id" bigint NOT NULL,
	CONSTRAINT "turn_continuations_parked_turn_id_unique" UNIQUE("parked_turn_id")
);
--> statement-breakpoint
ALTER TABLE "permission_grants" ADD COLUMN "attempt_id" text;--> statement-breakpoint
ALTER TABLE "turn_continuations" ADD CONSTRAINT "turn_continuations_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_continuations" ADD CONSTRAINT "turn_continuations_parked_turn_id_turns_id_fk" FOREIGN KEY ("parked_turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;