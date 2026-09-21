import { randomUUID } from "node:crypto";
import {
  type CreateSessionResponse,
  createSessionResponseSchema,
  executionObservationSchema,
  type ListSessionsQuery,
  type ListTurnsQuery,
  type PostSessionMessageResponse,
  postSessionMessageResponseSchema,
  sessionIdSchema,
  type TurnDetail,
  type TurnSummary,
  turnStatusSchema,
} from "@agent-platform/contracts";
import type {
  AcceptSessionInput,
  AcceptSessionResult,
  AppendMessageInput,
  AppendMessageResult,
  SessionDetailRecord,
  SessionReader,
  SessionRecord,
  SessionUnitOfWork,
} from "@agent-platform/platform";
import { and, asc, desc, eq, gt, inArray, isNull, max, sql } from "drizzle-orm";
import { enqueueWithin } from "./enqueue.ts";
import type { Database } from "./queries.ts";
import {
  checkpoints,
  events,
  executions,
  idempotencyKeys,
  pendingRequests,
  receipts,
  sessions,
  turns,
} from "./schema.ts";

const CREATE_SESSION = "create_session";
const APPEND_MESSAGE = "append_message";
const SESSIONS_RESOURCE = "sessions";

type IdempotencyScope = {
  principal: string;
  operation: string;
  resource: string;
  key: string;
};

