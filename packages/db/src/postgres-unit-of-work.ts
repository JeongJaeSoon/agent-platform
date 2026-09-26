import { randomUUID } from "node:crypto";
import {
  attemptStateSchema,
  type CheckpointBlockReason,
  type CreateSessionResponse,
  checkpointBlockReasonSchema,
  createSessionResponseSchema,
  executionObservationSchema,
  type ListSessionsQuery,
  type ListTurnsQuery,
  type PostSessionMessageResponse,
  postSessionMessageResponseSchema,
  type Receipt,
  type ReceiptSessionTarget,
  readStoredEvent,
  receiptSchema,
  type SessionStatus,
  SSE_SCHEMA_VERSION,
  sessionIdSchema,
  sseEventSchema,
  type TurnDetail,
  type TurnSummary,
  turnStatusSchema,
} from "@agent-platform/contracts";
import type { StructuredLogger } from "@agent-platform/observability";
import type {
  AcceptSessionInput,
  AcceptSessionResult,
  AppendMessageInput,
  AppendMessageResult,
  EventPage,
  ReadEventsQuery,
  SessionDetailRecord,
  SessionReader,
  SessionRecord,
  SessionUnitOfWork,
} from "@agent-platform/platform";
import {
  projectDurability,
  storedPendingReasonHoldsWork,
} from "@agent-platform/platform";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  max,
  notExists,
  sql,
} from "drizzle-orm";
import { contextGapAttention } from "./context-gap.ts";
import {
  findIdempotent,
  type IdempotencyScope,
  lockIdempotencyScope,
  parseTurnSequence,
  SEQUENCE_MAX,
} from "./control-shared.ts";
import { enqueueWithin } from "./enqueue.ts";
import {
  decodeEventCursor,
  encodeEventCursor,
  InvalidCursorError,
} from "./event-cursor.ts";
import { admitInput } from "./input-limits.ts";
import { pauseAttention } from "./pause-control.ts";
import {
  actionableOfSession,
  actionableOfTurn,
  IN_FLIGHT_STATUSES,
  isInFlight,
  publicStatus,
} from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import { startupFailedAttention } from "./restore-failures.ts";
import {
  attempts,
  checkpoints,
  events,
  executions,
  idempotencyKeys,
  receipts,
  sessions,
  turns,
} from "./schema.ts";
import { recordStatus } from "./session-events.ts";

const CREATE_SESSION = "create_session";
const APPEND_MESSAGE = "append_message";
const SESSIONS_RESOURCE = "sessions";

async function recordAcceptance(
  tx: Database,
  scope: IdempotencyScope,
  payloadHash: string,
  receipt: {
    id: string;
    targetRef: { session_id: string; turn_id: string; request_id: null };
    result: unknown;
  },
) {
  await tx.insert(receipts).values({
    id: receipt.id,
    ownerId: scope.principal,
    operation: scope.operation,
    targetRef: receipt.targetRef,
    result: receipt.result,
  });
  await tx.insert(idempotencyKeys).values({
    principal: scope.principal,
    operation: scope.operation,
    resource: scope.resource,
    key: scope.key,
    payloadHash,
    receiptId: receipt.id,
  });
}

async function insertQueuedTurn(
  tx: Database,
  input: { sessionId: string; sequence: number; message: string },
) {
  // now() is the transaction start, which can precede a competing append
  // that won the session lock first; clock_timestamp() keeps created_at
  // ordered like sequence.
  const [turn] = await tx
    .insert(turns)
    .values({
      sessionId: input.sessionId,
      sequence: input.sequence,
      message: input.message,
      status: "queued",
      createdAt: sql`clock_timestamp()`,
    })
    .returning({ id: turns.id });
  if (!turn) throw new Error("Failed to insert turn");
  await enqueueWithin(tx, {
    sessionId: input.sessionId,
    turnId: turn.id,
    payload: { message: input.message },
  });
}

