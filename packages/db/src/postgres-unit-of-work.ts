import { randomUUID } from "node:crypto";
import {
  type CreateSessionResponse,
  createSessionResponseSchema,
  executionObservationSchema,
  type ListSessionsQuery,
  sessionIdSchema,
} from "@agent-platform/contracts";
import type {
  AcceptSessionInput,
  AcceptSessionResult,
  SessionDetailRecord,
  SessionReader,
  SessionRecord,
  SessionUnitOfWork,
} from "@agent-platform/platform";
import { and, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
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
const SESSIONS_RESOURCE = "sessions";

export function createPostgresSessionUnitOfWork(
  db: Database,
): SessionUnitOfWork {
  return {
    acceptInputAtomic(input: AcceptSessionInput): Promise<AcceptSessionResult> {
      const principal = input.principal.ownerId;
      return db.transaction(async (tx) => {
        // ponytail: an advisory lock serializes same-key races; SELECT FOR
        // UPDATE cannot lock a row that does not exist yet.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${JSON.stringify([principal, CREATE_SESSION, SESSIONS_RESOURCE, input.idempotencyKey])}))`,
        );
        const [existing] = await tx
          .select({
            payloadHash: idempotencyKeys.payloadHash,
            result: receipts.result,
          })
          .from(idempotencyKeys)
          .innerJoin(receipts, eq(receipts.id, idempotencyKeys.receiptId))
          .where(
            and(
              eq(idempotencyKeys.principal, principal),
              eq(idempotencyKeys.operation, CREATE_SESSION),
              eq(idempotencyKeys.resource, SESSIONS_RESOURCE),
              eq(idempotencyKeys.key, input.idempotencyKey),
            ),
          )
          .limit(1);
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
          ownerId: principal,
          repoUrl: input.repository.url,
          branch: input.repository.branch,
          profileId: input.profileId,
          repositoryId: input.repository.id,
        });
        const [turn] = await tx
          .insert(turns)
          .values({
            sessionId,
            sequence: 1,
            message: input.message,
            status: "queued",
          })
          .returning({ id: turns.id });
        if (!turn) throw new Error("Failed to insert turn");
        await enqueueWithin(tx, {
          sessionId,
          turnId: turn.id,
          payload: { message: input.message },
        });

        const receiptId = randomUUID();
        const response: CreateSessionResponse = {
          session_id: sessionId,
          turn_id: "1",
          receipt_id: receiptId,
          receipt_status: "accepted",
          status: "queued",
        };
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: principal,
          operation: CREATE_SESSION,
          targetRef: { session_id: sessionId, turn_id: "1", request_id: null },
          result: response,
        });
        await tx.insert(idempotencyKeys).values({
          principal,
          operation: CREATE_SESSION,
          resource: SESSIONS_RESOURCE,
          key: input.idempotencyKey,
          payloadHash: input.payloadHash,
          receiptId,
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

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
    if (
      typeof parsed.created_at === "string" &&
      !Number.isNaN(Date.parse(parsed.created_at)) &&
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

type SessionRow = typeof sessions.$inferSelect;

export function createPostgresSessionReader(db: Database): SessionReader {
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
        .limit(query.limit + 1);
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
  };
}
