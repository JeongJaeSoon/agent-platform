import { and, asc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { sessions } from "./schema.ts";

const BATCH = 500;

/**
 * Writes `sessions.model` on rows from before the column, from what their
 * fingerprint pins: `modelOf` is the catalog's answer (a version 1
 * fingerprint names its model), null when the catalog cannot tell. Those
 * rows stay null. A row written meanwhile is never overwritten, so replicas
 * starting together may all run it. Returns how many rows it wrote.
 */
export async function backfillSessionModels(
  db: Database,
  modelOf: (pin: { profileId: string; fingerprint: string }) => string | null,
): Promise<number> {
  let written = 0;
  let after: string | null = null;
  for (;;) {
    const rows = await db
      .select({
        id: sessions.id,
        profileId: sessions.profileId,
        fingerprint: sessions.profileFingerprint,
      })
      .from(sessions)
      .where(
        and(
          isNull(sessions.model),
          isNotNull(sessions.profileId),
          isNotNull(sessions.profileFingerprint),
          after === null ? undefined : gt(sessions.id, after),
        ),
      )
      .orderBy(asc(sessions.id))
      .limit(BATCH);
    for (const row of rows) {
      if (row.profileId === null || row.fingerprint === null) continue;
      const model = modelOf({
        profileId: row.profileId,
        fingerprint: row.fingerprint,
      });
      if (model === null) continue;
      const updated = await db
        .update(sessions)
        .set({ model })
        .where(
          and(
            eq(sessions.id, row.id),
            isNull(sessions.model),
            eq(sessions.profileFingerprint, row.fingerprint),
          ),
        )
        .returning({ id: sessions.id });
      written += updated.length;
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < BATCH) return written;
    after = last.id;
  }
}