export function createPostgresSessionUnitOfWork(
  db: Database,
): SessionUnitOfWork {
  return {
    acceptInputAtomic(input: AcceptSessionInput): Promise<AcceptSessionResult> {
      const scope: IdempotencyScope = {
        principal: input.principal.ownerId,
        operation: CREATE_SESSION,
        resource: SESSIONS_RESOURCE,
        key: input.idempotencyKey,
      };
      return db.transaction(async (tx) => {
        await lockIdempotencyScope(tx, scope);
        const existing = await findIdempotent(tx, scope);
        if (existing) {
          if (existing.payloadHash !== input.payloadHash) {
            return { outcome: "conflict" };
          }
          return {
            outcome: "replayed",
            response: createSessionResponseSchema.parse(existing.result),
          };
        }

        if (!input.repository) {
          return { outcome: "unsupported" };
        }
        const refused = await admitInput(tx, {
          sessionId: null,
          message: input.message,
          limits: input.limits,
        });
        if (refused) return refused;
        const sessionId = randomUUID();
        await tx.insert(sessions).values({
          id: sessionId,
          ownerId: scope.principal,
          repoUrl: input.repository.url,
          branch: input.repository.branch,
          profileId: input.profileId,
          profileFingerprint: input.profileFingerprint ?? null,
          repositoryId: input.repository.id,
        });
        await insertQueuedTurn(tx, {
          sessionId,
          sequence: 1,
          message: input.message,
        });

        const receiptId = randomUUID();
        const response: CreateSessionResponse = {
          session_id: sessionId,
          turn_id: "1",
          receipt_id: receiptId,
          receipt_status: "accepted",
          status: "queued",
        };
        await recordAcceptance(tx, scope, input.payloadHash, {
          id: receiptId,
          targetRef: { session_id: sessionId, turn_id: "1", request_id: null },
          result: response,
        });
        return { outcome: "accepted", response };
      });
    },

    appendInputAtomic(input: AppendMessageInput): Promise<AppendMessageResult> {
      // uuid columns compare case-insensitively but the idempotency resource
      // is text: normalise so "ABC…" and "abc…" share one scope (codex P2).
      const sessionId = input.sessionId.toLowerCase();
      const scope: IdempotencyScope = {
        principal: input.principal.ownerId,
        operation: APPEND_MESSAGE,
        resource: sessionId,
        key: input.idempotencyKey,
      };
      return db.transaction(async (tx) => {
        await lockIdempotencyScope(tx, scope);
        const existing = await findIdempotent(tx, scope);
        if (existing) {
          if (existing.payloadHash !== input.payloadHash) {
            return { outcome: "conflict" };
          }
          return {
            outcome: "replayed",
            response: postSessionMessageResponseSchema.parse(existing.result),
          };
        }

        // The session row lock serializes every append to one session, so
        // max(sequence)+1 below cannot be handed out twice or leave a gap.
        const [session] = await tx
          .select({
            admissionState: sessions.admissionState,
            checkpointPendingReason: sessions.checkpointPendingReason,
            status: sessions.status,
          })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, scope.principal),
            ),
          )
          .limit(1)
          .for("update");
        if (!session) {
          return { outcome: "not_found" };
        }
        if (session.admissionState !== "active") {
          return {
            outcome: "rejected",
            admissionState: session.admissionState,
          };
        }
        // A turn accepted now would run on a transcript the platform cannot
        // read back; it could never be reported as durably finished. An
        // advisory reason (the run was not quiescent) holds nothing back.
        const pendingReason = session.checkpointPendingReason;
        if (
          pendingReason !== null &&
          storedPendingReasonHoldsWork(pendingReason)
        ) {
          return { outcome: "checkpoint_unavailable", reason: pendingReason };
        }
        const refused = await admitInput(tx, {
          sessionId,
          message: input.message,
          limits: input.limits,
        });
        if (refused) return refused;
        const [last] = await tx
          .select({ sequence: max(turns.sequence) })
          .from(turns)
          .where(eq(turns.sessionId, sessionId));
        const sequence = (last?.sequence ?? 0) + 1;
        await insertQueuedTurn(tx, {
          sessionId: sessionId,
          sequence,
          message: input.message,
        });
        await tx
          .update(sessions)
          .set({
            // A session the scheduler gave up launching (94S-207) is left
            // `failed` with nothing queued; this input is what launches it
            // again, so it reads as queued from here.
            status: sql`CASE WHEN ${sessions.status} = 'failed' THEN 'queued'::session_status ELSE ${sessions.status} END`,
            updatedAt: new Date(),
          })
          .where(eq(sessions.id, sessionId));
        // The stream said failed; without this it would until the turn
        // starts, while reads already say queued (94S-294).
        if (session.status === "failed") {
          await recordStatus(tx, {
            sessionId,
            phase: "queued",
            turnRowId: null,
            now: new Date(),
          });
        }

        const receiptId = randomUUID();
        const turnId = String(sequence);
        const response: PostSessionMessageResponse = {
          turn_id: turnId,
          receipt_id: receiptId,
          receipt_status: "accepted",
        };
        await recordAcceptance(tx, scope, input.payloadHash, {
          id: receiptId,
          targetRef: {
            session_id: sessionId,
            turn_id: turnId,
            request_id: null,
          },
          result: response,
        });
        return { outcome: "accepted", response };
      });
    },
  };
}

