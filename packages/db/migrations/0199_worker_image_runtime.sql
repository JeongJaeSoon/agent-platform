CREATE TABLE "worker_image_refusals" (
	"image" text NOT NULL,
	"assumed_engine" text NOT NULL,
	"assumed_sdk_version" text NOT NULL,
	"assumed_cli_version" text NOT NULL,
	"assumed_profile_scheme" integer NOT NULL,
	"claimed" jsonb NOT NULL,
	"execution_id" text NOT NULL,
	"refused_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_image_refusals_pkey" PRIMARY KEY("image","assumed_engine","assumed_sdk_version","assumed_cli_version","assumed_profile_scheme")
);
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "runtime_profile_scheme" integer;--> statement-breakpoint
ALTER TABLE "worker_launches" ADD COLUMN "runtime_engine" text;--> statement-breakpoint
ALTER TABLE "worker_launches" ADD COLUMN "runtime_sdk_version" text;--> statement-breakpoint
ALTER TABLE "worker_launches" ADD COLUMN "runtime_cli_version" text;--> statement-breakpoint
ALTER TABLE "worker_launches" ADD COLUMN "runtime_profile_scheme" integer;