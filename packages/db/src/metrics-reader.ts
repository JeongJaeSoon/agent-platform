import type { SessionBudget } from "@werft-ai/platform";
import { type AnyColumn, and, eq, isNull, lte, sql } from "drizzle-orm";
import { actionableOfSession } from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import { awaitingLaunch } from "./scheduler-store.ts";
import {
  pendingRequests,
  providerUsage,
  queueMessages,
  sessions,
  toolCalls,
  turns,
  unassignedSessions,
} from "./schema.ts";

// Endings a turn keeps. outcome_unknown is left out: an operator's recovery
// decision rewrites it to completed or cancelled (recovery-control.ts), and
// a counter must never lose what it counted.
export const SETTLED_TURN_STATUSES = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
] as const;
export type SettledTurnStatus = (typeof SETTLED_TURN_STATUSES)[number];

export type ToolCallOutcome = "ok" | "failed" | "denied" | "unknown";

export type PlatformMetricsSnapshot = {
  /** Stored status and admission, with what an actionable request makes of them. */
  sessions: {
    status: string;
    admission: string;
    awaitingApproval: boolean;
    awaitingAnswer: boolean;
    count: number;
  }[];
  settledTurns: {
    status: SettledTurnStatus;
    count: number;
    /** Turns with both timestamps; `le[i]` counts those within `buckets[i]`. */
    timed: number;
    seconds: number;
    le: number[];
  }[];
  outcomeUnknownTurns: number;
  /** `firstAt` is the earliest call of the name, whatever its outcome. */
  toolCalls: {
    name: string;
    outcome: ToolCallOutcome;
    count: number;
    firstAt: Date;
  }[];
  providerUsage: {
    model: string;
    pricedBy: "table" | "fallback" | "unmetered";
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    /** numeric(…, 6) summed in the database, as text so no cent is lost. */
    costUsd: string;
    firstAt: Date;
  }[];
  launchQueue: { sessions: number; oldestWaitSeconds: number };
  inputQueueOldestAgeSeconds: number;
};

export type PlatformMetricsOptions = {
  /** The scheduler's, so the launch queue is the one it drains. */
  budget: SessionBudget;
  /** Ascending upper bounds of the turn-duration histogram, in seconds. */
  buckets: readonly number[];
};

/**
 * Installation-wide figures for the platform metrics, read from the tables
 * the API reads. Totals come from rows that are never deleted, so a reader
 * restart or a second reader reports the same numbers.
 */
export async function readPlatformMetrics(
  db: Database,
  options: PlatformMetricsOptions,
): Promise<PlatformMetricsSnapshot> {
  const [
    sessionRows,
    settledTurns,
    outcomeUnknownTurns,
    toolCallRows,
    providerUsageRows,
    launchQueue,
    inputQueueOldestAgeSeconds,
  ] = await Promise.all([
    readSessions(db),
    readSettledTurns(db, options.buckets),
    readOutcomeUnknownTurns(db),
    readToolCalls(db),
    readProviderUsage(db),
    readLaunchQueue(db, options.budget),
    readInputQueueOldestAge(db),
  ]);
  return {
    sessions: sessionRows,
    settledTurns,
    outcomeUnknownTurns,
    toolCalls: toolCallRows,
    providerUsage: providerUsageRows,
    launchQueue,
    inputQueueOldestAgeSeconds,
  };
}

