CREATE TABLE "installation_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"version" integer NOT NULL,
	"origin" text NOT NULL,
	"definition" jsonb NOT NULL,
	"permission_mode" text NOT NULL,
	"fingerprint" text NOT NULL,
	"repository_ids" jsonb NOT NULL,
	"previous_id" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by" uuid,
	CONSTRAINT "installation_profiles_id_check" CHECK ("installation_profiles"."id" NOT LIKE 'ws\_%'),
	CONSTRAINT "installation_profiles_origin_check" CHECK ("installation_profiles"."origin" IN ('catalog', 'console')),
	CONSTRAINT "installation_profiles_name_check" CHECK (("installation_profiles"."origin" = 'catalog') = ("installation_profiles"."name" IS NULL)),
	CONSTRAINT "installation_profiles_version_check" CHECK ("installation_profiles"."version" >= 1),
	CONSTRAINT "installation_profiles_permission_mode_check" CHECK ("installation_profiles"."permission_mode" IN ('default','acceptEdits','dontAsk','plan','bypassPermissions','auto')),
	CONSTRAINT "installation_profiles_definition_mode_check" CHECK ("installation_profiles"."permission_mode" = "installation_profiles"."definition"->>'permission_mode'),
	CONSTRAINT "installation_profiles_retired_check" CHECK (("installation_profiles"."retired_at" IS NULL) = ("installation_profiles"."retired_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD CONSTRAINT "installation_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation_profiles" ADD CONSTRAINT "installation_profiles_retired_by_users_id_fk" FOREIGN KEY ("retired_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "installation_profiles_console_version_key" ON "installation_profiles" USING btree ("name","version") WHERE "installation_profiles"."origin" = 'console';