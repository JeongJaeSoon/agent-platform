import type { TurnStatus } from "@werft-ai/contracts";
import type { UsageReader, UsageSummaryFilter } from "@werft-ai/platform";
import { and, eq, inArray, isNull, not, or, type SQL, sql } from "drizzle-orm";
import { INSTALLATION_STORAGE_SCOPE } from "./input-limits.ts";
import type { Database } from "./queries.ts";
import { sessions, storageUsage, turns, workerLaunches } from "./schema.ts";
import { toolCallTotals } from "./tool-calls.ts";

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
// reclassified ending (interrupted, context lost) keeps its
// meaning. `->>` is NULL for a missing key, a JSON null and a NULL row alike;
// a reported zero stays reported.
const costReported = sql`(${turns.resultJson} ->> 'cost_usd') IS NOT NULL`;
// The one ending known never to have run: queued input cancelled on
// terminate or close. A legacy row without timestamps that ended any other
// way still counts as unreported.
const neverRan = sql`(${turns.status} = 'cancelled' AND ${turns.startedAt} IS NULL AND ${turns.attemptId} IS NULL AND NOT ${turns.outcomeUnknown})`;

// The turns that keep a session usage's `cost.complete` false.
const incomplete = or(
  and(inArray(turns.status, ENDED), not(costReported), not(neverRan)),
  inArray(turns.status, OPEN),
);
// Wall clock from start to end; an open turn runs until the read.
const runSeconds = sql`greatest(extract(epoch FROM (CASE WHEN ${inArray(turns.status, OPEN)} THEN now() ELSE ${turns.endedAt} END) - ${turns.startedAt}), 0)`;
const ran = and(
  sql`${turns.startedAt} IS NOT NULL`,
  or(
    inArray(turns.status, OPEN),
    and(inArray(turns.status, ENDED), sql`${turns.endedAt} IS NOT NULL`),
  ),
);

function startedBy(filter: UsageSummaryFilter): SQL | undefined {
  switch (filter.kind) {
    case "installation":
      return undefined;
    case "user":
      return and(
        eq(sessions.ownerId, filter.ownerId),
        eq(sessions.createdByUserId, filter.userId),
      );
    case "api_key":
      return and(
        eq(sessions.ownerId, filter.ownerId),
        eq(sessions.createdByApiKeyId, filter.apiKeyId),
      );
  }
}

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
          unmetered: sessions.unmetered,
          costUsd: sql<string>`${sessions.costUsd}::text`,
          providerTokens: sessions.providerTokens,
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

    async usageSummary(filter, period) {
      const since = sql`${period.since.toISOString()}::timestamptz`;
      // The API's clock passed since; the database's may be a moment behind,
      // and a period must not end before it starts.
      const until = period.until
        ? sql`${period.until.toISOString()}::timestamptz`
        : sql`greatest(now(), ${since})`;
      const picked = db.$with("picked").as(
        db
          .select({
            id: sessions.id,
            costUsd: sessions.costUsd,
            providerTokens: sessions.providerTokens,
          })
          .from(sessions)
          .where(
            and(
              sql`${sessions.createdAt} >= ${since}`,
              sql`${sessions.createdAt} < ${until}`,
              startedBy(filter),
            ),
          ),
      );
      const pickedTurns = inArray(
        turns.sessionId,
        db.select({ id: picked.id }).from(picked),
      );
      const [row] = await db
        .with(picked)
        .select({
          readAt: sql<Date>`now()`.mapWith((value) => new Date(value)),
          until: sql<Date>`${until}`.mapWith((value) => new Date(value)),
          sessionCount: sql<number>`count(*)`.mapWith(Number),
          costUsd: sql<string>`coalesce(sum(${picked.costUsd}), 0)::text`,
          providerTokens:
            sql<number>`coalesce(sum(${picked.providerTokens}), 0)`.mapWith(
              Number,
            ),
          incompleteTurnCount: sql<number>`(${db
            .select({ count: sql`count(*)` })
            .from(turns)
            .where(and(pickedTurns, incomplete))})`.mapWith(Number),
          runSeconds: sql<number>`(${db
            .select({
              seconds: sql`coalesce(floor(sum(${runSeconds})), 0)`,
            })
            .from(turns)
            .where(and(pickedTurns, ran))})`.mapWith(Number),
        })
        .from(picked);
      if (!row) throw new Error("usage summary read returned no row");
      return row;
    },

    // From the reconciler's projection: calls made since its last pass do
    // not count yet.
    usageTools(filter, tools, limit) {
      return toolCallTotals(db, filter, {
        since: tools.period.since,
        ...(tools.period.until === undefined
          ? {}
          : { until: tools.period.until }),
        ...(tools.agentId === undefined ? {} : { agentId: tools.agentId }),
        limit,
      });
    },
  };
}
