CREATE TABLE "login_methods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"issuer" text,
	"subject" text,
	"email_at_link" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "login_methods_kind_check" CHECK ("login_methods"."kind" IN ('password', 'google')),
	CONSTRAINT "login_methods_external_check" CHECK (CASE WHEN "login_methods"."kind" = 'password' THEN "login_methods"."issuer" IS NULL AND "login_methods"."subject" IS NULL ELSE "login_methods"."issuer" IS NOT NULL AND "login_methods"."subject" IS NOT NULL END)
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "login_methods" ADD CONSTRAINT "login_methods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "login_methods_external_uniq" ON "login_methods" USING btree ("kind","issuer","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "login_methods_password_user_uniq" ON "login_methods" USING btree ("user_id") WHERE "login_methods"."kind" = 'password';--> statement-breakpoint
INSERT INTO "login_methods" ("id", "user_id", "kind")
SELECT gen_random_uuid(), "id", 'password' FROM "users"
WHERE "password_hash" IS NOT NULL
ON CONFLICT DO NOTHING;
