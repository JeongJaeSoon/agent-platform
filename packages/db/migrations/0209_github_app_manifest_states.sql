CREATE TABLE "github_app_manifest_states" (
	"state_hash" "bytea" PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"owner_login" text,
	"public" boolean NOT NULL,
	"replaces_app_id" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_manifest_states_role_check" CHECK ("github_app_manifest_states"."role" IN ('author', 'reviewer'))
);
--> statement-breakpoint
ALTER TABLE "github_app_manifest_states" ADD CONSTRAINT "github_app_manifest_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_app_manifest_states_expires_idx" ON "github_app_manifest_states" USING btree ("expires_at");