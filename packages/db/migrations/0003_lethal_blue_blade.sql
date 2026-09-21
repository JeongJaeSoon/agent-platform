ALTER TABLE "turns" ADD COLUMN "sequence" integer;--> statement-breakpoint
UPDATE "turns" SET "sequence" = numbered.sequence
FROM (
	SELECT id, row_number() OVER (PARTITION BY session_id ORDER BY id) AS sequence
	FROM "turns"
) AS numbered
WHERE "turns".id = numbered.id;--> statement-breakpoint
ALTER TABLE "turns" ALTER COLUMN "sequence" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "turns_session_sequence_uniq" ON "turns" USING btree ("session_id","sequence");
