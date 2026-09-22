import { randomUUID } from "node:crypto";
import type {
  ControlAcceptedResponse,
  TerminateReceiptResult,
} from "@agent-platform/contracts";
import type {
  SessionControl,
  TerminateSessionInput,
  TerminateSessionResult,
} from "@agent-platform/platform";
import { and, eq, inArray, isNull, lte, min, sql } from "drizzle-orm";
import { fromDbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  executions,
  idempotencyKeys,
  pendingRequests,
  queueMessages,
  receipts,
  sessions,
  turns,
  workerLaunches,
} from "./schema.ts";

const TERMINATE = "terminate";
const INPUT_RECEIPT_OPERATIONS = ["create_session", "append_message"];

type IdempotencyScope = {
  principal: string;
  operation: string;
  resource: string;
  key: string;
};

// Same discipline as the input path: the advisory lock goes first so a
// same-key race is settled before any row lock is taken.
async function lockIdempotencyScope(tx: Database, scope: IdempotencyScope) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${JSON.stringify([scope.principal, scope.operation, scope.resource, scope.key])}))`,
  );
}

async function findIdempotent(tx: Database, scope: IdempotencyScope) {
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
 * The receipt a terminate settles with once its execution is gone; the same
 * shape is written by confirmExecutionGoneAtomic, so a reader sees one
 * result whether the kill was immediate or observed later.
 */
/**
 * The turn a terminate receipt reports as unconfirmed: the earliest one
 * whose outcome is unknown, from this exit or from one the session was
 * already recovering from. Null when every turn has a known outcome.
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

export function terminateReceiptResult(input: {
  checkpointRevision: number | null;
  unconfirmedTurnId: string | null;
}): TerminateReceiptResult {
  return {
    execution_gone: true,
    checkpoint_revision: input.checkpointRevision,
    unconfirmed_turn_id: input.unconfirmedTurnId,
    external_effects_reverted: false,
  };
}

/**
 * api.md: a kill not observed within the deadline is reported unknown, not
 * left pending. The intent stays on the executions row, so reconciliation
 * continues and confirmExecutionGoneAtomic still settles the receipt later.
 * Both the scheduler pass and the DB-only reconciler run this, so a Docker
 * outage that stalls the former does not stall the answer.
 */
export async function expireOverdueTerminations(
  db: Database,
  input: { now: Date; deadlineMs: number; dryRun?: boolean },
): Promise<number> {
  const overdueWhere = and(
    eq(receipts.operation, TERMINATE),
    eq(receipts.status, "accepted"),
    // The receipt was stamped by the database clock, so the deadline is
    // measured on it too; `now` only stamps the update.
    lte(receipts.createdAt, fromDbNow(-input.deadlineMs)),
  );
  if (input.dryRun) {
    const rows = await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(overdueWhere);
    return rows.length;
  }
  const overdue = await db
    .update(receipts)
    .set({
      status: "unknown",
      error: {
        code: "BACKEND_UNAVAILABLE",
        message: `execution termination not observed within ${Math.round(input.deadlineMs / 1000)}s; reconciliation continues`,
      },
      updatedAt: input.now,
    })
    .where(
      and(
        eq(receipts.operation, TERMINATE),
        eq(receipts.status, "accepted"),
        lte(receipts.createdAt, fromDbNow(-input.deadlineMs)),
      ),
    )
    .returning({ id: receipts.id });
  return overdue.length;
}

export function createPostgresSessionControl(db: Database): SessionControl {
  return {
    async terminateAtomic(
      input: TerminateSessionInput,
    ): Promise<TerminateSessionResult> {
      const sessionId = input.sessionId.toLowerCase();
      const scope: IdempotencyScope = {
        principal: input.principal.ownerId,
        operation: TERMINATE,
        resource: sessionId,
        key: input.idempotencyKey,
      };
      const startedAt = Date.now();
      // Lock order is launch, then session, as confirmExecutionGone takes
      // them. The launch is known only from the session row, so it is read
      // unlocked first; if the binding moved while the launch lock was
      // taken, the transaction is started over rather than locking the new
      // launch out of order.
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await db.transaction((tx) => terminateIn(tx, attempt));
        } catch (error) {
          if (!(error instanceof BindingMoved) || attempt >= 3) throw error;
        }
      }

      async function terminateIn(
        tx: Database,
        attempt: number,
      ): Promise<TerminateSessionResult> {
        await lockIdempotencyScope(tx, scope);
        const existing = await findIdempotent(tx, scope);
        if (existing) {
          if (existing.payloadHash !== input.payloadHash) {
            return { outcome: "conflict" };
          }
          // Same receipt identity as the first answer; the status is the
          // receipt's current one, since the row is the only record of it.
          return {
            outcome: "replayed",
            response: {
              receipt_id: existing.receiptId,
              receipt_status: existing.status,
            },
          };
        }

        const [peek] = await tx
          .select({ executionId: sessions.executionId })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, scope.principal),
            ),
          )
          .limit(1);
        if (peek?.executionId) {
          await tx
            .select({ executionId: workerLaunches.executionId })
            .from(workerLaunches)
            .where(eq(workerLaunches.executionId, peek.executionId))
            .limit(1)
            .for("update");
        }
        // The session row lock serializes this against every other control
        // and against the gateway paths, which lock the session before the
        // attempt; no attempt row is locked here, so the order holds.
        const [session] = await tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, scope.principal),
            ),
          )
          .limit(1)
          .for("update");
        if (!session) return { outcome: "not_found" };
        if (session.executionId !== (peek?.executionId ?? null)) {
          throw new BindingMoved(sessionId, attempt);
        }
        // Waiting for the session lock is real time; an append that held it
        // committed rows stamped after the caller read its clock, and this
        // transaction's stamps must not fall before them. Same rule as the
        // gateway paths: caller clock plus the wait, so injected clocks hold.
        const now = new Date(
          input.now.getTime() + Math.max(0, Date.now() - startedAt),
        );
        if (session.admissionState === "closed") {
          return { outcome: "rejected", admissionState: "closed" };
        }
        if (session.revision !== input.expectedRevision) {
          return {
            outcome: "revision_conflict",
            currentRevision: session.revision,
          };
        }
        // A session on the legacy pod lifecycle (pod_id without an
        // execution) has no kill outbox and no epoch its worker honours.
        // Accepting would promise a kill nothing can deliver, so it is
        // refused with the row untouched.
        if (session.executionId === null && session.podId !== null) {
          return { outcome: "unsupported" };
        }

        // Queued input will never run: its turns end as cancelled, its queue
        // rows go, and whoever submitted it learns so through the receipt.
        const cancelled = await tx
          .update(turns)
          .set({
            status: "cancelled",
            endedAt: now,
            terminalReason: "terminated",
          })
          .where(
            and(eq(turns.sessionId, sessionId), eq(turns.status, "queued")),
          )
          .returning({ id: turns.id, sequence: turns.sequence });
        if (cancelled.length > 0) {
          await tx.delete(queueMessages).where(
            inArray(
              queueMessages.turnId,
              cancelled.map((turn) => turn.id),
            ),
          );
          await tx
            .update(receipts)
            .set({
              status: "failed",
              error: {
                code: "SESSION_STOPPED",
                message: "input cancelled by terminate before it ran",
              },
              // `result` keeps the acceptance response on purpose: a retry
              // of the original request with its idempotency key replays
              // from it (findIdempotent); the receipt read reports the failure.
              updatedAt: now,
            })
            .where(
              and(
                inArray(receipts.operation, INPUT_RECEIPT_OPERATIONS),
                eq(receipts.status, "accepted"),
                sql`${receipts.targetRef}->>'session_id' = ${sessionId}`,
                inArray(
                  sql`${receipts.targetRef}->>'turn_id'`,
                  cancelled.map((turn) => String(turn.sequence)),
                ),
              ),
            );
        }
        // A question nobody can answer any more: the worker that asked is
        // being fenced out, so an answer would land on nothing.
        await tx
          .update(pendingRequests)
          .set({ resolvedAt: now })
          .where(
            and(
              eq(pendingRequests.sessionId, sessionId),
              isNull(pendingRequests.resolvedAt),
            ),
          );
        // The kill outbox. An executions row is one generation, so asking
        // for this row is asking for exactly the generation the session is
        // bound to. The scheduler carries it out and confirmExecutionGone
        // settles the session and this receipt once the resource is absent.
        const outbox =
          session.executionId === null
            ? []
            : await tx
                .update(executions)
                .set({ desiredState: "terminated" })
                .where(eq(executions.id, session.executionId))
                .returning({ id: executions.id });
        const pendingKill = session.executionId !== null;
        if (session.executionId !== null) {
          // 94S-220: a launch the scheduler meant to rebuild would otherwise
          // be rebuilt after the kill, and confirmExecutionGone would refuse
          // the exit as "the rebuild in progress". The intent is cancelled
          // under the launch row lock taken above; replacement_count is the
          // scheduler's CAS and stays as it is.
          await tx
            .update(workerLaunches)
            .set({ replacementReason: null })
            .where(eq(workerLaunches.executionId, session.executionId));
        }
        if (pendingKill && outbox.length !== 1) {
          // A bound session without its executions row is a broken
          // invariant, not evidence that nothing is running.
          throw new Error(
            `Session ${sessionId} points at execution ${session.executionId} which has no row`,
          );
        }
        // The epoch moves on in the same transaction: from here every
        // request the old worker makes is 409 STALE_EPOCH, whether or not
        // its container is still up. A session already waiting on an
        // operator keeps `recovery_required`: the kill does not answer what
        // its unknown turn did, so it must not clear that barrier.
        const keepsRecovery = session.admissionState === "recovery_required";
        await tx
          .update(sessions)
          .set({
            revision: sql`${sessions.revision} + 1`,
            leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
            updatedAt: now,
            ...(keepsRecovery
              ? {}
              : pendingKill
                ? { admissionState: "stopping" as const }
                : {
                    admissionState: "stopped" as const,
                    status: "stopped" as const,
                  }),
          })
          .where(eq(sessions.id, sessionId));

        const receiptId = randomUUID();
        const response: ControlAcceptedResponse = {
          receipt_id: receiptId,
          receipt_status: pendingKill ? "accepted" : "succeeded",
        };
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: scope.principal,
          operation: TERMINATE,
          targetRef: { session_id: sessionId, turn_id: null, request_id: null },
          status: response.receipt_status,
          // Nothing to kill: the command is complete as soon as it is durable.
          result: pendingKill
            ? null
            : terminateReceiptResult({
                checkpointRevision: session.checkpointRevision,
                unconfirmedTurnId: await earliestUnknownTurn(tx, sessionId),
              }),
          // The deadline counts from durable acceptance, not from when the
          // caller read its clock: lock waits inside this transaction must
          // not eat into the kill's observation window.
          createdAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        });
        await tx.insert(idempotencyKeys).values({
          principal: scope.principal,
          operation: scope.operation,
          resource: scope.resource,
          key: scope.key,
          payloadHash: input.payloadHash,
          receiptId,
        });
        return { outcome: "accepted", response };
      }
    },
  };
}

class BindingMoved extends Error {
  constructor(sessionId: string, attempt: number) {
    super(
      `Session ${sessionId} changed its execution while terminate attempt ${attempt} waited for the launch lock`,
    );
  }
}
