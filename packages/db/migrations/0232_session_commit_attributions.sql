CREATE TABLE "session_commit_attributions" (
	"session_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"author_name" text NOT NULL,
	"author_email" text NOT NULL,
	"co_author_name" text,
	"co_author_email" text,
	"agent_session" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_commit_attributions_pk" PRIMARY KEY("session_id","digest"),
	CONSTRAINT "session_commit_attributions_co_author_check" CHECK (("session_commit_attributions"."co_author_name" IS NULL) = ("session_commit_attributions"."co_author_email" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "session_commit_attributions" ADD CONSTRAINT "session_commit_attributions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;