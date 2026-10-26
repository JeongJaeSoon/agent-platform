import type { TurnStatus } from "@werft-ai/contracts";
import type { UsageReader, UsageTotalsFilter } from "@werft-ai/platform";
import {
  type AnyColumn,
  and,
  eq,
  inArray,
  isNull,
  not,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { INSTALLATION_STORAGE_SCOPE } from "./input-limits.ts";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  agents,
  checkpointOutputs,
  checkpoints,
  sessionModelUsage,
  sessionPreMeteringCost,
  sessions,
  storageUsage,
  turns,
  users,
  workerLaunches,
} from "./schema.ts";
import { toolCallDays, toolCallPage } from "./tool-call-pages.ts";
import { toolCallTotals } from "./tool-calls.ts";

// An open period ends at the read, and never before it starts.
const untilOf = (period: { since: Date; until?: Date }) =>
  period.until ?? new Date(Math.max(Date.now(), period.since.getTime()));

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

function startedBy(filter: UsageTotalsFilter): SQL | undefined {
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
    case "agent":
      return and(
        eq(sessions.ownerId, filter.ownerId),
        sql`EXISTS (SELECT 1 FROM ${agentReleases} WHERE ${agentReleases.id} = ${sessions.agentReleaseId} AND ${agentReleases.agentId} = ${filter.agentId})`,
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

const pairTokenSums = sql`sum(${sessionModelUsage.inputTokens}) AS input_tokens,
  sum(${sessionModelUsage.outputTokens}) AS output_tokens,
  sum(${sessionModelUsage.cacheReadInputTokens}) AS cache_read_input_tokens,
  sum(${sessionModelUsage.cacheCreationInputTokens}) AS cache_creation_input_tokens`;

type BreakdownRow = {
  key: string | null;
  label: string | null;
  total: boolean;
  session_count: number;
  input_tokens: number | string;
  output_tokens: number | string;
  cache_read_input_tokens: number | string;
  cache_creation_input_tokens: number | string;
  cost_usd: string;
};

// Each session under its agent; the total row is the GROUPING SETS () one.
// Counts and cost come from the sessions, tokens from the rollup's copy of
// each session's agent.
function breakdownByAgent(inPeriod: SQL, pairs: SQL) {
  return sql`
    WITH counted AS (
      SELECT ${agentReleases.agentId} AS agent_id,
             grouping(${agentReleases.agentId}) = 1 AS total,
             count(*) AS session_count, sum(${sessions.costUsd}) AS cost_usd
      FROM ${sessions}
      LEFT JOIN ${agentReleases} ON ${agentReleases.id} = ${sessions.agentReleaseId}
      WHERE ${inPeriod}
      GROUP BY GROUPING SETS ((${agentReleases.agentId}), ())
    ),
    tokens AS (
      SELECT ${sessionModelUsage.agentId} AS agent_id,
             grouping(${sessionModelUsage.agentId}) = 1 AS total, ${pairTokenSums}
      FROM ${sessionModelUsage}
      WHERE ${pairs}
      GROUP BY GROUPING SETS ((${sessionModelUsage.agentId}), ())
    )
    SELECT counted.agent_id::text AS key, ${agents.name} AS label, counted.total,
           counted.session_count::int AS session_count,
           coalesce(tokens.input_tokens, 0) AS input_tokens,
           coalesce(tokens.output_tokens, 0) AS output_tokens,
           coalesce(tokens.cache_read_input_tokens, 0) AS cache_read_input_tokens,
           coalesce(tokens.cache_creation_input_tokens, 0) AS cache_creation_input_tokens,
           coalesce(counted.cost_usd, 0)::text AS cost_usd
    FROM counted
    LEFT JOIN tokens ON tokens.total = counted.total
      AND tokens.agent_id IS NOT DISTINCT FROM counted.agent_id
    LEFT JOIN ${agents} ON ${agents.id} = counted.agent_id
    ORDER BY counted.cost_usd DESC, key NULLS LAST`;
}

// Every model a session called, from the per-session rollup the period's
// `pairs` select; the cost from before proxy metering is the null row. The
// totals' count and cost are the sessions'.
function breakdownByModel(inPeriod: SQL, pairs: SQL, preMetered: SQL) {
  return sql`
    WITH picked AS (
      SELECT count(*) AS session_count, sum(${sessions.costUsd}) AS cost_usd
      FROM ${sessions}
      WHERE ${inPeriod}
    ),
    models AS (
      SELECT ${sessionModelUsage.model} AS model, count(*) AS session_count,
             ${pairTokenSums}, sum(${sessionModelUsage.costUsd}) AS cost_usd
      FROM ${sessionModelUsage}
      WHERE ${pairs}
      GROUP BY ${sessionModelUsage.model}
    ),
    pre AS (
      SELECT count(*) AS session_count, sum(${sessionPreMeteringCost.costUsd}) AS cost_usd
      FROM ${sessionPreMeteringCost}
      WHERE ${preMetered}
    ),
    grouped AS (
      SELECT model AS key, false AS total, session_count, input_tokens, output_tokens,
             cache_read_input_tokens, cache_creation_input_tokens, cost_usd
      FROM models
      UNION ALL
      SELECT NULL, false, session_count, 0, 0, 0, 0, cost_usd
      FROM pre
      WHERE session_count > 0
      UNION ALL
      SELECT NULL, true, picked.session_count,
             coalesce(sum(models.input_tokens), 0), coalesce(sum(models.output_tokens), 0),
             coalesce(sum(models.cache_read_input_tokens), 0),
             coalesce(sum(models.cache_creation_input_tokens), 0),
             coalesce(picked.cost_usd, 0)
      FROM picked
      LEFT JOIN models ON TRUE
      GROUP BY picked.session_count, picked.cost_usd
    )
    SELECT key, key AS label, total, session_count::int AS session_count,
           input_tokens, output_tokens, cache_read_input_tokens,
           cache_creation_input_tokens, cost_usd::text AS cost_usd
    FROM grouped
    ORDER BY grouped.cost_usd DESC, key NULLS LAST`;
}

// The summary's figures per agent or holding user, with the totals summed
// over the groups by window in the same statement. Run time is floored on
// the running total as the series does, so the groups add up to the
// totals' one floor. The one-row `one` keeps the totals when no session
// falls in the period.
function summaryGroups(inPeriod: SQL, until: SQL, by: "agent" | "user") {
  const grouping =
    by === "agent"
      ? {
          key: sql`${agentReleases.agentId}`,
          from: sql`${sessions} LEFT JOIN ${agentReleases} ON ${agentReleases.id} = ${sessions.agentReleaseId}`,
          name: sql`${agents.name}`,
          named: sql`LEFT JOIN ${agents} ON ${agents.id}::text = grouped.key`,
        }
      : {
          key: sql`${sessions.createdByUserId}`,
          from: sql`${sessions}`,
          name: sql`${users.displayName}`,
          named: sql`LEFT JOIN ${users} ON ${users.id}::text = grouped.key`,
        };
  return sql`
    WITH picked AS (
      SELECT ${sessions.id} AS id, ${sessions.costUsd} AS cost_usd,
             ${sessions.providerTokens} AS provider_tokens, ${grouping.key}::text AS key
      FROM ${grouping.from}
      WHERE ${inPeriod}
    ),
    per_key AS (
      SELECT key, count(*) AS session_count, sum(cost_usd) AS cost_usd,
             sum(provider_tokens) AS provider_tokens
      FROM picked
      GROUP BY key
    ),
    turn_key AS (
      SELECT picked.key,
             count(*) FILTER (WHERE ${incomplete}) AS incomplete,
             sum(${runSeconds}) FILTER (WHERE ${ran}) AS seconds
      FROM picked
      JOIN ${turns} ON ${turns.sessionId} = picked.id
      GROUP BY picked.key
    ),
    grouped AS (
      SELECT per_key.key, per_key.session_count, per_key.cost_usd, per_key.provider_tokens,
             coalesce(turn_key.incomplete, 0) AS incomplete,
             coalesce(turn_key.seconds, 0) AS seconds
      FROM per_key
      LEFT JOIN turn_key ON turn_key.key IS NOT DISTINCT FROM per_key.key
    )
    SELECT now() AS read_at, ${until} AS until,
           grouped.key, ${grouping.name} AS name,
           grouped.session_count::int AS session_count,
           grouped.cost_usd::text AS cost_usd,
           grouped.incomplete::int AS incomplete,
           (floor(sum(grouped.seconds) OVER running)
             - floor(sum(grouped.seconds) OVER running - grouped.seconds))::bigint AS run_seconds,
           coalesce(sum(grouped.session_count) OVER (), 0)::int AS total_session_count,
           coalesce(sum(grouped.cost_usd) OVER (), 0)::text AS total_cost_usd,
           coalesce(sum(grouped.provider_tokens) OVER (), 0)::bigint AS total_provider_tokens,
           coalesce(sum(grouped.incomplete) OVER (), 0)::int AS total_incomplete,
           coalesce(floor(sum(grouped.seconds) OVER ()), 0)::bigint AS total_run_seconds
    FROM (SELECT 1) AS one
    LEFT JOIN grouped ON TRUE
    ${grouping.named}
    WINDOW running AS (ORDER BY grouped.key NULLS LAST ROWS UNBOUNDED PRECEDING)
    ORDER BY grouped.cost_usd DESC, grouped.key NULLS LAST`;
}

type SummaryGroupRow = {
  read_at: Date | string;
  until: Date | string;
  key: string | null;
  name: string | null;
  // null on the lone `one` row of an empty period.
  session_count: number | null;
  cost_usd: string | null;
  incomplete: number | null;
  run_seconds: number | string | null;
  total_session_count: number;
  total_cost_usd: string;
  total_provider_tokens: number | string;
  total_incomplete: number;
  total_run_seconds: number | string;
};

function figuresOf(row: BreakdownRow) {
  return {
    sessionCount: row.session_count,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadInputTokens: Number(row.cache_read_input_tokens),
    cacheCreationInputTokens: Number(row.cache_creation_input_tokens),
    costUsd: row.cost_usd,
  };
}

// One row per output object: an object stays in the store while any
// checkpoint naming it is uncollected, and a later checkpoint names its
// parent's objects again rather than uploading them. Object keys carry the
// session prefix, so a key never spans sessions. A collected revision still
// counts until a pass has deleted its objects (objects_purged_at). Scans
// checkpoint_outputs on every read.
const outputObjects = sql`(SELECT ${checkpointOutputs.objectKey}, max(${checkpointOutputs.bytes}) AS bytes, bool_or(${checkpoints.objectsPurgedAt} IS NULL) AS kept, min(${checkpoints.committedAt}) AS first_at, max(${checkpoints.objectsPurgedAt}) AS released_at FROM ${checkpointOutputs} JOIN ${checkpoints} ON ${checkpoints.sessionId} = ${checkpointOutputs.sessionId} AND ${checkpoints.revision} = ${checkpointOutputs.revision} GROUP BY ${checkpointOutputs.objectKey}) AS output_objects`;

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
          outputsUsedBytes:
            sql<number>`(SELECT coalesce(sum(bytes) FILTER (WHERE kept), 0) FROM ${outputObjects})`.mapWith(
              Number,
            ),
          // A kept key's count moved when its first checkpoint committed; a
          // released key's when the last checkpoint naming it was purged.
          outputsUpdatedAt:
            sql<Date | null>`(SELECT greatest(max(first_at), max(released_at) FILTER (WHERE NOT kept)) FROM ${outputObjects})`.mapWith(
              (value) => new Date(value),
            ),
          // Rows collected before objects_purged_at existed are stamped by
          // the next collection pass that deletes cleanly.
          outputsComplete: sql<boolean>`NOT EXISTS (SELECT 1 FROM ${checkpoints} WHERE ${checkpoints.objectsPurgedAt} IS NULL AND NOT ${checkpoints.outputsRecorded})`,
        })
        .from(sql`(SELECT 1) AS one`)
        .leftJoin(
          storageUsage,
          eq(storageUsage.scope, INSTALLATION_STORAGE_SCOPE),
        );
      if (!row) throw new Error("installation usage read returned no row");
      return row;
    },

    async agentExists(ownerId, agentId) {
      const [row] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.workspaceId, ownerId), eq(agents.id, agentId)));
      return row !== undefined;
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

    async usageSummaryGroups(filter, period, by) {
      const { since, until } = periodBounds(period);
      const inPeriod = sql`${sessions.createdAt} >= ${since}
        AND ${sessions.createdAt} < ${until}
        AND ${startedBy(filter) ?? sql`TRUE`}`;
      const rows = await executeWithoutJit<SummaryGroupRow>(
        db,
        summaryGroups(inPeriod, until, by),
      );
      const [first] = rows;
      if (!first) throw new Error("usage summary groups read returned no row");
      return {
        readAt: new Date(first.read_at),
        until: new Date(first.until),
        sessionCount: first.total_session_count,
        costUsd: first.total_cost_usd,
        providerTokens: Number(first.total_provider_tokens),
        incompleteTurnCount: first.total_incomplete,
        runSeconds: Number(first.total_run_seconds),
        groups: rows.flatMap((row) =>
          row.session_count === null
            ? []
            : [
                {
                  id: row.key,
                  name: row.name,
                  sessionCount: row.session_count,
                  costUsd: row.cost_usd ?? "0",
                  incompleteTurnCount: row.incomplete ?? 0,
                  runSeconds: Number(row.run_seconds),
                },
              ],
        ),
      };
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
        bounds AS (
          SELECT (${since} AT TIME ZONE 'UTC')::date AS first,
                 ((${until} AT TIME ZONE 'UTC') - interval '1 microsecond')::date AS last
        ),
        days AS (
          -- date + integer: a generate_series over dates steps timestamptz
          -- in the session's time zone, and a DST jump at midnight skips a day.
          SELECT bounds.first + n AS day
          FROM bounds, generate_series(0, bounds.last - bounds.first) n
        ),
        buckets AS (
          SELECT days.day,
                 coalesce(per_day.session_count, 0) AS session_count,
                 coalesce(per_day.cost_usd, 0) AS cost_usd,
                 coalesce(per_day.provider_tokens, 0) AS provider_tokens,
                 coalesce(turn_day.incomplete, 0) AS incomplete,
                 coalesce(turn_day.seconds, 0) AS seconds
          FROM days
          LEFT JOIN per_day ON per_day.day = days.day
          LEFT JOIN turn_day ON turn_day.day = days.day
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

    async usageBreakdown(filter, period, by) {
      const { since, until } = periodBounds(period);
      const started = startedBy(filter);
      const inPeriod = sql`${sessions.createdAt} >= ${since}
        AND ${sessions.createdAt} < ${until}
        AND ${started ?? sql`TRUE`}`;
      // The installation's rollup rows are the period's alone; anyone
      // else's go through their sessions.
      const ofPeriod = (createdAt: AnyColumn, sessionId: AnyColumn) =>
        sql`${createdAt} >= ${since} AND ${createdAt} < ${until} AND ${
          started
            ? sql`${sessionId} IN (SELECT ${sessions.id} FROM ${sessions} WHERE ${inPeriod})`
            : sql`TRUE`
        }`;
      const pairs = ofPeriod(
        sessionModelUsage.sessionCreatedAt,
        sessionModelUsage.sessionId,
      );
      const rows = await executeWithoutJit<BreakdownRow>(
        db,
        by === "agent"
          ? breakdownByAgent(inPeriod, pairs)
          : breakdownByModel(
              inPeriod,
              pairs,
              ofPeriod(
                sessionPreMeteringCost.sessionCreatedAt,
                sessionPreMeteringCost.sessionId,
              ),
            ),
      );
      const total = rows.find((row) => row.total);
      if (!total) throw new Error("usage breakdown read returned no total");
      return {
        rows: rows
          .filter((row) => !row.total)
          .map((row) => ({
            key: row.key,
            label: row.label,
            ...figuresOf(row),
          })),
        totals: figuresOf(total),
      };
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

    usageToolCalls(filter, calls) {
      return toolCallPage(db, filter, {
        ...calls,
        until: untilOf(calls.period),
      });
    },

    usageToolDays(filter, tools) {
      return toolCallDays(db, filter, {
        name: tools.name,
        since: tools.period.since,
        ...(tools.period.until === undefined
          ? {}
          : { until: tools.period.until }),
        ...(tools.agentId === undefined ? {} : { agentId: tools.agentId }),
      });
    },
  };
}