async function readSessions(db: Database) {
  const awaitingApproval = sql<boolean>`EXISTS (${actionableOfSession(db, "permission")})`;
  const awaitingAnswer = sql<boolean>`EXISTS (${actionableOfSession(db, "question")})`;
  return db
    .select({
      status: sessions.status,
      admission: sessions.admissionState,
      awaitingApproval: awaitingApproval.as("awaiting_approval"),
      awaitingAnswer: awaitingAnswer.as("awaiting_answer"),
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(sessions)
    .groupBy(sql`1, 2, 3, 4`);
}

async function readSettledTurns(db: Database, buckets: readonly number[]) {
  const seconds = sql`greatest(extract(epoch FROM ${turns.endedAt} - ${turns.startedAt}), 0)`;
  const timed = sql`${turns.startedAt} IS NOT NULL AND ${turns.endedAt} IS NOT NULL`;
  const le = buckets.map(
    (bound) =>
      sql`count(*) FILTER (WHERE ${timed} AND ${seconds} <= ${bound})::int`,
  );
  const { rows } = (await db.execute(sql`
    SELECT ${turns.status} AS status,
      count(*)::int AS count,
      count(*) FILTER (WHERE ${timed})::int AS timed,
      coalesce(sum(${seconds}) FILTER (WHERE ${timed}), 0)::float8 AS seconds,
      ARRAY[${le.length === 0 ? sql`NULL::int` : sql.join(le, sql`, `)}] AS le
    FROM ${turns}
    WHERE ${turns.status} IN (${sql.join(
      SETTLED_TURN_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    )})
    GROUP BY 1
  `)) as unknown as {
    rows: {
      status: SettledTurnStatus;
      count: number;
      timed: number;
      seconds: number;
      le: (number | null)[];
    }[];
  };
  return rows.map((row) => ({
    status: row.status,
    count: Number(row.count),
    timed: Number(row.timed),
    seconds: Number(row.seconds),
    le: buckets.map((_, i) => Number(row.le[i] ?? 0)),
  }));
}

async function readOutcomeUnknownTurns(db: Database) {
  const [row] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(turns)
    .where(eq(turns.status, "outcome_unknown"));
  return row?.count ?? 0;
}

// A call whose permission request a person denied. tool_use ids come from
// the provider and are unique, so the pair names one call even when the
// answer reached a later attempt than the one that asked (a parked request).
async function readToolCalls(db: Database) {
  const denied = db.$with("denied").as(
    db
      .selectDistinct({
        sessionId: pendingRequests.sessionId,
        toolUseId: pendingRequests.toolUseId,
      })
      .from(pendingRequests)
      .where(
        and(
          eq(pendingRequests.kind, "permission"),
          sql`${pendingRequests.answer} ->> 'decision' = 'deny'`,
          sql`${pendingRequests.toolUseId} IS NOT NULL`,
        ),
      ),
  );
  const outcome = sql<ToolCallOutcome>`CASE WHEN ${denied.sessionId} IS NULL THEN ${toolCalls.outcome} ELSE 'denied' END`;
  const rows = await db
    .with(denied)
    .select({
      name: toolCalls.name,
      outcome: outcome.as("outcome"),
      count: sql<number>`count(*)`.mapWith(Number),
      firstAt: sql<Date>`min(${toolCalls.createdAt})`.mapWith(
        (value) => new Date(value),
      ),
    })
    .from(toolCalls)
    .leftJoin(
      denied,
      and(
        eq(denied.sessionId, toolCalls.sessionId),
        eq(denied.toolUseId, toolCalls.toolUseId),
      ),
    )
    .groupBy(sql`1, 2`);
  // A name's first call, across its outcomes: the same instant whichever
  // outcome row it is read from.
  const firstOf = new Map<string, number>();
  for (const row of rows) {
    const at = row.firstAt.getTime();
    firstOf.set(row.name, Math.min(firstOf.get(row.name) ?? at, at));
  }
  return rows.map((row) => ({
    ...row,
    firstAt: new Date(firstOf.get(row.name) ?? row.firstAt.getTime()),
  }));
}

async function readProviderUsage(db: Database) {
  const rows = await db
    .select({
      model: providerUsage.model,
      pricedBy: providerUsage.pricedBy,
      inputTokens: sumOf(providerUsage.inputTokens),
      outputTokens: sumOf(providerUsage.outputTokens),
      cacheReadInputTokens: sumOf(providerUsage.cacheReadInputTokens),
      cacheCreationInputTokens: sumOf(providerUsage.cacheCreationInputTokens),
      costUsd: sql<string>`coalesce(sum(${providerUsage.costUsd}), 0)::text`,
      firstAt: sql<Date>`min(${providerUsage.recordedAt})`.mapWith(
        (value) => new Date(value),
      ),
    })
    .from(providerUsage)
    .groupBy(providerUsage.model, providerUsage.pricedBy);
  const firstOf = new Map<string, number>();
  for (const row of rows) {
    const at = row.firstAt.getTime();
    firstOf.set(row.model, Math.min(firstOf.get(row.model) ?? at, at));
  }
  return rows.map((row) => ({
    ...row,
    firstAt: new Date(firstOf.get(row.model) ?? row.firstAt.getTime()),
  }));
}

function sumOf(column: AnyColumn) {
  return sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
}

async function readLaunchQueue(db: Database, budget: SessionBudget) {
  const [row] = await db
    .select({
      sessions: sql<number>`count(*)`.mapWith(Number),
      oldestWaitSeconds:
        sql<number>`coalesce(extract(epoch FROM clock_timestamp() - min(${unassignedSessions.signaledAt})), 0)::float8`.mapWith(
          Number,
        ),
    })
    .from(unassignedSessions)
    .innerJoin(sessions, eq(sessions.id, unassignedSessions.sessionId))
    .where(awaitingLaunch(db, budget));
  return {
    sessions: row?.sessions ?? 0,
    oldestWaitSeconds: Math.max(row?.oldestWaitSeconds ?? 0, 0),
  };
}

// infra/datadog/conf.d/postgres.d/conf.yaml's queue.oldest_age_seconds, so a
// Kubernetes install reads the same figure from the metrics endpoint.
async function readInputQueueOldestAge(db: Database) {
  const [row] = await db
    .select({
      seconds:
        sql<number>`coalesce(extract(epoch FROM clock_timestamp() - min(${queueMessages.createdAt})), 0)::float8`.mapWith(
          Number,
        ),
    })
    .from(queueMessages)
    .where(
      and(
        isNull(queueMessages.claimedBy),
        lte(queueMessages.visibleAt, sql`clock_timestamp()`),
      ),
    );
  return Math.max(row?.seconds ?? 0, 0);
}
