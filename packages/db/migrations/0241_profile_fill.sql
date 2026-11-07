CREATE TABLE "profile_fill" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_fill_single_check" CHECK ("profile_fill"."id" = 1)
);
