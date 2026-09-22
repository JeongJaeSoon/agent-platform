import { and, asc, eq, isNull, lt, notInArray } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  attempts,
  executions,
  sessions,
  workerCredentials,
  workerLaunches,
  workers,
} from "./schema.ts";

const ENDED_ATTEMPT_STATES = ["exited", "lost"];

export type ReconciledLease = {
  attemptId: string;
  dryRun: boolean;
  executionId: string;
  executionGeneration: number;
  sessionId: string;
  /**
   * `fenced`: the session still pointed at this execution, so its epoch
   * moved on and the kill was requested. `ended`: the session had already
   * moved on (a release or a confirmed exit beat this pass), so only the
   * attempt row was closed.
   */
  action: "fenced" | "ended";
};

/**
 * architecture.md § lease 만료와 실행 결과 판정, row "execution 종료 미확인":
 * an attempt whose lease ran out loses the session — its epoch is discarded
 * so nothing it still sends can commit, and its execution is asked to go —
 * but nothing else is decided here. Whether its delivered turn is
 * `outcome_unknown` or its queued input can run again is judged once, in
 * confirmExecutionGoneAtomic, after the backend has seen the resource gone;
 * the slot stays taken until then. A silent worker is not evidence that the
 * container stopped.
 */
export async function reconcileExpiredLeases(
  db: Database,
  options: { dryRun?: boolean; limit?: number; now?: Date },
): Promise<ReconciledLease[]> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;

  // Candidates are read without locks; each is re-read under the row locks
  // below, in the order every gateway path takes them (launch, session,
  // attempt, execution), so a heartbeat that lands in between wins cleanly.
  const candidates = await db
    .select({
      id: attempts.id,
      executionId: attempts.executionId,
      sessionId: attempts.sessionId,
    })
    .from(attempts)
    .where(
      and(
        notInArray(attempts.state, ENDED_ATTEMPT_STATES),
        lt(attempts.leaseExpiresAt, now),
      ),
    )
    .orderBy(asc(attempts.leaseExpiresAt), asc(attempts.id))
    .limit(limit);

  const reconciled: ReconciledLease[] = [];
  for (const candidate of candidates) {
    const outcome = await db.transaction(async (tx) => {
      await tx
        .select({ executionId: workerLaunches.executionId })
        .from(workerLaunches)
        .where(eq(workerLaunches.executionId, candidate.executionId))
        .limit(1)
        .for("update");
      const [session] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, candidate.sessionId))
        .limit(1)
        .for("update");
      const [attempt] = await tx
        .select()
        .from(attempts)
        .where(eq(attempts.id, candidate.id))
        .limit(1)
        .for("update");
      if (!session || !attempt) return null;
      const live =
        !ENDED_ATTEMPT_STATES.includes(attempt.state) &&
        attempt.leaseExpiresAt.getTime() < now.getTime();
      if (!live) return null;
      const owns =
        session.executionId === attempt.executionId &&
        session.leaseEpoch === attempt.leaseEpoch;
      const result: ReconciledLease = {
        action: owns ? "fenced" : "ended",
        attemptId: attempt.id,
        dryRun,
        executionId: attempt.executionId,
        executionGeneration: attempt.executionGeneration,
        sessionId: attempt.sessionId,
      };
      if (dryRun) return result;

      await tx
        .update(attempts)
        .set({ state: "lost", endedAt: now, endReason: "lease_expired" })
        .where(eq(attempts.id, attempt.id));
      await tx
        .update(workerCredentials)
        .set({ revokedAt: now })
        .where(
          and(
            eq(workerCredentials.attemptId, attempt.id),
            isNull(workerCredentials.revokedAt),
          ),
        );
      await tx.delete(workers).where(eq(workers.podId, attempt.executionId));
      if (owns) {
        // Same two writes a terminate makes: fence the old worker, then ask
        // for its generation to be removed. pod_id/execution_id stay so no
        // new claim can start until the removal is confirmed.
        await tx
          .update(sessions)
          .set({ leaseEpoch: session.leaseEpoch + 1, updatedAt: now })
          .where(eq(sessions.id, session.id));
        await tx
          .update(executions)
          .set({ desiredState: "terminated" })
          .where(eq(executions.id, attempt.executionId));
      }
      return result;
    });
    if (outcome) reconciled.push(outcome);
  }
  return reconciled;
}
