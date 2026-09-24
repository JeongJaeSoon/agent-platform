import {
  postSessionAnswerRequestSchema,
  sessionMessageSchema,
} from "@agent-platform/contracts";
import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  attempts,
  executions,
  queueMessages,
  sessions,
  unassignedSessions,
  workerLaunches,
} from "./schema.ts";

export type EnqueueInput = {
  sessionId: string;
  turnId?: number;
  payload: unknown;
};

function validatePayload(payload: unknown) {
  const answer = postSessionAnswerRequestSchema.safeParse(payload);
  if (answer.success) {
    return { kind: "answer", payload: answer.data } as const;
  }
  return {
    kind: "message",
    payload: sessionMessageSchema.parse(payload),
  } as const;
}

/**
 * The partition of the session's latest launch, or undefined for a session
 * that never ran. Launch history is where a session's partition lives: it
 * outlives the binding, and nothing prunes it (94S-212).
 *
 * "Latest" is the last one claimed, by the lease epoch every claim bumps.
 * Generation cannot order them: a pool launch registered through the gateway
 * carries whatever generation its backend chose. A reservation that was
 * never claimed took its partition from the signal, which came from this
 * same history, so it ranks after every claimed one.
 */
export async function lastLaunchPartition(
  tx: Database,
  sessionId: string,
): Promise<{ partition: string } | undefined> {
  const [launch] = await tx
    .select({ partition: workerLaunches.partition })
    .from(executions)
    .innerJoin(workerLaunches, eq(workerLaunches.executionId, executions.id))
    .leftJoin(attempts, eq(attempts.id, workerLaunches.claimedAttemptId))
    .where(eq(executions.sessionId, sessionId))
    .orderBy(
      sql`${attempts.leaseEpoch} DESC NULLS LAST`,
      desc(executions.generation),
    )
    .limit(1);
  return launch;
}

// Runs inside the caller's transaction so input, receipt and queue rows commit
// together (module-design: queue SQL shares the db transaction handle).
export async function enqueueWithin(
  tx: Database,
  input: EnqueueInput,
): Promise<number> {
  const validated = validatePayload(input.payload);
  const [inserted] = await tx
    .insert(queueMessages)
    .values({
      sessionId: input.sessionId,
      turnId: input.turnId,
      kind: validated.kind,
      payload: validated.payload,
    })
    .returning({ id: queueMessages.id });
  if (!inserted) {
    throw new Error("Failed to enqueue message");
  }
  const [session] = await tx
    .select({ podId: sessions.podId })
    .from(sessions)
    .where(eq(sessions.id, input.sessionId))
    .limit(1)
    .for("update");
  if (!session) {
    throw new Error("Session not found");
  }
  if (session.podId === null) {
    // A session that already ran goes back to the partition it ran in; a
    // default here would strand it when only partition-specific workers
    // serve it (an idle session after its worker exited, or after a resume
    // with nothing queued).
    const launch = await lastLaunchPartition(tx, input.sessionId);
    await tx
      .insert(unassignedSessions)
      .values({
        sessionId: input.sessionId,
        ...(launch ? { partition: launch.partition } : {}),
      })
      .onConflictDoNothing({ target: unassignedSessions.sessionId });
  }
  return inserted.id;
}
