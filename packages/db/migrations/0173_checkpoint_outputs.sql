CREATE TABLE "checkpoint_outputs" (
	"session_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"object_key" text NOT NULL,
	"bytes" bigint NOT NULL,
	CONSTRAINT "checkpoint_outputs_session_id_revision_object_key_pk" PRIMARY KEY("session_id","revision","object_key"),
	CONSTRAINT "checkpoint_outputs_bytes_nonneg" CHECK ("checkpoint_outputs"."bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "outputs_recorded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "checkpoint_outputs" ADD CONSTRAINT "checkpoint_outputs_checkpoint_fk" FOREIGN KEY ("session_id","revision") REFERENCES "public"."checkpoints"("session_id","revision") ON DELETE no action ON UPDATE no action;