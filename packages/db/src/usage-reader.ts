import type { TurnStatus } from "@werft-ai/contracts";
import type { UsageReader, UsageSummaryFilter } from "@werft-ai/platform";
import { and, eq, inArray, isNull, not, or, type SQL, sql } from "drizzle-orm";
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

function periodBounds(period: { since: Date; until?: Date }) {
  const since = sql`${period.since.toISOString()}::timestamptz`;
  // The API's clock passed since; the database's may be a moment behind,
  // and a period must not end before it starts.
  const until = period.until
    ? sql`${period.until.toISOString()}::timestamptz`
    : sql`greatest(now(), ${since})`;
  return { since, until };
}

// On a 90-day installation read JIT spent longer compiling than the
// aggregate took to run (packages/db/bench/usage-reads.ts), so it is off for
// that one transaction.
async function executeWithoutJit<Row>(db: Database, query: SQL) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL jit = off`);
    const { rows } = (await tx.execute(query)) as unknown as { rows: Row[] };
    return rows;
  });
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
      const { since, until } = periodBounds(period);
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

    async usageSeries(filter, period) {
      const { since, until } = periodBounds(period);
      const inPeriod = sql`${sessions.createdAt} >= ${since}
            AND ${sessions.createdAt} < ${until}
            AND ${startedBy(filter) ?? sql`TRUE`}`;
      const day = sql`(${sessions.createdAt} AT TIME ZONE 'UTC')::date`;
      // The summary's figures per UTC day of created_at. Sessions and their
      // turns are each grouped by day, never by session, so a long period is
      // two hash aggregates. Run time is summed exactly (numeric) per day and
      // floored on the running total, so the days add up to the summary's
      // one floor over the whole period.
      const query = sql`
        WITH per_day AS (
          SELECT ${day} AS day,
                 count(*) AS session_count,
                 sum(${sessions.costUsd}) AS cost_usd,
                 sum(${sessions.providerTokens}) AS provider_tokens
          FROM ${sessions}
          WHERE ${inPeriod}
          GROUP BY 1
        ),
        turn_day AS (
          SELECT ${day} AS day,
                 count(*) FILTER (WHERE ${incomplete}) AS incomplete,
                 sum(${runSeconds}) FILTER (WHERE ${ran}) AS seconds
          FROM ${sessions}
          JOIN ${turns} ON ${turns.sessionId} = ${sessions.id}
          WHERE ${inPeriod}
          GROUP BY 1
        ),
        buckets AS (
          SELECT d::date AS day,
                 coalesce(per_day.session_count, 0) AS session_count,
                 coalesce(per_day.cost_usd, 0) AS cost_usd,
                 coalesce(per_day.provider_tokens, 0) AS provider_tokens,
                 coalesce(turn_day.incomplete, 0) AS incomplete,
                 coalesce(turn_day.seconds, 0) AS seconds
          FROM generate_series(
            (${since} AT TIME ZONE 'UTC')::date,
            ((${until} AT TIME ZONE 'UTC') - interval '1 microsecond')::date,
            interval '1 day'
          ) d
          LEFT JOIN per_day ON per_day.day = d::date
          LEFT JOIN turn_day ON turn_day.day = d::date
        )
        SELECT now() AS read_at,
               ${until} AS until,
               to_char(day, 'YYYY-MM-DD') AS date,
               session_count::int AS session_count,
               cost_usd::text AS cost_usd,
               provider_tokens::bigint AS provider_tokens,
               incomplete::int AS incomplete,
               (floor(sum(seconds) OVER running)
                 - floor(sum(seconds) OVER running - seconds))::bigint AS run_seconds
        FROM buckets
        WINDOW running AS (ORDER BY day ROWS UNBOUNDED PRECEDING)
        ORDER BY day`;
      const rows = await executeWithoutJit<{
        read_at: Date | string;
        until: Date | string;
        date: string;
        session_count: number;
        cost_usd: string;
        provider_tokens: number | string;
        incomplete: number;
        run_seconds: number | string;
      }>(db, query);
      const [first] = rows;
      if (!first) throw new Error("usage series read returned no day");
      return {
        readAt: new Date(first.read_at),
        until: new Date(first.until),
        buckets: rows.map((row) => ({
          date: row.date,
          sessionCount: row.session_count,
          costUsd: row.cost_usd,
          providerTokens: Number(row.provider_tokens),
          incompleteTurnCount: row.incomplete,
          runSeconds: Number(row.run_seconds),
        })),
      };
    },
  };
}
