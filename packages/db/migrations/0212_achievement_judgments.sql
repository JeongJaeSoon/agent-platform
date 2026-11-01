CREATE TABLE "achievement_judgments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_ids" text[] DEFAULT '{}' NOT NULL,
	"input_digest" text,
	"backend" text,
	"connection_id" text,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 6) DEFAULT 0 NOT NULL,
	"error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "achievement_judgments_trigger_check" CHECK ("achievement_judgments"."trigger" IN ('evidence','turns','idle','manual')),
	CONSTRAINT "achievement_judgments_status_check" CHECK ("achievement_judgments"."status" IN ('queued','running','succeeded','failed','deferred','skipped')),
	CONSTRAINT "achievement_judgments_backend_check" CHECK ("achievement_judgments"."backend" IS NULL OR "achievement_judgments"."backend" IN ('luna')),
	CONSTRAINT "achievement_judgments_error_code_check" CHECK ("achievement_judgments"."error_code" IS NULL OR "achievement_judgments"."error_code" IN ('judge_unavailable','outputs_unavailable')),
	CONSTRAINT "achievement_judgments_cost_check" CHECK ("achievement_judgments"."calls" >= 0 AND "achievement_judgments"."input_tokens" >= 0 AND "achievement_judgments"."cost_usd" >= 0 AND "achievement_judgments"."attempts" >= 0),
	CONSTRAINT "achievement_judgments_lease_check" CHECK (("achievement_judgments"."lease_token" IS NULL) = ("achievement_judgments"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "session_achievements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"agent_id" uuid,
	"agent_release_id" text,
	"rule_id" uuid NOT NULL,
	"rule_family_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"title" text NOT NULL,
	"link" text NOT NULL,
	"evidence_kind" text NOT NULL,
	"evidence_id" text,
	"payload" jsonb,
	"judge" text NOT NULL,
	"probability" double precision,
	"judgment_id" uuid NOT NULL,
	"review_state" text NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"superseded_at" timestamp with time zone,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_achievements_evidence_kind_check" CHECK ("session_achievements"."evidence_kind" IN ('github_pull_request','github_review','out_file','conversation')),
	CONSTRAINT "session_achievements_evidence_id_check" CHECK (("session_achievements"."evidence_id" IS NULL) = ("session_achievements"."evidence_kind" = 'conversation')),
	CONSTRAINT "session_achievements_judge_check" CHECK ("session_achievements"."judge" IN ('always','luna')),
	CONSTRAINT "session_achievements_probability_check" CHECK (("session_achievements"."probability" IS NULL) = ("session_achievements"."judge" = 'always') AND ("session_achievements"."probability" IS NULL OR "session_achievements"."probability" BETWEEN 0 AND 1)),
	CONSTRAINT "session_achievements_review_state_check" CHECK ("session_achievements"."review_state" IN ('auto','needs_review','confirmed','rejected')),
	CONSTRAINT "session_achievements_auto_check" CHECK ("session_achievements"."review_state" <> 'auto' OR "session_achievements"."evidence_kind" IN ('github_pull_request', 'github_review')),
	CONSTRAINT "session_achievements_reviewed_check" CHECK (("session_achievements"."reviewed_by" IS NULL) = ("session_achievements"."reviewed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "achievement_judgments" ADD CONSTRAINT "achievement_judgments_session_fk" FOREIGN KEY ("session_id","owner_id","workspace_id") REFERENCES "public"."sessions"("id","owner_id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_achievements" ADD CONSTRAINT "session_achievements_rule_id_achievement_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."achievement_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_achievements" ADD CONSTRAINT "session_achievements_type_id_achievement_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."achievement_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_achievements" ADD CONSTRAINT "session_achievements_judgment_id_achievement_judgments_id_fk" FOREIGN KEY ("judgment_id") REFERENCES "public"."achievement_judgments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_achievements" ADD CONSTRAINT "session_achievements_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_achievements" ADD CONSTRAINT "session_achievements_session_fk" FOREIGN KEY ("session_id","owner_id","workspace_id") REFERENCES "public"."sessions"("id","owner_id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "achievement_judgments_queued_uniq" ON "achievement_judgments" USING btree ("session_id") WHERE "achievement_judgments"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "achievement_judgments_due_idx" ON "achievement_judgments" USING btree ("next_attempt_at") WHERE "achievement_judgments"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "achievement_judgments_session_idx" ON "achievement_judgments" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_achievements_evidence_uniq" ON "session_achievements" USING btree ("rule_family_id","session_id","evidence_id") WHERE "session_achievements"."evidence_id" IS NOT NULL AND "session_achievements"."superseded_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "session_achievements_conversation_uniq" ON "session_achievements" USING btree ("rule_family_id","session_id") WHERE "session_achievements"."evidence_id" IS NULL AND "session_achievements"."superseded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "session_achievements_session_idx" ON "session_achievements" USING btree ("session_id");