CREATE TABLE "secret_values" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_ref" text NOT NULL,
	"purpose" text NOT NULL,
	"secret_version" integer NOT NULL,
	"key_version" integer NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"last4" text NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_values_slot_uniq" UNIQUE("workspace_id","owner_ref","purpose"),
	CONSTRAINT "secret_values_versions_check" CHECK ("secret_values"."secret_version" > 0 AND "secret_values"."key_version" > 0),
	CONSTRAINT "secret_values_last4_check" CHECK (length("secret_values"."last4") = 4)
);
--> statement-breakpoint
ALTER TABLE "secret_values" ADD CONSTRAINT "secret_values_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;