// created_at is the database's own text rendering so microsecond precision
// survives the round trip (JS Date would truncate to milliseconds).
type Cursor = { created_at: string; id: string };
const CREATED_AT_TEXT = sql<string>`${sessions.createdAt}::text`;
// The newest event in stream order (ids are commit order within a session),
// one index probe where max(created_at) visited every event of every listed
// session (94S-396). Qualified by hand: drizzle renders a single-table
// select's columns bare, and a bare "id" here would be the event's.
const LAST_EVENT_AT = sql<Date | null>`(
  SELECT e.created_at FROM ${events} e
  WHERE e.session_id = ${sessions}.id
  ORDER BY e.id DESC LIMIT 1
)`.mapWith(events.createdAt);
// Only the exact shape PostgreSQL renders; JS Date.parse is far more lenient
// than the timestamptz cast and a forged cursor must not reach the query.
const PG_TIMESTAMPTZ_TEXT =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
    if (
      typeof parsed.created_at === "string" &&
      PG_TIMESTAMPTZ_TEXT.test(parsed.created_at) &&
      sessionIdSchema.safeParse(parsed.id).success
    ) {
      return parsed;
    }
  } catch {}
  throw new InvalidCursorError();
}

// Turns page in FIFO order; the cursor is the last sequence on the page.
type TurnCursor = { sequence: number };

function encodeTurnCursor(cursor: TurnCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeTurnCursor(value: string): TurnCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
    if (
      Number.isInteger(parsed.sequence) &&
      parsed.sequence >= 1 &&
      parsed.sequence <= SEQUENCE_MAX
    ) {
      return { sequence: parsed.sequence };
    }
  } catch {}
  throw new InvalidCursorError();
}

type SessionRow = typeof sessions.$inferSelect;
type TurnRow = typeof turns.$inferSelect;

// result_json holds the SDK result message: its `result` and `usage` when
// present, otherwise the whole document is the result.
function resultParts(resultJson: unknown): {
  result: unknown;
  usage: unknown;
} {
  if (resultJson && typeof resultJson === "object") {
    const record = resultJson as Record<string, unknown>;
    return {
      result: "result" in record ? record.result : resultJson,
      usage: record.usage ?? null,
    };
  }
  return { result: resultJson ?? null, usage: null };
}

function summarizeTurn(
  row: TurnRow,
  awaitingInput: boolean,
  checkpointRevision: number | null,
): TurnSummary {
  return {
    turn_id: String(row.sequence),
    session_id: row.sessionId,
    status: turnStatusSchema.parse(publicStatus(row.status, awaitingInput)),
    message: row.message,
    terminal_reason: row.terminalReason,
    checkpoint_revision: checkpointRevision,
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    ended_at: row.endedAt?.toISOString() ?? null,
  };
}