// ponytail: an advisory lock serializes same-key races; SELECT FOR UPDATE
// cannot lock a row that does not exist yet. Always taken before any row
// lock so every transaction acquires locks in the same order.
async function lockIdempotencyScope(tx: Database, scope: IdempotencyScope) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${JSON.stringify([scope.principal, scope.operation, scope.resource, scope.key])}))`,
  );
}

async function findIdempotent(tx: Database, scope: IdempotencyScope) {
  const [existing] = await tx
    .select({
      payloadHash: idempotencyKeys.payloadHash,
      result: receipts.result,
    })
    .from(idempotencyKeys)
    .innerJoin(receipts, eq(receipts.id, idempotencyKeys.receiptId))
    .where(
      and(
        eq(idempotencyKeys.principal, scope.principal),
        eq(idempotencyKeys.operation, scope.operation),
        eq(idempotencyKeys.resource, scope.resource),
        eq(idempotencyKeys.key, scope.key),
      ),
    )
    .limit(1);
  return existing;
}

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
        const sessionId = randomUUID();
        await tx.insert(sessions).values({
          id: sessionId,
          ownerId: scope.principal,
          repoUrl: input.repository.url,
          branch: input.repository.branch,
          profileId: input.profileId,
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
          .select({ admissionState: sessions.admissionState })
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
          .set({ updatedAt: new Date() })
          .where(eq(sessions.id, sessionId));

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

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor");
  }
}

// Turns page in FIFO order; the cursor is the last sequence on the page.
type TurnCursor = { sequence: number };
const TURN_ID = /^[1-9]\d{0,9}$/;
// turns.sequence is a PostgreSQL integer; anything above cannot exist and
// must not reach the query, where it would fail with 22003 (codex P2).
const SEQUENCE_MAX = 2_147_483_647;

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

// Public turn_id is the 1-based sequence; anything else is not found.
function parseTurnId(turnId: string): number | null {
  if (!TURN_ID.test(turnId)) return null;
  const sequence = Number(turnId);
  return sequence <= SEQUENCE_MAX ? sequence : null;
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
  checkpointRevision: number | null,
): TurnSummary {
  return {
    turn_id: String(row.sequence),
    session_id: row.sessionId,
    status: turnStatusSchema.parse(row.status),
    message: row.message,
    terminal_reason: row.terminalReason,
    checkpoint_revision: checkpointRevision,
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    ended_at: row.endedAt?.toISOString() ?? null,
  };
}

export function createPostgresSessionReader(db: Database): SessionReader {
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

  async function summarize(rows: SessionRow[]): Promise<SessionRecord[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const openTurns = await db
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
    const lastEvents = await db
      .select({ sessionId: events.sessionId, at: max(events.createdAt) })
      .from(events)
      .where(inArray(events.sessionId, ids))
      .groupBy(events.sessionId);
    const lastEventAt = new Map(
      lastEvents.map((row) => [row.sessionId, row.at]),
    );

    return rows.map((row) => {
      const mine = openTurns.filter((turn) => turn.sessionId === row.id);
      const current = mine
        .filter((turn) => turn.status !== "queued")
        .sort((a, b) => b.sequence - a.sequence)[0];
      return {
        id: row.id,
        revision: row.revision,
        admission_state: row.admissionState,
        status: row.status,
        profile_id: row.profileId,
        repository_id: row.repositoryId ?? row.repoUrl,
        current_turn_id: current ? String(current.sequence) : null,
        queued_turn_count: mine.filter((turn) => turn.status === "queued")
          .length,
        last_event_at: lastEventAt.get(row.id)?.toISOString() ?? null,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
      };
    });
  }

  return {
    async listSessions(ownerId: string, query: ListSessionsQuery) {
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const rows = await db
        .select({ session: sessions, cursorAt: CREATED_AT_TEXT })
        .from(sessions)
        .where(
          and(
            eq(sessions.ownerId, ownerId),
            query.status ? eq(sessions.status, query.status) : undefined,
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
        items: await summarize(page.map((row) => row.session)),
        next_cursor:
          rows.length > query.limit && last
            ? encodeCursor({ created_at: last.cursorAt, id: last.session.id })
            : null,
      };
    },

    async getSession(
      ownerId: string,
      sessionId: string,
    ): Promise<SessionDetailRecord | null> {
      const [row] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)))
        .limit(1);
      if (!row) return null;
      const [summary] = await summarize([row]);
      if (!summary) return null;
      const [[execution], [pending], [completed], [checkpoint]] =
        await Promise.all([
          db
            .select({
              backend: executions.backend,
              state: executions.observedState,
              observed_at: executions.observedAt,
            })
            .from(executions)
            .where(eq(executions.sessionId, sessionId))
            .orderBy(desc(executions.generation))
            .limit(1),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(pendingRequests)
            .where(
              and(
                eq(pendingRequests.sessionId, sessionId),
                isNull(pendingRequests.resolvedAt),
              ),
            ),
          db
            .select({ sequence: max(turns.sequence) })
            .from(turns)
            .where(
              and(
                eq(turns.sessionId, sessionId),
                eq(turns.status, "completed"),
              ),
            ),
          db
            .select({ sequence: turns.sequence })
            .from(checkpoints)
            .innerJoin(turns, eq(turns.id, checkpoints.turnId))
            .where(eq(checkpoints.sessionId, sessionId))
            .orderBy(desc(checkpoints.revision))
            .limit(1),
        ]);
      return {
        ...summary,
        execution: execution
          ? executionObservationSchema.parse({
              ...execution,
              observed_at: execution.observed_at?.toISOString() ?? null,
            })
          : null,
        checkpoint_revision: row.checkpointRevision,
        pending_request_count: pending?.count ?? 0,
        attention: null,
        durability: {
          last_transcript_persisted_at: null,
          checkpoint_committed_at:
            row.checkpointCommittedAt?.toISOString() ?? null,
          checkpoint_revision: row.checkpointRevision,
          last_completed_turn_id:
            completed?.sequence == null ? null : String(completed.sequence),
          last_checkpointed_turn_id:
            checkpoint?.sequence == null ? null : String(checkpoint.sequence),
          checkpoint_pending_reason: null,
        },
      };
    },

    async listTurns(ownerId: string, sessionId: string, query: ListTurnsQuery) {
      const cursor = query.cursor ? decodeTurnCursor(query.cursor) : null;
      if (!(await ownedSession(ownerId, sessionId))) return null;
      const rows = await db
        .select()
        .from(turns)
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
      const revisions = await checkpointRevisions(page.map((row) => row.id));
      return {
        items: page.map((row) =>
          summarizeTurn(row, revisions.get(row.id) ?? null),
        ),
        next_cursor:
          rows.length > query.limit && last
            ? encodeTurnCursor({ sequence: last.sequence })
            : null,
      };
    },

    async getTurn(
      ownerId: string,
      sessionId: string,
      turnId: string,
    ): Promise<TurnDetail | null> {
      const sequence = parseTurnId(turnId);
      if (sequence === null) return null;
      const session = await ownedSession(ownerId, sessionId);
      if (!session) return null;
      const [row] = await db
        .select()
        .from(turns)
        .where(
          and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)),
        )
        .limit(1);
      if (!row) return null;
      const revisions = await checkpointRevisions([row.id]);
      const parts = resultParts(row.resultJson);
      return {
        ...summarizeTurn(row, revisions.get(row.id) ?? null),
        result: parts.result,
        usage: parts.usage,
        // Per-attempt lease_epoch/execution_generation are not persisted
        // until the attempts table lands (94S-121); synthesising them from
        // the session's current values would rewrite history after a resume.
        attempts: [],
      };
    },
  };
}
