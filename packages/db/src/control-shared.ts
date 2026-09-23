import { and, eq, min, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  idempotencyKeys,
  receipts,
  sessions,
  turns,
  workerLaunches,
} from "./schema.ts";

const TURN_ID = /^[1-9]\d{0,9}$/;
// turns.sequence is a PostgreSQL integer.
const SEQUENCE_MAX = 2_147_483_647;

/**
 * A public turn id as a sequence, by the same canonical rule as the turn
 * reader: "1e0" or " 1" must not settle turn 1, and "abc" or an out-of-range
 * number must not reach the query as a 500.
 */
export function parseTurnSequence(turnId: string): number | null {
  if (!TURN_ID.test(turnId)) return null;
  const sequence = Number(turnId);
  return sequence <= SEQUENCE_MAX ? sequence : null;
}

export const OPEN_TURN_STATUSES = ["running", "needs_input"];

// Receipts written for the inputs a decision or a cancellation settles.
export const INPUT_RECEIPT_OPERATIONS = ["create_session", "append_message"];

export type IdempotencyScope = {
  principal: string;
  operation: string;
  resource: string;
  key: string;
};

// Same discipline as the input path: the advisory lock goes first so a
// same-key race is settled before any row lock is taken.
export async function lockIdempotencyScope(
  tx: Database,
  scope: IdempotencyScope,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${JSON.stringify([scope.principal, scope.operation, scope.resource, scope.key])}))`,
  );
}

export async function findIdempotent(tx: Database, scope: IdempotencyScope) {
  const [existing] = await tx
    .select({
      payloadHash: idempotencyKeys.payloadHash,
      receiptId: receipts.id,
      status: receipts.status,
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

/**
 * The turn a control receipt reports as unconfirmed: the earliest one whose
 * outcome is unknown, from this exit or from one the session was already
 * recovering from. Null when every turn has a known outcome.
 */
export async function earliestUnknownTurn(
  tx: Database,
  sessionId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ sequence: min(turns.sequence) })
    .from(turns)
    .where(
      and(eq(turns.sessionId, sessionId), eq(turns.status, "outcome_unknown")),
    );
  return row?.sequence === null || row?.sequence === undefined
    ? null
    : String(row.sequence);
}

export class BindingMoved extends Error {
  constructor(sessionId: string, attempt: number) {
    super(
      `Session ${sessionId} changed its execution while control attempt ${attempt} waited for the launch lock`,
    );
  }
}

/**
 * Runs `work` in a transaction, restarting it when the session's binding
 * moved under it (see lockSessionForControl). Three attempts is plenty: a
 * binding moves once per launch, and launches are seconds apart.
 */
export async function transactionWithBindingRetry<T>(
  db: Database,
  work: (tx: Database, attempt: number) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction((tx) => work(tx, attempt));
    } catch (error) {
      if (!(error instanceof BindingMoved) || attempt >= 3) throw error;
    }
  }
}

/**
 * Lock order is launch, then session, as confirmExecutionGone takes them.
 * The launch is known only from the session row, so it is read unlocked
 * first; if the binding moved while the launch lock was taken, the caller
 * starts the transaction over rather than locking the new launch out of
 * order. The session row lock serializes this against every other control
 * and against the gateway paths, which lock the session before the attempt;
 * no attempt row is locked here, so the order holds.
 */
export async function lockSessionForControl(
  tx: Database,
  input: { sessionId: string; ownerId: string; attempt: number },
) {
  const owned = and(
    eq(sessions.id, input.sessionId),
    eq(sessions.ownerId, input.ownerId),
  );
  const [peek] = await tx
    .select({ executionId: sessions.executionId })
    .from(sessions)
    .where(owned)
    .limit(1);
  if (peek?.executionId) {
    await tx
      .select({ executionId: workerLaunches.executionId })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, peek.executionId))
      .limit(1)
      .for("update");
  }
  const [session] = await tx
    .select()
    .from(sessions)
    .where(owned)
    .limit(1)
    .for("update");
  if (!session) return null;
  if (session.executionId !== (peek?.executionId ?? null)) {
    throw new BindingMoved(input.sessionId, input.attempt);
  }
  return session;
}

/**
 * Waiting for the session lock is real time; an append that held it
 * committed rows stamped after the caller read its clock, and this
 * transaction's stamps must not fall before them. Same rule as the gateway
 * paths: caller clock plus the wait, so injected clocks hold.
 */
export function controlClock(callerNow: Date, startedAt: number): Date {
  return new Date(callerNow.getTime() + Math.max(0, Date.now() - startedAt));
}
