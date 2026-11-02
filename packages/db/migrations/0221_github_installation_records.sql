CREATE TABLE "github_installation_links" (
	"connection_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"app_id" bigint NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connected_by" uuid NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installation_links_connection_id_installation_id_pk" PRIMARY KEY("connection_id","installation_id"),
	CONSTRAINT "github_installation_links_installation_id_check" CHECK ("github_installation_links"."installation_id" > 0)
);
--> statement-breakpoint
CREATE TABLE "github_installation_snapshots" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"app_id" bigint NOT NULL,
	"installations" jsonb NOT NULL,
	"read_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installation_states" (
	"state_hash" "bytea" PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"app_id" bigint NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_installation_links" ADD CONSTRAINT "github_installation_links_connection_id_github_apps_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installation_links" ADD CONSTRAINT "github_installation_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installation_snapshots" ADD CONSTRAINT "github_installation_snapshots_connection_id_github_apps_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installation_states" ADD CONSTRAINT "github_installation_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installation_states" ADD CONSTRAINT "github_installation_states_connection_id_github_apps_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_installation_states_expires_idx" ON "github_installation_states" USING btree ("expires_at");