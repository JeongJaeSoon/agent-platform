CREATE TABLE "push_follow_ups" (
	"push_request_id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_follow_ups" ADD CONSTRAINT "push_follow_ups_push_request_id_push_requests_id_fk" FOREIGN KEY ("push_request_id") REFERENCES "public"."push_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_follow_ups" ADD CONSTRAINT "push_follow_ups_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;