// Exported so a test can EXPLAIN it: the work per page must stay bounded
// by `limit` however long the session history is. The byte total is the
// serialized length, not pg_column_size: TOAST compresses a repetitive
// 60 KiB document to under 1 KiB on disk, and it is the serialized form
// that this process holds.
export function eventPageQuery(
  sessionId: string,
  after: number,
  limit: number,
  maxBytes: number,
) {
  return sql`
    SELECT id, type, payload, attempt_id, occurred_ms, turn_sequence,
           fetched
    FROM (
      SELECT c.id, c.type, c.payload, c.attempt_id, c.turn_sequence,
             c.occurred_ms,
             sum(octet_length(c.payload::text)) OVER (ORDER BY c.id)
               AS running_bytes,
             row_number() OVER (ORDER BY c.id) AS position,
             count(*) OVER () AS fetched
      FROM (
        SELECT e.id, e.type, e.payload, e.attempt_id,
               t.sequence AS turn_sequence,
               (extract(epoch FROM coalesce(e.occurred_at, e.created_at))
                 * 1000)::bigint AS occurred_ms
        FROM ${events} e
        LEFT JOIN ${turns} t ON t.id = e.turn_id
        WHERE e.session_id = ${sessionId} AND e.id > ${after}
        ORDER BY e.id
        LIMIT ${limit}
      ) c
    ) page
    WHERE position = 1 OR running_bytes <= ${maxBytes}
    ORDER BY id
  `;
}

type EventPageRow = {
  id: string;
  type: string;
  payload: unknown;
  attempt_id: string | null;
  occurred_ms: string;
  turn_sequence: number | null;
  fetched: string;
};

