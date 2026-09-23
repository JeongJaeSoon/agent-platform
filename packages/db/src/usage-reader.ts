import type { TurnStatus } from "@agent-platform/contracts";
import type { UsageReader } from "@agent-platform/platform";
import { and, eq, inArray, isNull, not, type SQL, sql } from "drizzle-orm";
import { INSTALLATION_STORAGE_SCOPE } from "./input-limits.ts";
import type { Database } from "./queries.ts";
import { sessions, storageUsage, turns, workerLaunches } from "./schema.ts";

const ENDED: TurnStatus[] = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "outcome_unknown",
];
const OPEN: TurnStatus[] = ["running", "needs_input"];

// Whether a turn reported a cost is read from the one field finalize writes
// only when the worker had a figure, whatever status the turn ended in, so a
// reclassified ending (94S-287 interrupted, 94S-288 context lost) keeps its
// meaning. `->>` is NULL for a missing key, a JSON null and a NULL row alike;
// a reported zero stays reported.
const costReported = sql`(${turns.resultJson} ->> 'cost_usd') IS NOT NULL`;
// The one ending known never to have run: queued input cancelled on
// terminate or close. A legacy row without timestamps that ended any other
// way still counts as unreported.
const neverRan = sql`(${turns.status} = 'cancelled' AND ${turns.startedAt} IS NULL AND ${turns.attemptId} IS NULL AND NOT ${turns.outcomeUnknown})`;

function counted(condition: SQL | undefined) {
  return sql<number>`count(${turns.id}) FILTER (WHERE ${condition})`.mapWith(
    Number,
  );
}

export function createPostgresUsageReader(db: Database): UsageReader {
  return {
    async installationUsage() {
      const [row] = await db
        .select({
          readAt: sql<Date>`now()`.mapWith((value) => new Date(value)),
          // The scheduler's capacity predicate: a reservation or a worker
          // still being removed holds its slot too.
          executionSlotsUsed: sql<number>`(${db
            .select({ count: sql`count(*)` })
            .from(workerLaunches)
            .where(isNull(workerLaunches.slotReleasedAt))})`.mapWith(Number),
          // Queued turns, not queue rows: a delivered input keeps its row
          // until it settles. No index on turns.status, so this scans turns;
          // add a partial index on status = 'queued' once that shows up in
          // this route's latency.
          queuedInputCount: sql<number>`(${db
            .select({ count: sql`count(*)` })
            .from(turns)
            .where(eq(turns.status, "queued"))})`.mapWith(Number),
          storageUsedBytes:
            sql<number>`coalesce(${storageUsage.bytes}, 0)`.mapWith(Number),
          storageUpdatedAt: storageUsage.updatedAt,
        })
        .from(sql`(SELECT 1) AS one`)
        .leftJoin(
          storageUsage,
          eq(storageUsage.scope, INSTALLATION_STORAGE_SCOPE),
        );
      if (!row) throw new Error("installation usage read returned no row");
      return row;
    },

    async sessionUsage(ownerId, sessionId) {
      const [row] = await db
        .select({
          readAt: sql<Date>`now()`.mapWith((value) => new Date(value)),
          sessionId: sessions.id,
          costUsd: sql<string>`${sessions.costUsd}::text`,
          reportedTurnCount: counted(
            and(inArray(turns.status, ENDED), costReported),
          ),
          unreportedTurnCount: counted(
            and(inArray(turns.status, ENDED), not(costReported), not(neverRan)),
          ),
          openTurnCount: counted(inArray(turns.status, OPEN)),
          queuedInputCount: counted(eq(turns.status, "queued")),
        })
        .from(sessions)
        .leftJoin(turns, eq(turns.sessionId, sessions.id))
        .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)))
        .groupBy(sessions.id);
      return row ?? null;
    },
  };
}
