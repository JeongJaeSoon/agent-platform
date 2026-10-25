import type { TurnStatus } from "@werft-ai/contracts";
import type {
  UsageReader,
  UsageSummaryFilter,
  UsageToolsFilter,
} from "@werft-ai/platform";
import { and, eq, inArray, isNull, not, or, type SQL, sql } from "drizzle-orm";
import { rowsOf } from "./control-unit-of-work.ts";
import { INSTALLATION_STORAGE_SCOPE } from "./input-limits.ts";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  sessions,
  storageUsage,
  turns,
  workerLaunches,
} from "./schema.ts";

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

/**
 * Every tool call whose tool_use event was created in the period, paired
 * with its result the way the run tree pairs them (94S-923): by
 * (session_id, attempt_id, tool_use_id), a null attempt pairing with null,
 * the earlier event by (occurred_at, id) winning a duplicate. Columns:
 * event_id, session_id, name, occurred_at, outcome, ms.
 */
function toolCalls(filter: UsageSummaryFilter, tools: UsageToolsFilter): SQL {
  const since = sql`${tools.period.since.toISOString()}::timestamptz`;
  const until = tools.period.until
    ? sql`${tools.period.until.toISOString()}::timestamptz`
    : sql`greatest(now(), ${since})`;
  const sessionScope = and(
    startedBy(filter),
    tools.agentId === undefined
      ? undefined
      : sql`${sessions.agentReleaseId} IN (SELECT ${agentReleases.id} FROM ${agentReleases} WHERE ${agentReleases.agentId} = ${tools.agentId})`,
  );
  const inScope = sessionScope
    ? sql`AND events.session_id IN (SELECT ${sessions.id} FROM ${sessions} WHERE ${sessionScope})`
    : sql``;
  // tool_result data is whatever block the engine sent: only a string
  // tool_use_id pairs, and an is_error that is there but not a boolean leaves
  // the outcome unknown rather than counted as either.
  return sql`
    uses AS (
      SELECT DISTINCT ON (events.session_id, coalesce(events.attempt_id, ''), coalesce(block->>'id', events.id::text || ':' || ord))
        events.id AS event_id, events.session_id, events.attempt_id,
        events.occurred_at, block->>'name' AS name,
        CASE WHEN jsonb_typeof(block->'id') = 'string' THEN block->>'id' END AS tool_use_id
      FROM events
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(events.payload->'message'->'content') = 'array'
          THEN events.payload->'message'->'content' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS blocks(block, ord)
      WHERE events.type = 'tool_use'
        AND events.created_at >= ${since} AND events.created_at < ${until}
        AND block->>'type' = 'tool_use' AND jsonb_typeof(block->'name') = 'string'
        ${inScope}
      ORDER BY events.session_id, coalesce(events.attempt_id, ''), coalesce(block->>'id', events.id::text || ':' || ord), events.occurred_at NULLS LAST, events.id
    ),
    results AS (
      SELECT DISTINCT ON (events.session_id, coalesce(events.attempt_id, ''), events.payload->>'tool_use_id')
        events.session_id, coalesce(events.attempt_id, '') AS attempt_key,
        events.payload->>'tool_use_id' AS tool_use_id, events.occurred_at,
        CASE
          WHEN NOT events.payload ? 'is_error' THEN 'ok'
          WHEN jsonb_typeof(events.payload->'is_error') <> 'boolean' THEN 'unknown'
          WHEN (events.payload->'is_error')::boolean THEN 'failed'
          ELSE 'ok'
        END AS outcome
      FROM events
      WHERE events.type = 'tool_result'
        AND events.created_at >= ${since}
        AND jsonb_typeof(events.payload) = 'object'
        AND jsonb_typeof(events.payload->'tool_use_id') = 'string'
        ${inScope}
      ORDER BY events.session_id, coalesce(events.attempt_id, ''), events.payload->>'tool_use_id', events.occurred_at NULLS LAST, events.id
    ),
    calls AS (
      SELECT uses.event_id, uses.session_id, uses.name, uses.occurred_at,
        coalesce(results.outcome, 'unknown') AS outcome,
        -- A result stamped before its call (clock skew) times as 0.
        CASE WHEN uses.occurred_at IS NOT NULL AND results.occurred_at IS NOT NULL
          THEN greatest(round(extract(epoch FROM results.occurred_at - uses.occurred_at) * 1000), 0)::bigint
        END AS ms
      FROM uses
      LEFT JOIN results
        ON results.session_id = uses.session_id
        AND results.attempt_key = coalesce(uses.attempt_id, '')
        AND results.tool_use_id = uses.tool_use_id
    )`;
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

    async usageTools(filter, tools, limit) {
      const result = await db.execute(sql`
        WITH ${toolCalls(filter, tools)}
        SELECT name,
          count(*) AS calls,
          count(*) FILTER (WHERE outcome = 'failed') AS failed,
          coalesce(sum(ms), 0) AS total_ms,
          coalesce(round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)), 0) AS median_ms,
          coalesce(max(ms), 0) AS max_ms
        FROM calls
        GROUP BY name
        ORDER BY count(*) DESC, name
        LIMIT ${limit}`);
      return rowsOf<{
        name: string;
        calls: string;
        failed: string;
        total_ms: string;
        median_ms: string;
        max_ms: string;
      }>(result).map((row) => ({
        name: row.name,
        calls: Number(row.calls),
        failed: Number(row.failed),
        totalMs: Number(row.total_ms),
        medianMs: Number(row.median_ms),
        maxMs: Number(row.max_ms),
      }));
    },
  };
}
