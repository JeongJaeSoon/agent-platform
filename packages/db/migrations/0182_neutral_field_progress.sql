CREATE TABLE "neutral_field_progress" (
	"id" integer PRIMARY KEY NOT NULL,
	"filled_through" bigint DEFAULT 0 NOT NULL,
	"history_through" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "neutral_field_progress_one_row" CHECK ("neutral_field_progress"."id" = 1)
);
--> statement-breakpoint
-- Every event stored so far was written before the control plane added the
-- engine-neutral fields; the API's fill reads them from 0.
INSERT INTO "neutral_field_progress" ("id", "filled_through", "history_through")
  SELECT 1, 0, coalesce(max("id"), 0) FROM "events";
