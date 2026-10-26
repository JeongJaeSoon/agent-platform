CREATE TABLE "workspace_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"base_profile_id" text NOT NULL,
	"base_fingerprint" text NOT NULL,
	"base_runtime_version" text NOT NULL,
	"base_billing" text NOT NULL,
	"base_repository_mode" text NOT NULL,
	"model" text NOT NULL,
	"models" jsonb NOT NULL,
	"tools" jsonb NOT NULL,
	"permission_mode" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by" uuid,
	CONSTRAINT "workspace_profiles_version_key" UNIQUE("workspace_id","name","version"),
	CONSTRAINT "workspace_profiles_id_check" CHECK ("workspace_profiles"."id" LIKE 'ws\_%'),
	CONSTRAINT "workspace_profiles_version_check" CHECK ("workspace_profiles"."version" >= 1),
	CONSTRAINT "workspace_profiles_permission_mode_check" CHECK ("workspace_profiles"."permission_mode" IN ('default','acceptEdits','dontAsk','plan','bypassPermissions','auto')),
	CONSTRAINT "workspace_profiles_base_billing_check" CHECK ("workspace_profiles"."base_billing" IN ('metered', 'none')),
	CONSTRAINT "workspace_profiles_base_repository_mode_check" CHECK ("workspace_profiles"."base_repository_mode" IN ('required', 'optional', 'none')),
	CONSTRAINT "workspace_profiles_retired_check" CHECK (("workspace_profiles"."retired_at" IS NULL) = ("workspace_profiles"."retired_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "workspace_profiles" ADD CONSTRAINT "workspace_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_profiles" ADD CONSTRAINT "workspace_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_profiles" ADD CONSTRAINT "workspace_profiles_retired_by_users_id_fk" FOREIGN KEY ("retired_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;