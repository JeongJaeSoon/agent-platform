CREATE TABLE "push_continuations" (
	"turn_id" bigint PRIMARY KEY NOT NULL,
	"continuation_turn_id" bigint,
	CONSTRAINT "push_continuations_continuation_turn_id_unique" UNIQUE("continuation_turn_id")
);
--> statement-breakpoint
ALTER TABLE "push_continuations" ADD CONSTRAINT "push_continuations_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_continuations" ADD CONSTRAINT "push_continuations_continuation_turn_id_turns_id_fk" FOREIGN KEY ("continuation_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;