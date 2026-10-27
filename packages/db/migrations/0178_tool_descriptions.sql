CREATE TABLE "tool_descriptions" (
	"session_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"event_id" bigint NOT NULL,
	CONSTRAINT "tool_descriptions_session_id_name_pk" PRIMARY KEY("session_id","name"),
	CONSTRAINT "tool_descriptions_description_check" CHECK (char_length("tool_descriptions"."description") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE INDEX "tool_descriptions_name_idx" ON "tool_descriptions" USING btree ("name","event_id" DESC NULLS LAST);