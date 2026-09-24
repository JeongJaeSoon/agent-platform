import type { SessionAttention } from "@agent-platform/contracts";
import { launchRetryDelayMs } from "@agent-platform/platform";
import { eq, isNull, lte, or } from "drizzle-orm";
import { restoreBaseRevision } from "./control-shared.ts";
import { DB_NOW, fromDbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import { attempts, sessions, unassignedSessions } from "./schema.ts";
import { recordEvent, recordStatus } from "./session-events.ts";

type SessionRow = typeof sessions.$inferSelect;

/**
 * Claimed launches an active session may spend on a restore that ends before
 * its worker reports ready (94S-345), as a resume may (RESUME_LAUNCH_LIMIT).
 * One such exit says little — a deploy's SIGTERM, a read damaged in transit —
 * so the next launch waits out 94S-207's backoff (30s, then 60s) and tries
 * the same checkpoint again; a restore that keeps failing is for an operator.
 */
export const RESTORE_FAILURE_LIMIT = 3;

/** Leaves room for the worker's error while keeping it one line of a row. */
const REASON_MAX_CHARS = 500;

/** Nothing is launched for a session while its restore backoff runs. */
export function restoreRetryDue() {
  return or(
    isNull(sessions.restoreRetryAt),
    lte(sessions.restoreRetryAt, DB_NOW),
  );
}

/** A restore proven, or a checkpoint given up: the count starts over. */
export const RESTORE_FAILURES_CLEARED = {
  restoreAttemptId: null,
  restoreFailureCount: 0,
  restoreRetryAt: null,
  restoreFailureReason: null,
} as const;

/**
 * Counts the restore `attemptId` never reported ready from, in the caller's
 * gone transaction and after the session row there has cleared its binding.
 * Below the limit the session stays active and is signalled again as usual,
 * but not launched before its backoff ends. At the limit it waits in
 * recovery_required with its input kept, like a context gap: start_fresh
 * goes on without the checkpoint, close ends the session.
 */
export async function recordRestoreFailure(
  tx: Database,
  input: { session: SessionRow; attemptId: string; now: Date },
): Promise<"backing_off" | "recovery_required"> {
  const { session, now } = input;
  const [attempt] = await tx
    .select({ endReason: attempts.endReason })
    .from(attempts)
    .where(eq(attempts.id, input.attemptId))
    .limit(1);
  const reason = boundedReason(attempt?.endReason ?? "execution_gone");
  const failures = session.restoreFailureCount + 1;
  const stopped = failures >= RESTORE_FAILURE_LIMIT;
  const [updated] = await tx
    .update(sessions)
    .set({
      restoreFailureCount: failures,
      restoreFailureReason: reason,
      restoreRetryAt: stopped ? null : fromDbNow(launchRetryDelayMs(failures)),
      ...(stopped
        ? {
            status: "failed" as const,
            admissionState: "recovery_required" as const,
          }
        : {}),
      updatedAt: now,
    })
    .where(eq(sessions.id, session.id))
    .returning({ retryAt: sessions.restoreRetryAt });
  const failure = {
    type: "system",
    subtype: "checkpoint_restore_failed",
    // What the attempt was restoring: a fallback's base (94S-204) when its
    // plan fell back, the pointer otherwise.
    checkpoint_revision:
      session.checkpointRestoreAttemptId === input.attemptId
        ? restoreBaseRevision(session)
        : session.checkpointRevision,
    failures,
    limit: RESTORE_FAILURE_LIMIT,
    reason,
    retry_at: updated?.retryAt?.toISOString() ?? null,
  };
  await recordEvent(tx, {
    sessionId: session.id,
    type: "system",
    payload: failure,
    attemptId: input.attemptId,
    turnRowId: null,
    now,
  });
  if (!stopped) return "backing_off";
  await tx
    .delete(unassignedSessions)
    .where(eq(unassignedSessions.sessionId, session.id));
  await recordStatus(tx, {
    sessionId: session.id,
    phase: "failed",
    extra: { admission_state: "recovery_required", reason: "restore_failed" },
    turnRowId: null,
    now,
  });
  return "recovery_required";
}

/** RESTORE_FAILED while a restore is failing, backing off or given up on. */
export function restoreFailedAttention(
  session: Pick<
    SessionRow,
    | "admissionState"
    | "restoreFailureCount"
    | "restoreFailureReason"
    | "restoreRetryAt"
  >,
): SessionAttention | null {
  if (
    session.restoreFailureCount === 0 ||
    (session.admissionState !== "active" &&
      session.admissionState !== "recovery_required")
  ) {
    return null;
  }
  return {
    code: "RESTORE_FAILED",
    reason: session.restoreFailureReason ?? "execution_gone",
    failures: session.restoreFailureCount,
    retry_at: session.restoreRetryAt?.toISOString() ?? null,
  };
}

/** A worker's release reason as the database keeps it: one line, bounded. */
export function boundedReason(reason: string): string {
  const line = reason.split(/[\r\n]/, 1)[0]?.trim() || "execution_gone";
  return line.length <= REASON_MAX_CHARS
    ? line
    : `${line.slice(0, REASON_MAX_CHARS - 1)}…`;
}