export function createPostgresSessionReader(
  db: Database,
  options: { logger?: StructuredLogger } = {},
): SessionReader {
  async function ownedSession(ownerId: string, sessionId: string) {
    const [row] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)))
      .limit(1);
    return row ?? null;
  }

  async function checkpointRevisions(turnIds: number[]) {
    if (turnIds.length === 0) return new Map<number, number>();
    const rows = await db
      .select({
        turnId: checkpoints.turnId,
        revision: max(checkpoints.revision),
      })
      .from(checkpoints)
      .where(inArray(checkpoints.turnId, turnIds))
      .groupBy(checkpoints.turnId);
    return new Map(
      rows.flatMap((row) =>
        row.turnId === null || row.revision === null
          ? []
          : [[row.turnId, row.revision] as const],
      ),
    );
  }

  // Reads a turn with whether it is waiting on a person, in one statement.
  const turnWithInput = () =>
    db
      .select({
        turn: turns,
        awaitingInput: sql<boolean>`exists (${actionableOfTurn(db)})`,
      })
      .from(turns);

  // A reason a newer build recorded reads as unknown after a rollback
  // rather than failing the whole detail.
  function publicPendingReason(
    sessionId: string,
    stored: string | null,
  ): CheckpointBlockReason | "unknown" | null {
    if (stored === null) return null;
    const parsed = checkpointBlockReasonSchema.safeParse(stored);
    if (parsed.success) return parsed.data;
    options.logger?.warn("Stored checkpoint pending reason is unknown", {
      session_id: sessionId,
      checkpoint_pending_reason: stored,
    });
    return "unknown";
  }

  // `?status=` filters on what the list shows, not on the stored column.
  function publicStatusIs(status: SessionStatus) {
    if (!isInFlight(status)) {
      return eq(sessions.status, status);
    }
    const waiting = actionableOfSession(db);
    return and(
      inArray(sessions.status, IN_FLIGHT_STATUSES),
      status === "needs_input" ? exists(waiting) : notExists(waiting),
    );
  }

  async function summarize(
    executor: Database,
    rows: {
      session: SessionRow;
      awaitingInput: boolean;
      lastEventAt: Date | null;
    }[],
  ): Promise<SessionRecord[]> {
    if (rows.length === 0) return [];
    const ids = rows.map(({ session }) => session.id);
    const openTurns = await executor
      .select({
        sessionId: turns.sessionId,
        sequence: turns.sequence,
        status: turns.status,
      })
      .from(turns)
      .where(
        and(
          inArray(turns.sessionId, ids),
          inArray(turns.status, ["queued", "running", "needs_input"]),
        ),
      );

    return rows.map(({ session: row, awaitingInput, lastEventAt }) => {
      const mine = openTurns.filter((turn) => turn.sessionId === row.id);
      const current = mine
        .filter((turn) => turn.status !== "queued")
        .sort((a, b) => b.sequence - a.sequence)[0];
      return {
        id: row.id,
        revision: row.revision,
        admission_state: row.admissionState,
        status: publicStatus(row.status, awaitingInput),
        profile_id: row.profileId,
        repository_id: row.repositoryId,
        current_turn_id: current ? String(current.sequence) : null,
        queued_turn_count: mine.filter((turn) => turn.status === "queued")
          .length,
        last_event_at: lastEventAt?.toISOString() ?? null,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
      };
    });
  }

  return {
    async listSessions(ownerId: string, query: ListSessionsQuery) {
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const rows = await db
        .select({
          session: sessions,
          cursorAt: CREATED_AT_TEXT,
          awaitingInput: sql<boolean>`exists (${actionableOfSession(db)})`,
          lastEventAt: LAST_EVENT_AT,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.ownerId, ownerId),
            query.status ? publicStatusIs(query.status) : undefined,
            cursor
              ? sql`(${sessions.createdAt}, ${sessions.id}) < (${cursor.created_at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(sessions.createdAt), desc(sessions.id))
        .limit(query.limit + 1)
        .catch((error: unknown) => {
          // A well-formed but out-of-range timestamp (month 13) only fails
          // at the cast: SQLSTATE 22007/22008 mean the cursor, not the DB.
          const code = (error as { cause?: { code?: unknown } })?.cause?.code;
          if (code === "22007" || code === "22008") {
            throw new InvalidCursorError();
          }
          throw error;
        });
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      return {
        items: await summarize(db, page),
        next_cursor:
          rows.length > query.limit && last
            ? encodeCursor({ created_at: last.cursorAt, id: last.session.id })
            : null,
      };
    },

    getSession(
      ownerId: string,
      sessionId: string,
    ): Promise<SessionDetailRecord | null> {
      // One snapshot for every field: read one by one, a turn starting
      // between two reads showed running beside current_turn_id null.
      // A reader built on a caller's transaction gets a savepoint here and
      // the caller's isolation instead, so that must hold a snapshot too.
      return db.transaction(
        async (tx) => {
          // The count and the status it projects come from one statement,
          // so the detail never says needs_input beside a count of zero.
          const [read] = await tx
            .select({
              session: sessions,
              pendingCount: sql<number>`(SELECT count(*)::int FROM (${actionableOfSession(tx)}) AS actionable)`,
              lastEventAt: LAST_EVENT_AT,
              isolation: sql<string>`current_setting('transaction_isolation')`,
            })
            .from(sessions)
            .where(
              and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)),
            )
            .limit(1);
          if (!read) return null;
          if (read.isolation === "read committed") {
            throw new Error("Session detail needs a snapshot transaction");
          }
          const row = read.session;
          const [summary] = await summarize(tx, [
            {
              session: row,
              awaitingInput: read.pendingCount > 0,
              lastEventAt: read.lastEventAt,
            },
          ]);
          if (!summary) return null;
          const [execution] = await tx
            .select({
              backend: executions.backend,
              state: executions.observedState,
              observed_at: executions.observedAt,
            })
            .from(executions)
            .where(eq(executions.sessionId, sessionId))
            .orderBy(desc(executions.generation))
            .limit(1);
          const [completed] = await tx
            .select({ sequence: max(turns.sequence) })
            .from(turns)
            .where(
              and(
                eq(turns.sessionId, sessionId),
                eq(turns.status, "completed"),
              ),
            );
          // The turn the *pointer's* checkpoint closed, not the newest
          // checkpoint row: the two agree only while nothing is committing.
          const [checkpoint] =
            row.checkpointRevision === null
              ? []
              : await tx
                  .select({ sequence: turns.sequence })
                  .from(checkpoints)
                  .innerJoin(turns, eq(turns.id, checkpoints.turnId))
                  .where(
                    and(
                      eq(checkpoints.sessionId, sessionId),
                      eq(checkpoints.revision, row.checkpointRevision),
                    ),
                  )
                  .limit(1);
          return {
            ...summary,
            execution: execution
              ? executionObservationSchema.parse({
                  ...execution,
                  observed_at: execution.observed_at?.toISOString() ?? null,
                })
              : null,
            checkpoint_revision: row.checkpointRevision,
            pending_request_count: read.pendingCount,
            attention:
              (await pauseAttention(tx, row)) ??
              (await contextGapAttention(tx, row)) ??
              startupFailedAttention(row),
            cost_usd: row.costUsd,
            repo_url: row.repoUrl,
            branch: row.branch,
            profile_fingerprint: row.profileFingerprint,
            durability: projectDurability({
              checkpointCommittedAt: row.checkpointCommittedAt,
              checkpointFallbackRevision: row.checkpointFallbackRevision,
              checkpointRevision: row.checkpointRevision,
              contextResetTurnId:
                row.contextResetTurnSequence === null
                  ? null
                  : String(row.contextResetTurnSequence),
              lastCheckpointedTurnId:
                checkpoint?.sequence == null
                  ? null
                  : String(checkpoint.sequence),
              lastCompletedTurnId:
                completed?.sequence == null ? null : String(completed.sequence),
              lastTranscriptPersistedAt: row.lastTranscriptPersistedAt,
              pendingReason: publicPendingReason(
                sessionId,
                row.checkpointPendingReason,
              ),
            }),
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async listTurns(ownerId: string, sessionId: string, query: ListTurnsQuery) {
      const cursor = query.cursor ? decodeTurnCursor(query.cursor) : null;
      if (!(await ownedSession(ownerId, sessionId))) return null;
      const rows = await turnWithInput()
        .where(
          and(
            eq(turns.sessionId, sessionId),
            cursor ? gt(turns.sequence, cursor.sequence) : undefined,
          ),
        )
        .orderBy(asc(turns.sequence))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      const revisions = await checkpointRevisions(
        page.map(({ turn }) => turn.id),
      );
      return {
        items: page.map(({ turn, awaitingInput }) =>
          summarizeTurn(turn, awaitingInput, revisions.get(turn.id) ?? null),
        ),
        next_cursor:
          rows.length > query.limit && last
            ? encodeTurnCursor({ sequence: last.turn.sequence })
            : null,
      };
    },

    async getTurn(
      ownerId: string,
      sessionId: string,
      turnId: string,
    ): Promise<TurnDetail | null> {
      const sequence = parseTurnSequence(turnId);
      if (sequence === null) return null;
      const session = await ownedSession(ownerId, sessionId);
      if (!session) return null;
      const [read] = await turnWithInput()
        .where(
          and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)),
        )
        .limit(1);
      if (!read) return null;
      const row = read.turn;
      const revisions = await checkpointRevisions([row.id]);
      const parts = resultParts(row.resultJson);
      const attemptRows = row.attemptId
        ? await db
            .select()
            .from(attempts)
            .where(eq(attempts.id, row.attemptId))
            .limit(1)
        : [];
      return {
        ...summarizeTurn(
          row,
          read.awaitingInput,
          revisions.get(row.id) ?? null,
        ),
        result: parts.result,
        usage: parts.usage,
        attempts: attemptRows.map((attempt) => ({
          attempt_id: attempt.id,
          state: attemptStateSchema.parse(attempt.state),
          lease_epoch: attempt.leaseEpoch,
          execution_generation: attempt.executionGeneration,
          started_at: attempt.startedAt.toISOString(),
          ended_at: attempt.endedAt?.toISOString() ?? null,
        })),
      };
    },

    async getReceipt(
      ownerId: string,
      receiptId: string,
    ): Promise<Receipt | null> {
      const [row] = await db
        .select()
        .from(receipts)
        .where(and(eq(receipts.id, receiptId), eq(receipts.ownerId, ownerId)))
        .limit(1);
      if (!row) return null;
      // Every operation this unit of work writes targets a session; the
      // resource variant of the union belongs to the interface-track routes.
      const target = (row.targetRef ?? {}) as Partial<ReceiptSessionTarget>;
      // operation/error are stored untyped; a row this reader cannot
      // represent is a bug in the writer, so let the parse throw.
      return receiptSchema.parse({
        id: row.id,
        operation: row.operation,
        target_ref: {
          session_id: target.session_id,
          turn_id: target.turn_id ?? null,
          request_id: target.request_id ?? null,
        },
        status: row.status,
        result: row.result ?? null,
        error: row.error ?? null,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
      });
    },

    async readEvents(
      ownerId: string,
      sessionId: string,
      query: ReadEventsQuery,
    ): Promise<EventPage | null> {
      const after = decodeEventCursor(query.after);
      if (!(await ownedSession(ownerId, sessionId))) return null;
      // events.id is global, so a well-formed cursor from another session
      // would silently skip this one's history and a forged future cursor
      // would stream nothing forever. A nonzero cursor must name a row of
      // this session; alpha never trims, so a miss is a bad request rather
      // than 410 CURSOR_EXPIRED.
      if (after > 0) {
        const [anchor] = await db
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.sessionId, sessionId), eq(events.id, after)))
          .limit(1);
        if (!anchor) throw new InvalidCursorError();
      }
      // Ordered by row id, which is commit order within one session: every
      // writer (the worker's appendEvents, PostgresQueue.publish) inserts
      // under the session row lock, so a lower id can never become visible
      // after a higher one and a reader that resumes from the last id it saw
      // misses nothing. A new writer must take the same lock.
      //
      // The byte bound is applied in SQL over a running sum of payload sizes
      // so that Postgres, not this process, holds whatever falls past it.
      // The candidate set is cut to `limit` rows first, because window
      // functions run before LIMIT and would otherwise size the whole
      // remaining history on every page. The first row always comes
      // through, or an oversized event could never be read at all.
      // The Database type is generic over the driver, so execute() cannot
      // name its row shape; pg hands back bigints and counts as strings and
      // raw timestamps in a driver-dependent form, hence the epoch column.
      // Rows written outside the worker protocol carry no occurred_at; the
      // insert time is the closest thing to when it happened.
      const result = (await db.execute(
        eventPageQuery(sessionId, after, query.limit, query.maxBytes),
      )) as { rows: EventPageRow[] };
      const rows = result.rows;
      const fetched = Number(rows[0]?.fetched ?? 0);
      return {
        items: rows.map((row) => {
          const stored = readStoredEvent(row.type, row.payload);
          if (!stored.readable) {
            options.logger?.warn("Stored event does not match the contract", {
              session_id: sessionId,
              event_row_id: Number(row.id),
              event_type: row.type,
            });
          }
          return sseEventSchema.parse({
            id: encodeEventCursor(Number(row.id)),
            event: stored.payload.event,
            data: {
              schema_version: SSE_SCHEMA_VERSION,
              session_id: sessionId,
              turn_id:
                row.turn_sequence === null ? null : String(row.turn_sequence),
              attempt_id: row.attempt_id,
              occurred_at: new Date(Number(row.occurred_ms)).toISOString(),
              data: stored.payload.data,
            },
          });
        }),
        // Cut by the row limit, or by the byte bound below the row limit.
        more: fetched === query.limit || rows.length < fetched,
      };
    },
  };
}
