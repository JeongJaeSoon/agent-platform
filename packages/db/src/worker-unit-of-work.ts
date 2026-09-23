import {
  type CheckpointBlockReason,
  type CheckpointRef,
  checkpointBlockReasonSchema,
  type TerminalTurnStatus,
  terminalTurnStatusSchema,
  type WorkerEvent,
} from "@agent-platform/contracts";
import {
  type CheckpointPointer,
  type CheckpointStateInput,
  type CheckpointStateResult,
  type ClaimInput,
  type ClaimResult,
  type CommitEventsInput,
  type CommitEventsResult,
  type ConfirmExecutionGoneInput,
  type ConfirmExecutionGoneResult,
  checkpointReasonHoldsWork,
  type FenceRejection,
  type FinalizeInput,
  type FinalizeResult,
  type HeartbeatInput,
  type HeartbeatResult,
  launchNonceFingerprint,
  type NextInputInput,
  type NextInputResult,
  nextPendingReason,
  type PeekFinalizeResult,
  payloadHash,
  type RegisterLaunchInput,
  type ReleaseInput,
  type ReleaseResult,
  type ResolvedCredential,
  type RestoreBaseInput,
  type RestoreBaseResult,
  type WorkerBinding,
  type WorkerFence,
  type WorkerUnitOfWork,
} from "@agent-platform/platform";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  max,
  notInArray,
  sql,
} from "drizzle-orm";
import { OPEN_TURN_STATUSES } from "./control-shared.ts";
import {
  earliestUnknownTurn,
  terminateReceiptResult,
} from "./control-unit-of-work.ts";
import { DB_NOW, dbNow, fromDbNow } from "./db-clock.ts";
import { encodeEventCursor } from "./event-cursor.ts";
import {
  openPauseReceipt,
  pauseBlocker,
  pauseReceiptResult,
} from "./pause-control.ts";
import { abandonUndeliveredAnswers } from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import { recordAudit } from "./recovery-control.ts";
import {
  attempts,
  checkpoints,
  events,
  executions,
  pendingRequests,
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
  workerCredentials,
  workerLaunches,
  workers,
} from "./schema.ts";
import { settleTurnInterrupts } from "./turn-interrupts.ts";

const ENDED_ATTEMPT_STATES = ["exited", "lost"];

// Heartbeats travel over a network and can land out of order. The durable
// state is the furthest phase the attempt has been reported to reach, so a
// late "starting" cannot walk a running attempt backwards for readers.
const ATTEMPT_PHASE_ORDER: Record<string, number> = {
  starting: 0,
  running: 1,
  draining: 2,
};
export { OPEN_TURN_STATUSES };
const INPUT_RECEIPT_OPERATIONS = ["create_session", "append_message"];
const TURN_ID = /^[1-9]\d{0,9}$/;
// turns.sequence is a PostgreSQL integer; a larger id cannot exist and must
// not reach the query, where it would fail with 22003 instead of not-found.
const SEQUENCE_MAX = 2_147_483_647;

// finalize never reports `cancelled`: that terminal comes from an operator
// recovery decision, not from the worker.
const workerTerminalSchema = terminalTurnStatusSchema.exclude(["cancelled"]);

// DESIGN.md §6.5/§6.6: success, failure and user interrupt each get their own
// session state, and an unknown outcome never takes the idle path.
const SESSION_STATUS_BY_TERMINAL: Record<
  TerminalTurnStatus,
  "idle" | "failed" | "stopped"
> = {
  completed: "idle",
  failed: "failed",
  interrupted: "stopped",
  cancelled: "stopped",
  outcome_unknown: "failed",
};
const RECEIPT_STATUS_BY_TERMINAL: Record<
  TerminalTurnStatus,
  "succeeded" | "failed" | "unknown"
> = {
  completed: "succeeded",
  failed: "failed",
  interrupted: "failed",
  cancelled: "failed",
  outcome_unknown: "unknown",
};

type SessionRow = typeof sessions.$inferSelect;
type AttemptRow = typeof attempts.$inferSelect;

// Every fenced write repeats these predicates so a row the lock did not
// cover (or a concurrent epoch bump) can never be written by a stale
// attempt, independently of the application-level check.
function fencedSession(fence: WorkerFence) {
  return and(
    eq(sessions.id, fence.sessionId),
    eq(sessions.leaseEpoch, fence.leaseEpoch),
    eq(sessions.executionGeneration, fence.executionGeneration),
    eq(sessions.authRevision, fence.authRevision),
  );
}

function ownedAttempt(fence: WorkerFence) {
  return and(
    eq(attempts.id, fence.attemptId),
    eq(attempts.sessionId, fence.sessionId),
    eq(attempts.leaseEpoch, fence.leaseEpoch),
    eq(attempts.executionGeneration, fence.executionGeneration),
    eq(attempts.authRevision, fence.authRevision),
    notInArray(attempts.state, ENDED_ATTEMPT_STATES),
  );
}

// `at` is the database time the lease was last judged held at. Re-reading
// the clock inside the write would let the lease end between the check and
// the write, turning an ordinary expiry into a zero-row internal error.
function fencedAttempt(fence: WorkerFence, at: Date) {
  return and(ownedAttempt(fence), gt(attempts.leaseExpiresAt, at));
}

function expectFenced(rows: unknown[], what: string) {
  if (rows.length !== 1) {
    throw new Error(`Fenced ${what} write affected ${rows.length} rows`);
  }
}

type Fenced =
  // `at` is the database clock once the row lock was granted.
  | { outcome: "ok"; session: SessionRow; attempt: AttemptRow; at: Date }
  | FenceRejection;

// The fence is taken once, but the checks that follow it are several round
// trips and any of them can block on a lock. The lease is therefore judged
// again just before the first write, so nothing commits — and no work is
// handed out — under a lease that ended mid-transaction.
export function leaseHeld(attempt: AttemptRow, at: Date): boolean {
  return attempt.leaseExpiresAt.getTime() > at.getTime();
}

// Locks the session and attempt rows and classifies why the fence does not
// hold: an expired lease on the current epoch is LEASE_EXPIRED, anything
// else (bumped epoch, ended attempt, unknown binding) is STALE_EPOCH.
// The system event a restore that fell back to an earlier revision leaves.
export const CHECKPOINT_RESTORE_FALLBACK = "checkpoint_restore_fallback";

export async function acquireFence(
  tx: Database,
  fence: WorkerFence,
): Promise<Fenced> {
  const [row] = await tx
    .select({ session: sessions, attempt: attempts })
    .from(sessions)
    .innerJoin(attempts, eq(attempts.sessionId, sessions.id))
    .where(
      and(eq(sessions.id, fence.sessionId), eq(attempts.id, fence.attemptId)),
    )
    .limit(1)
    .for("update");
  if (!row) return { outcome: "stale_epoch" };
  const at = await dbNow(tx);
  const { session, attempt } = row;
  const epochMatches =
    session.leaseEpoch === fence.leaseEpoch &&
    session.executionGeneration === fence.executionGeneration &&
    session.authRevision === fence.authRevision &&
    attempt.leaseEpoch === fence.leaseEpoch &&
    attempt.executionGeneration === fence.executionGeneration &&
    attempt.authRevision === fence.authRevision &&
    !ENDED_ATTEMPT_STATES.includes(attempt.state);
  if (!epochMatches) return { outcome: "stale_epoch" };
  if (!leaseHeld(attempt, at)) return { outcome: "lease_expired" };
  // The token has now been accepted for something, whatever that was: an
  // event on no turn, a poll that found nothing. That closes the one-shot
  // bootstrap replay, which would otherwise hand this binding to whoever
  // still holds the nonce and fence the working worker out.
  if (attempt.state === "allocated") {
    await tx
      .update(attempts)
      .set({ state: "starting" })
      .where(eq(attempts.id, attempt.id));
    return {
      outcome: "ok",
      session,
      attempt: { ...attempt, state: "starting" },
      at,
    };
  }
  return { outcome: "ok", session, attempt, at };
}

// Two submissions of one source_sequence are the same event only if every
// stored field matches: a reused sequence that moved to another turn or
// another time is a different event wearing the same number.
function sameEvent(
  stored: {
    type: string;
    payload: unknown;
    turnId: number | null;
    occurredAt: Date | null;
  },
  event: WorkerEvent,
  turnRowId: number | null,
): boolean {
  return (
    stored.type === event.event &&
    stored.turnId === turnRowId &&
    stored.occurredAt?.getTime() === new Date(event.occurred_at).getTime() &&
    payloadHash(stored.payload) === payloadHash(event.data)
  );
}

// The worker drops its local buffer up to this number, so it must be the end
// of the unbroken run that starts at sequence 1: a run found further along
// says nothing about the events before it. A row with no successor ends a
// run, and the first such row ends the first run.
// Reads how a finalize stands: already committed (a replay, or a different
// body wearing the same key), or still open and waiting for this request.
// finalizeAtomic locks the row; the read-only peek does not.
async function probeFinalize(
  tx: Database,
  fence: WorkerFence,
  input: FinalizeInput,
  lock: boolean,
): Promise<
  | { state: "open"; turn: typeof turns.$inferSelect; terminalHash: string }
  | { state: "settled"; result: FinalizeResult }
> {
  const sequence = parseTurnId(input.turnId);
  const query = sequence
    ? tx
        .select()
        .from(turns)
        .where(
          and(
            eq(turns.sessionId, fence.sessionId),
            eq(turns.sequence, sequence),
          ),
        )
        .limit(1)
    : null;
  const rows = query ? await (lock ? query.for("update") : query) : [];
  const [turn] = rows;
  if (!turn || turn.attemptId !== fence.attemptId) {
    return { state: "settled", result: { outcome: "turn_not_found" } };
  }
  // The checkpoint and the event tail are part of what finalize commits, so a
  // retry that changes either is a different request wearing the same key —
  // and a replay must not let a different tail past the gate that only runs
  // on the first commit.
  const terminalHash = payloadHash({
    terminal: input.terminal,
    checkpoint: input.checkpoint,
    final_source_sequence: input.finalSourceSequence,
  });
  if (OPEN_TURN_STATUSES.includes(turn.status)) {
    return { state: "open", turn, terminalHash };
  }
  const stored = (turn.resultJson ?? {}) as {
    finalize_key?: unknown;
    finalize_hash?: unknown;
  };
  // A replay carries the same key and the same body; anything else would
  // report a terminal the stored turn does not have.
  if (
    stored.finalize_key !== input.finalizeKey ||
    stored.finalize_hash !== terminalHash
  ) {
    return { state: "settled", result: { outcome: "finalize_conflict" } };
  }
  const [checkpoint] = await tx
    .select({ revision: max(checkpoints.revision) })
    .from(checkpoints)
    .where(eq(checkpoints.turnId, turn.id));
  return {
    state: "settled",
    result: {
      outcome: "replayed",
      result: {
        turnId: input.turnId,
        status: workerTerminalSchema.parse(turn.status),
        checkpointRevision: checkpoint?.revision ?? null,
      },
    },
  };
}

async function contiguousThrough(
  tx: Database,
  fence: WorkerFence,
): Promise<number> {
  const [row] = await tx
    .select({
      first: sql<number | null>`min(${events.sourceSequence})`,
    })
    .from(events)
    .where(
      and(
        eq(events.sessionId, fence.sessionId),
        eq(events.attemptId, fence.attemptId),
      ),
    );
  if (row?.first !== 1) return 0;
  const [end] = await tx
    .select({
      through: sql<number | null>`min(${events.sourceSequence})`,
    })
    .from(events)
    .where(
      and(
        eq(events.sessionId, fence.sessionId),
        eq(events.attemptId, fence.attemptId),
        sql`NOT EXISTS (
          SELECT 1 FROM ${events} next
          WHERE next.session_id = ${fence.sessionId}
            AND next.attempt_id = ${fence.attemptId}
            AND next.source_sequence = ${events.sourceSequence} + 1
        )`,
      ),
    );
  return end?.through ?? 0;
}

export function parseTurnId(turnId: string): number | null {
  if (!TURN_ID.test(turnId)) return null;
  const sequence = Number(turnId);
  return sequence <= SEQUENCE_MAX ? sequence : null;
}

async function latestCheckpoint(
  tx: Database,
  sessionId: string,
): Promise<CheckpointRef | null> {
  const [row] = await tx
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.sessionId, sessionId))
    .orderBy(desc(checkpoints.revision))
    .limit(1);
  return row
    ? {
        revision: row.revision,
        manifest_ref: row.manifestRef,
        manifest_sha256: row.manifestSha256,
        ...(row.manifestVersion === null
          ? {}
          : { manifest_version: row.manifestVersion }),
      }
    : null;
}

/**
 * The one place the checkpoint pointer advances. A turn's finalize and a
 * turn-less commit (CheckpointStore.commitAtomic) both come through here,
 * inside the caller's fenced transaction, so there is a single answer to
 * which revision is the session's truth: the row's current pointer plus one,
 * exactly — the server handed that number out (checkpointStateAtomic), and a
 * manifest claiming a later one was written against a pointer that no longer
 * stands.
 *
 * Committing clears a blocking pending reason only when the reason came
 * from another attempt. The runtime latches a mirror failure for its whole
 * run, so a checkpoint from the attempt that reported it was captured before
 * the failure at best and says nothing about the transcript since; a fresh
 * run that re-mirrored from the local file is what a valid checkpoint
 * proves. An advisory reason (the run was not quiescent) is cleared by any
 * commit: a checkpoint that committed is exactly what it was missing.
 */
export async function advanceCheckpointPointer(
  tx: Database,
  input: {
    fence: WorkerFence;
    session: SessionRow;
    checkpoint: CheckpointRef;
    turnRowId: number | null;
    now: Date;
    versionsHeld: boolean;
  },
): Promise<
  | { outcome: "committed"; revision: number }
  | { outcome: "not_next"; currentRevision: number | null }
> {
  const next = (input.session.checkpointRevision ?? -1) + 1;
  if (input.checkpoint.revision !== next) {
    return {
      outcome: "not_next",
      currentRevision: input.session.checkpointRevision,
    };
  }
  await tx.insert(checkpoints).values({
    sessionId: input.fence.sessionId,
    revision: input.checkpoint.revision,
    manifestRef: input.checkpoint.manifest_ref,
    manifestSha256: input.checkpoint.manifest_sha256,
    manifestVersion: input.checkpoint.manifest_version ?? null,
    versionsHeld: input.versionsHeld,
    turnId: input.turnRowId,
    committedAt: input.now,
  });
  const pending = storedPendingReason(input.session.checkpointPendingReason);
  const resolvesPending =
    pending !== null &&
    (!checkpointReasonHoldsWork(pending) ||
      input.session.checkpointPendingAttemptId !== input.fence.attemptId);
  expectFenced(
    await tx
      .update(sessions)
      .set({
        checkpointRevision: input.checkpoint.revision,
        checkpointCommittedAt: input.now,
        // Whatever an earlier fallback restored, this commit now stands for
        // the session's state.
        checkpointFallbackRevision: null,
        checkpointFallbackAttemptId: null,
        updatedAt: input.now,
        ...(resolvesPending
          ? { checkpointPendingReason: null, checkpointPendingAttemptId: null }
          : {}),
      })
      .where(fencedSession(input.fence))
      .returning({ id: sessions.id }),
    "session pointer",
  );
  return { outcome: "committed", revision: input.checkpoint.revision };
}

function storedPendingReason(
  value: string | null,
): CheckpointBlockReason | null {
  return value === null ? null : checkpointBlockReasonSchema.parse(value);
}

/**
 * The pointer as the session row states it, read inside the caller's
 * transaction so it belongs to the same snapshot as the fence. A row that
 * points at a revision with no checkpoint row is corruption, not a state, and
 * is reported rather than read around as "no checkpoint".
 */
export async function readCheckpointPointer(
  tx: Database,
  session: Pick<
    SessionRow,
    "id" | "checkpointRevision" | "checkpointCommittedAt"
  >,
): Promise<CheckpointPointer | null> {
  if (session.checkpointRevision === null) return null;
  const [checkpoint] = await tx
    .select({
      manifestRef: checkpoints.manifestRef,
      manifestSha256: checkpoints.manifestSha256,
      manifestVersion: checkpoints.manifestVersion,
      versionsHeld: checkpoints.versionsHeld,
      committedAt: checkpoints.committedAt,
      turnSequence: turns.sequence,
    })
    .from(checkpoints)
    .leftJoin(turns, eq(turns.id, checkpoints.turnId))
    .where(
      and(
        eq(checkpoints.sessionId, session.id),
        eq(checkpoints.revision, session.checkpointRevision),
      ),
    )
    .limit(1);
  if (!checkpoint) {
    throw new Error(
      `Session ${session.id} points at checkpoint revision ${session.checkpointRevision}, which has no row`,
    );
  }
  return {
    committedAt: session.checkpointCommittedAt ?? checkpoint.committedAt,
    manifestRef: checkpoint.manifestRef,
    manifestSha256: checkpoint.manifestSha256,
    manifestVersion: checkpoint.manifestVersion,
    revision: session.checkpointRevision,
    versionsHeld: checkpoint.versionsHeld,
    turnId:
      checkpoint.turnSequence === null ? null : String(checkpoint.turnSequence),
  };
}

async function bindingOf(
  tx: Database,
  session: SessionRow,
  attempt: AttemptRow,
): Promise<WorkerBinding> {
  return {
    sessionId: session.id,
    attemptId: attempt.id,
    leaseEpoch: attempt.leaseEpoch,
    executionGeneration: attempt.executionGeneration,
    authRevision: attempt.authRevision,
    leaseExpiresAt: attempt.leaseExpiresAt,
    profileId: session.profileId,
    ownerScope: session.ownerId,
    repository: {
      id: session.repositoryId,
      url: session.repoUrl,
      branch: session.branch,
    },
    restore: await latestCheckpoint(tx, session.id),
  };
}

async function issueCredential(
  tx: Database,
  input: Pick<ClaimInput, "attemptId" | "credentialHash" | "credentialTtlMs">,
) {
  await tx.insert(workerCredentials).values({
    tokenHash: input.credentialHash,
    attemptId: input.attemptId,
    expiresAt: fromDbNow(input.credentialTtlMs),
  });
}

async function revokeCredentials(tx: Database, attemptId: string, now: Date) {
  await tx
    .update(workerCredentials)
    .set({ revokedAt: now })
    .where(
      and(
        eq(workerCredentials.attemptId, attemptId),
        isNull(workerCredentials.revokedAt),
      ),
    );
}

export function createPostgresWorkerUnitOfWork(db: Database): WorkerUnitOfWork {
  return {
    async registerLaunchAtomic(input: RegisterLaunchInput) {
      const inserted = await db
        .insert(workerLaunches)
        .values({
          executionId: input.executionId,
          generation: input.generation,
          partition: input.partition,
          sessionId: input.sessionId,
          backend: input.backend,
          nonceHash: input.nonceHash,
          nonceExpiresAt: fromDbNow(input.nonceTtlMs),
        })
        .onConflictDoNothing({ target: workerLaunches.executionId })
        .returning({ executionId: workerLaunches.executionId });
      return { outcome: inserted.length === 1 ? "registered" : "exists" };
    },

    claimAtomic(input: ClaimInput): Promise<ClaimResult> {
      return db.transaction(async (tx) => {
        const [launch] = await tx
          .select()
          .from(workerLaunches)
          .where(eq(workerLaunches.nonceHash, input.nonceHash))
          .limit(1)
          .for("update");
        // The lease and the token start on the database clock once this row
        // is locked, so a claim that waited out its own TTL on the lock does
        // not answer "claimed" with a binding that is already dead. Audit
        // stamps keep the caller's clock: they record the request, not the
        // ownership window.
        const leaseExpiresAt = fromDbNow(input.leaseTtlMs);
        const credentialTtlMs = input.credentialTtlMs;
        // The nonce deadline was written on the database clock, so it is
        // judged there too, once the row lock is held: a claim that waited
        // out the nonce window on the lock is refused, whatever this
        // replica's clock says.
        const at = await dbNow(tx);
        if (
          !launch ||
          launch.executionId !== input.executionId ||
          launch.generation !== input.executionGeneration ||
          // The backend already observed this execution end and took its slot
          // back, so a straggler must not claim a session with its nonce.
          launch.slotReleasedAt !== null ||
          // A reservation that never had a container created for it holds no
          // credential at all; the lookup above cannot match one, and this
          // says so rather than reading a null expiry.
          launch.nonceExpiresAt === null ||
          // Applies to the replay path too: after the nonce lifetime the
          // bootstrap door is shut, and re-entering it would revoke the
          // session token of the worker that is still running.
          launch.nonceExpiresAt.getTime() <= at.getTime()
        ) {
          return { outcome: "invalid_credential" };
        }

        // A retry of a claim whose response was lost gets the same binding
        // and a fresh session token; it never selects a second session.
        // Earlier tokens for the attempt are revoked so that, if the nonce
        // leaked to a second worker, only the latest claimant can write.
        if (launch.claimedAttemptId !== null) {
          const [bound] = await tx
            .select({ session: sessions, attempt: attempts })
            .from(attempts)
            .innerJoin(sessions, eq(sessions.id, attempts.sessionId))
            .where(eq(attempts.id, launch.claimedAttemptId))
            .limit(1)
            .for("update");
          // "allocated" is what the claim itself wrote: any later state
          // means the worker already used its token, so this is not a lost
          // response but a second holder trying to rotate it away.
          if (!bound || bound.attempt.state !== "allocated") {
            return { outcome: "invalid_credential" };
          }
          // A retry can land on a replica whose catalog lost this profile.
          // Rotating the token first would revoke the old one, bump the
          // revision and then fail on the way out, leaving a binding nobody
          // holds a token for and a retry that mutates again.
          if (
            bound.session.profileId === null ||
            !input.runnableProfiles.includes(bound.session.profileId)
          ) {
            return { outcome: "profile_unavailable" };
          }
          await revokeCredentials(tx, bound.attempt.id, input.now);
          await issueCredential(tx, {
            attemptId: bound.attempt.id,
            credentialHash: input.credentialHash,
            credentialTtlMs,
          });
          // Revoking the old token does not stop a request that authenticated
          // before it: the auth revision moves so anything already in flight
          // fails its fence, and only the new holder can write.
          const [session] = await tx
            .update(sessions)
            .set({
              authRevision: sql`${sessions.authRevision} + 1`,
              updatedAt: input.now,
            })
            .where(eq(sessions.id, bound.session.id))
            .returning();
          if (!session) return { outcome: "invalid_credential" };
          const [attempt] = await tx
            .update(attempts)
            // The attempt has not started, so the replay gets a whole lease:
            // handing back the expired one would answer "claimed" and then
            // refuse every call the worker makes with it.
            .set({ authRevision: session.authRevision, leaseExpiresAt })
            .where(eq(attempts.id, bound.attempt.id))
            .returning();
          if (!attempt) return { outcome: "invalid_credential" };
          return {
            outcome: "replayed",
            binding: await bindingOf(tx, session, attempt),
          };
        }
        // Server-side selection: the worker never names a session. It is
        // either the one the launch reserved or the partition's head; SKIP
        // LOCKED lets concurrent claims in one partition pick different heads
        // instead of serialising on the oldest signal.
        const [candidate] = await tx
          .select({ sessionId: unassignedSessions.sessionId })
          .from(unassignedSessions)
          .innerJoin(sessions, eq(sessions.id, unassignedSessions.sessionId))
          .where(
            and(
              eq(unassignedSessions.partition, launch.partition),
              isNull(sessions.podId),
              eq(sessions.admissionState, "active"),
              inArray(sessions.profileId, input.runnableProfiles),
              ...(launch.sessionId === null
                ? []
                : [eq(sessions.id, launch.sessionId)]),
            ),
          )
          .orderBy(asc(unassignedSessions.signaledAt), asc(sessions.id))
          .limit(1)
          .for("update", { of: unassignedSessions, skipLocked: true });
        if (!candidate) return { outcome: "no_session" };

        const [session] = await tx
          .update(sessions)
          .set({
            leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
            executionGeneration: launch.generation,
            executionId: launch.executionId,
            podId: launch.executionId,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(sessions.id, candidate.sessionId),
              isNull(sessions.podId),
              // The candidate query saw `active`, but a terminate can commit
              // between that read and this row lock; the write is the check.
              eq(sessions.admissionState, "active"),
            ),
          )
          .returning();
        if (!session) return { outcome: "no_session" };

        const [attempt] = await tx
          .insert(attempts)
          .values({
            id: input.attemptId,
            sessionId: session.id,
            executionId: launch.executionId,
            leaseEpoch: session.leaseEpoch,
            executionGeneration: session.executionGeneration,
            authRevision: session.authRevision,
            state: "allocated",
            leaseExpiresAt,
            startedAt: input.now,
          })
          .returning();
        if (!attempt) throw new Error("Failed to insert attempt");
        await tx
          .insert(executions)
          .values({
            id: launch.executionId,
            sessionId: session.id,
            backend: launch.backend,
            generation: launch.generation,
            desiredState: "running",
            observedState: "running",
            observedAt: input.now,
          })
          .onConflictDoUpdate({
            target: executions.id,
            set: {
              sessionId: session.id,
              observedState: "running",
              observedAt: input.now,
            },
          });
        await issueCredential(tx, input);
        await tx
          .update(workerLaunches)
          .set({ claimedAttemptId: attempt.id })
          .where(eq(workerLaunches.executionId, launch.executionId));
        await tx
          .delete(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, session.id));
        return {
          outcome: "claimed",
          binding: await bindingOf(tx, session, attempt),
        };
      });
    },

    async resolveCredential(
      tokenHash: Uint8Array,
    ): Promise<ResolvedCredential> {
      const [session] = await db
        .select({
          attemptId: attempts.id,
          sessionId: attempts.sessionId,
          leaseEpoch: attempts.leaseEpoch,
          executionGeneration: attempts.executionGeneration,
          authRevision: attempts.authRevision,
        })
        .from(workerCredentials)
        .innerJoin(attempts, eq(attempts.id, workerCredentials.attemptId))
        .where(
          and(
            eq(workerCredentials.tokenHash, tokenHash),
            isNull(workerCredentials.revokedAt),
            gt(workerCredentials.expiresAt, DB_NOW),
            notInArray(attempts.state, ENDED_ATTEMPT_STATES),
          ),
        )
        .limit(1);
      if (session) return { kind: "session", ...session };
      const [launch] = await db
        .select({ executionId: workerLaunches.executionId })
        .from(workerLaunches)
        .where(eq(workerLaunches.nonceHash, tokenHash))
        .limit(1);
      return launch ? { kind: "bootstrap" } : null;
    },

    nextInputAtomic(input: NextInputInput): Promise<NextInputResult> {
      const { fence, now } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        const leaseExpiresAt = fenced.attempt.leaseExpiresAt;
        // A draining attempt is on its way out. Handing it a queued turn
        // would both walk its state back to running and leave that turn
        // unfinished once the execution goes, which costs the session a
        // recovery decision it never needed.
        const draining = fenced.attempt.state === "draining";

        const [head] = await tx
          .select({ message: queueMessages, turn: turns })
          .from(queueMessages)
          .innerJoin(turns, eq(turns.id, queueMessages.turnId))
          .where(
            and(
              eq(queueMessages.sessionId, fence.sessionId),
              eq(queueMessages.kind, "message"),
            ),
          )
          .orderBy(asc(queueMessages.id))
          .limit(1)
          .for("update");
        // Whoever held that row may have held it past this lease. Handing the
        // turn over now would start work on a session this attempt no longer
        // owns, which is the one thing the fence exists to prevent.
        const at = await dbNow(tx);
        if (!leaseHeld(fenced.attempt, at)) return { outcome: "lease_expired" };
        const none = {
          outcome: "ok" as const,
          input: null,
          leaseExpiresAt,
          ...(draining ? { draining: true as const } : {}),
        };
        if (!head) return none;
        const { message, turn } = head;

        // The head was delivered to an earlier attempt and never finalized:
        // its outcome is unknown, and only the reconciler (94S-139) may
        // decide; a fresh delivery here would re-run its side effects.
        const redelivery =
          turn.attemptId === fence.attemptId &&
          OPEN_TURN_STATUSES.includes(turn.status);
        if (turn.status !== "queued" && !redelivery) return none;
        if (draining && !redelivery) return none;
        // Pausing (or any state but active) admits nothing new; the turn
        // this attempt already holds is still its to finish.
        if (fenced.session.admissionState !== "active" && !redelivery) {
          return none;
        }

        const deliveryStartedAt = turn.deliveryStartedAt ?? now;
        if (!redelivery) {
          await tx
            .update(queueMessages)
            .set({
              claimedBy: fence.attemptId,
              claimToken: crypto.randomUUID(),
              visibleAt: now,
            })
            .where(eq(queueMessages.id, message.id));
          await tx
            .update(turns)
            .set({
              status: "running",
              attemptId: fence.attemptId,
              startedAt: now,
              deliveryStartedAt,
            })
            .where(and(eq(turns.id, turn.id), eq(turns.status, "queued")));
          expectFenced(
            await tx
              .update(sessions)
              .set({ status: "running", updatedAt: now })
              .where(fencedSession(fence))
              .returning({ id: sessions.id }),
            "session",
          );
          expectFenced(
            await tx
              .update(attempts)
              .set({ state: "running" })
              .where(fencedAttempt(fence, at))
              .returning({ id: attempts.id }),
            "attempt",
          );
        }
        return {
          outcome: "ok",
          leaseExpiresAt,
          input: {
            turnId: String(turn.sequence),
            inputId: String(message.id),
            message: turn.message,
            deliveryStartedAt,
          },
        };
      });
    },

    heartbeatAtomic(input: HeartbeatInput): Promise<HeartbeatResult> {
      const { fence, now } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        const reported = ATTEMPT_PHASE_ORDER[input.attemptState] ?? -1;
        const current = ATTEMPT_PHASE_ORDER[fenced.attempt.state] ?? -1;
        // Overlapping heartbeats can commit out of order, and the loser must
        // not shorten a lease the winner already extended, so every clock
        // here only moves forward.
        const updated = await tx
          .update(attempts)
          .set({
            leaseExpiresAt: sql`GREATEST(${attempts.leaseExpiresAt}, ${fromDbNow(input.leaseTtlMs)})`,
            lastHeartbeatAt: sql`GREATEST(${attempts.lastHeartbeatAt}, ${now})`,
            state:
              reported > current ? input.attemptState : fenced.attempt.state,
          })
          .where(fencedAttempt(fence, fenced.at))
          .returning({ leaseExpiresAt: attempts.leaseExpiresAt });
        expectFenced(updated, "attempt");
        const [beat] = updated;
        if (!beat) throw new Error("Fenced attempt write returned no row");
        if (input.transcript !== undefined) {
          // A late heartbeat cannot walk the mirror mark backwards, and an
          // error only sets the reason: clearing is a checkpoint's to do.
          const persistedAt = input.transcript.persistedAt;
          expectFenced(
            await tx
              .update(sessions)
              .set({
                ...(persistedAt === null
                  ? {}
                  : {
                      lastTranscriptPersistedAt: sql`GREATEST(${sessions.lastTranscriptPersistedAt}, ${persistedAt})`,
                    }),
                ...(input.transcript.mirrorError === null
                  ? {}
                  : {
                      checkpointPendingReason: "mirror_error",
                      checkpointPendingAttemptId: fence.attemptId,
                    }),
              })
              .where(fencedSession(fence))
              .returning({ id: sessions.id }),
            "session transcript",
          );
        }
        await tx
          .update(executions)
          .set({
            observedAt: sql`GREATEST(${executions.observedAt}, ${now})`,
            observedState: "running",
          })
          .where(eq(executions.id, fenced.attempt.executionId));
        await tx
          .update(workerCredentials)
          .set({
            expiresAt: sql`GREATEST(${workerCredentials.expiresAt}, ${fromDbNow(input.credentialTtlMs)})`,
          })
          .where(
            and(
              eq(workerCredentials.attemptId, fence.attemptId),
              isNull(workerCredentials.revokedAt),
            ),
          );
        // The legacy orphan reconciler keys on workers.last_seen by pod_id.
        await tx
          .insert(workers)
          .values({ podId: fenced.attempt.executionId, lastSeen: now })
          .onConflictDoUpdate({
            target: workers.podId,
            set: { lastSeen: sql`GREATEST(${workers.lastSeen}, ${now})` },
          });
        return {
          outcome: "ok",
          leaseExpiresAt: beat.leaseExpiresAt,
          authRevision: fenced.session.authRevision,
        };
      });
    },

    commitEventsAtomic(input: CommitEventsInput): Promise<CommitEventsResult> {
      const { fence } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;

        // One batch must not carry two different events under one sequence:
        // which of them survived would then depend on insert order.
        const batch = new Map<number, WorkerEvent>();
        for (const event of input.events) {
          const twin = batch.get(event.source_sequence);
          if (
            twin &&
            (twin.event !== event.event ||
              twin.occurred_at !== event.occurred_at ||
              payloadHash(twin.data) !== payloadHash(event.data))
          ) {
            return { outcome: "event_conflict" };
          }
          batch.set(event.source_sequence, event);
        }

        let turnRowId: number | null = null;
        let turnStatus: string | null = null;
        if (input.turnId !== null) {
          const sequence = parseTurnId(input.turnId);
          // Only the turn this attempt is running: the fence alone would let
          // a live worker write history onto a queued or foreign turn.
          const [turn] = sequence
            ? await tx
                .select({ id: turns.id, status: turns.status })
                .from(turns)
                .where(
                  and(
                    eq(turns.sessionId, fence.sessionId),
                    eq(turns.sequence, sequence),
                    eq(turns.attemptId, fence.attemptId),
                  ),
                )
                .limit(1)
            : [];
          if (!turn) return { outcome: "turn_not_found" };
          turnRowId = turn.id;
          turnStatus = turn.status;
        }

        // Everything is checked before anything is written: a batch that is
        // rejected must leave the stream exactly as it was, which an
        // insert-then-inspect order cannot promise.
        const existing = await tx
          .select({
            type: events.type,
            payload: events.payload,
            turnId: events.turnId,
            occurredAt: events.occurredAt,
            sourceSequence: events.sourceSequence,
          })
          .from(events)
          .where(
            and(
              eq(events.sessionId, fence.sessionId),
              eq(events.attemptId, fence.attemptId),
              inArray(events.sourceSequence, [...batch.keys()]),
            ),
          );
        const stored = new Map(
          existing.map((row) => [row.sourceSequence, row]),
        );
        const fresh: WorkerEvent[] = [];
        for (const [sequence, event] of batch) {
          const row = stored.get(sequence);
          if (!row) {
            fresh.push(event);
            continue;
          }
          // A replay of what is already stored is a no-op; anything else
          // would leave the worker holding a cursor for data the stream
          // does not contain.
          if (!sameEvent(row, event, turnRowId)) {
            return { outcome: "event_conflict" };
          }
        }
        // A finalized turn's history is closed: only exact replays of what it
        // already holds are still answered.
        if (
          fresh.length > 0 &&
          turnStatus !== null &&
          !OPEN_TURN_STATUSES.includes(turnStatus)
        ) {
          return { outcome: "turn_finalized" };
        }
        // Events are published in insertion order, so one may only be written
        // once its predecessor is durable: a hole here would be permanent in
        // the order every subscriber reads.
        fresh.sort((a, b) => a.source_sequence - b.source_sequence);
        const durable = await contiguousThrough(tx, fence);
        for (const [index, event] of fresh.entries()) {
          if (event.source_sequence !== durable + 1 + index) {
            return { outcome: "sequence_gap", acceptedThrough: durable };
          }
        }
        if (fresh.length > 0 && !leaseHeld(fenced.attempt, await dbNow(tx))) {
          return { outcome: "lease_expired" };
        }
        if (fresh.length > 0) {
          await tx.insert(events).values(
            fresh.map((event) => ({
              sessionId: fence.sessionId,
              type: event.event,
              payload: event.data,
              turnId: turnRowId,
              attemptId: fence.attemptId,
              sourceSequence: event.source_sequence,
              occurredAt: new Date(event.occurred_at),
            })),
          );
        }
        const [latest] = await tx
          .select({ id: max(events.id) })
          .from(events)
          .where(
            and(
              eq(events.sessionId, fence.sessionId),
              eq(events.attemptId, fence.attemptId),
            ),
          );
        await tx.execute(
          sql`SELECT pg_notify('session_events', ${fence.sessionId})`,
        );
        return {
          outcome: "ok",
          acceptedThrough: await contiguousThrough(tx, fence),
          cursor: encodeEventCursor(latest?.id ?? 0),
        };
      });
    },

    // Deliberately unfenced: this only reads back what the attempt itself
    // already committed. A retry that arrives after the lease lapsed still
    // has to learn whether its finalize landed — answering LEASE_EXPIRED
    // there turns a settled turn into an unknown outcome. Nothing is written
    // here, and an open turn still goes through the fenced commit below.
    peekFinalizeAtomic(input: FinalizeInput): Promise<PeekFinalizeResult> {
      const { fence } = input;
      return db.transaction(async (tx) => {
        const probe = await probeFinalize(tx, fence, input, false);
        if (probe.state !== "open") return probe.result;
        // Only a settled turn is readable without the fence. An open one
        // belongs to whoever holds the lease, and saying "open" to anyone
        // else would have the gateway verify a checkpoint on their behalf.
        const fenced = await acquireFence(tx, fence);
        // Waiting for that lock is exactly when a competing finalize commits,
        // so the turn is read again before this one is called open.
        const settled = await probeFinalize(tx, fence, input, false);
        if (settled.state !== "open") return settled.result;
        return fenced.outcome === "ok" ? { outcome: "open" } : fenced;
      });
    },

    finalizeAtomic(input: FinalizeInput): Promise<FinalizeResult> {
      const { fence, now } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;

        const probe = await probeFinalize(tx, fence, input, true);
        if (probe.state !== "open") return probe.result;
        const { turn, terminalHash } = probe;
        // api.md: `interrupted` is only ever recorded together with the
        // checkpoint that makes it consistent; without one the worker has to
        // say outcome_unknown. A replay above is still answered as stored.
        if (input.terminal.status === "interrupted" && !input.checkpoint) {
          return {
            outcome: "checkpoint_rejected",
            reason: "an interrupted turn must commit a checkpoint with it",
          };
        }
        if (!leaseHeld(fenced.attempt, await dbNow(tx))) {
          return { outcome: "lease_expired" };
        }
        // Appends take the same session lock, so this read cannot race one:
        // either the tail landed before this transaction or it arrives after
        // a refusal and the worker finalizes again.
        const durable = await contiguousThrough(tx, fence);
        if (durable !== input.finalSourceSequence) {
          return { outcome: "events_incomplete", acceptedThrough: durable };
        }

        // A session the platform cannot checkpoint must not report a turn
        // as durably finished: the SDK's success is not enough on its own.
        // The other terminals record what happened and are never held back.
        const pendingReason = storedPendingReason(
          fenced.session.checkpointPendingReason,
        );
        if (
          input.terminal.status === "completed" &&
          !input.checkpoint &&
          pendingReason !== null &&
          checkpointReasonHoldsWork(pendingReason)
        ) {
          return { outcome: "checkpoint_required", reason: pendingReason };
        }

        let checkpointRevision: number | null = null;
        if (input.checkpoint) {
          const advanced = await advanceCheckpointPointer(tx, {
            fence,
            session: fenced.session,
            checkpoint: input.checkpoint,
            turnRowId: turn.id,
            now,
            versionsHeld: input.checkpointVersionsHeld === true,
          });
          if (advanced.outcome === "not_next") {
            // An interrupt has no second capture to wait for: its checkpoint
            // cannot commit, so the worker records the turn unknown instead.
            if (input.terminal.status === "interrupted") {
              return {
                outcome: "checkpoint_rejected",
                reason: `revision ${input.checkpoint.revision} is not next after ${advanced.currentRevision ?? "none"}`,
              };
            }
            return {
              outcome: "checkpoint_conflict",
              currentRevision: advanced.currentRevision,
            };
          }
          checkpointRevision = advanced.revision;
        }

        const unknownOutcome = input.terminal.status === "outcome_unknown";
        const [terminal] = await tx
          .update(turns)
          .set({
            status: input.terminal.status,
            endedAt: now,
            terminalReason: input.terminal.reason,
            outcomeUnknown: unknownOutcome,
            resultJson: {
              finalize_key: input.finalizeKey,
              finalize_hash: terminalHash,
              result: input.terminal.result,
              usage: input.terminal.usage,
            },
          })
          .where(
            and(
              eq(turns.id, turn.id),
              eq(turns.attemptId, fence.attemptId),
              inArray(turns.status, OPEN_TURN_STATUSES),
            ),
          )
          .returning({ id: turns.id, sequence: turns.sequence });
        expectFenced([terminal].filter(Boolean), "turn");
        if (terminal) {
          await settleTurnInterrupts(tx, {
            turnRowId: terminal.id,
            turnSequence: terminal.sequence,
            terminal: input.terminal.status,
            at: now,
          });
        }

        const receiptStatus = RECEIPT_STATUS_BY_TERMINAL[input.terminal.status];
        const succeeded = receiptStatus === "succeeded";
        // `result` stays the acceptance response (receiptSchema.result); the
        // turn's own result is read through target_ref.turn_id.
        await tx
          .update(receipts)
          .set({
            status: receiptStatus,
            error: succeeded
              ? null
              : {
                  code: unknownOutcome ? "RECOVERY_REQUIRED" : "INTERNAL_ERROR",
                  message: input.terminal.reason ?? input.terminal.status,
                },
            updatedAt: now,
          })
          .where(
            and(
              inArray(receipts.operation, INPUT_RECEIPT_OPERATIONS),
              eq(receipts.status, "accepted"),
              sql`${receipts.targetRef}->>'session_id' = ${fence.sessionId}`,
              sql`${receipts.targetRef}->>'turn_id' = ${input.turnId}`,
            ),
          );
        // An unknown outcome keeps its queue head: the input stays blocked
        // until an operator recovery decision (94S-140), never redelivered.
        if (!unknownOutcome) {
          await tx
            .delete(queueMessages)
            .where(
              and(
                eq(queueMessages.sessionId, fence.sessionId),
                eq(queueMessages.turnId, turn.id),
              ),
            );
        }
        expectFenced(
          await tx
            .update(sessions)
            .set({
              status: SESSION_STATUS_BY_TERMINAL[input.terminal.status],
              lastTurnAt: now,
              updatedAt: now,
              ...(unknownOutcome
                ? { admissionState: "recovery_required" as const }
                : {}),
            })
            .where(fencedSession(fence))
            .returning({ id: sessions.id }),
          "session",
        );
        if (unknownOutcome && fenced.session.admissionState === "pausing") {
          // recovery_required takes the session out of pausing, so the pause
          // it was draining for can no longer complete.
          await tx
            .update(receipts)
            .set({
              status: "failed",
              error: {
                code: "RECOVERY_REQUIRED",
                message: `turn ${input.turnId} ended with an unknown outcome while the pause was draining`,
              },
              updatedAt: now,
            })
            .where(openPauseReceipt(fence.sessionId));
        }
        return {
          outcome: "finalized",
          result: {
            turnId: input.turnId,
            status: input.terminal.status,
            checkpointRevision,
          },
        };
      });
    },

    checkpointStateAtomic(
      input: CheckpointStateInput,
    ): Promise<CheckpointStateResult> {
      const { fence } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        let pendingReason = storedPendingReason(
          fenced.session.checkpointPendingReason,
        );
        // A blocking reason outranks an advisory one and stays, attempt
        // included: the attempt decides who may clear it.
        if (
          input.pendingReason !== undefined &&
          nextPendingReason(pendingReason, input.pendingReason) ===
            input.pendingReason
        ) {
          expectFenced(
            await tx
              .update(sessions)
              .set({
                checkpointPendingReason: input.pendingReason,
                checkpointPendingAttemptId: fence.attemptId,
                updatedAt: input.now,
              })
              .where(fencedSession(fence))
              .returning({ id: sessions.id }),
            "session pending reason",
          );
          pendingReason = input.pendingReason;
        }
        return {
          outcome: "ok",
          pointer: await readCheckpointPointer(tx, fenced.session),
          pendingReason,
        };
      });
    },

    /**
     * The fallback is a fact about the session, not about one response: it
     * goes on the row, where pause and recovery read what the session's
     * state is actually based on, and on the event stream, where the owner
     * learns their session resumed from an older generation. Both happen
     * before the worker is given the plan, under the same fence and against
     * the same pointer the plan was judged on.
     *
     * One attempt is announced once per pointer. Asking again for the same
     * earlier revision is a retry; being handed a different one is refused,
     * because a worker restoring two different bases for one pointer leaves
     * the row describing only one of them.
     */
    recordRestoreBaseAtomic(
      input: RestoreBaseInput,
    ): Promise<RestoreBaseResult> {
      const { fence } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        const { session } = fenced;
        if (session.checkpointRevision !== input.pointerRevision) {
          return {
            outcome: "pointer_moved",
            currentRevision: session.checkpointRevision,
          };
        }
        const recorded = session.checkpointFallbackRevision;
        if (input.fallback === null) {
          if (recorded !== null) {
            expectFenced(
              await tx
                .update(sessions)
                .set({
                  checkpointFallbackRevision: null,
                  checkpointFallbackAttemptId: null,
                  updatedAt: input.now,
                })
                .where(fencedSession(fence))
                .returning({ id: sessions.id }),
              "session fallback",
            );
          }
          return { outcome: "ok" };
        }
        if (
          recorded !== null &&
          session.checkpointFallbackAttemptId === fence.attemptId
        ) {
          return recorded === input.fallback.revision
            ? { outcome: "ok" }
            : { outcome: "base_changed", recordedRevision: recorded };
        }
        expectFenced(
          await tx
            .update(sessions)
            .set({
              checkpointFallbackRevision: input.fallback.revision,
              checkpointFallbackAttemptId: fence.attemptId,
              updatedAt: input.now,
            })
            .where(fencedSession(fence))
            .returning({ id: sessions.id }),
          "session fallback",
        );
        // The attempt goes in the payload, not the event's attempt column:
        // that column numbers the worker's own sourced stream, and this row
        // is the server's.
        await recordAudit(tx, {
          sessionId: fence.sessionId,
          type: "system",
          payload: {
            type: "system",
            subtype: CHECKPOINT_RESTORE_FALLBACK,
            attempt_id: fence.attemptId,
            pointer_revision: input.pointerRevision,
            restored_revision: input.fallback.revision,
            skipped: input.fallback.skipped.map((skip) => ({
              revision: skip.revision,
              reason: skip.reason,
            })),
          },
          turnRowId: null,
          now: input.now,
        });
        return { outcome: "ok" };
      });
    },

    releaseAtomic(input: ReleaseInput): Promise<ReleaseResult> {
      const { fence, now } = input;
      return db.transaction(async (tx) => {
        // An expired lease on the current epoch may still release: the
        // worker is giving the binding up, which only advances the fence.
        // A superseded epoch cannot; that binding is not its to release.
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome === "stale_epoch") return { released: false };
        const pause = input.pauseControlId;
        if (pause !== undefined) {
          // Committing a pause is a decision taken under the lease, not the
          // giving up of one; an attempt refused here keeps both.
          if (fenced.outcome !== "ok") {
            return { released: false, refused: "lease_expired" };
          }
          const [open] =
            fenced.session.admissionState === "pausing"
              ? await tx
                  .select({ id: receipts.id })
                  .from(receipts)
                  .where(openPauseReceipt(fence.sessionId))
                  .limit(1)
              : [];
          if (open?.id !== pause) {
            return { released: false, refused: "pause_stale" };
          }
          const blocker = await pauseBlocker(tx, fenced.session);
          if (blocker !== null) {
            return {
              released: false,
              refused: "pause_blocked",
              reason: blocker,
            };
          }
          if (!leaseHeld(fenced.attempt, await dbNow(tx))) {
            return { released: false, refused: "lease_expired" };
          }
        }
        const [attempt] = await tx
          .update(attempts)
          .set({ state: "exited", endedAt: now, endReason: input.reason })
          .where(ownedAttempt(fence))
          .returning({ id: attempts.id, executionId: attempts.executionId });
        if (!attempt) return { released: false };
        await revokeCredentials(tx, fence.attemptId, now);
        // The epoch moves on so nothing from this attempt lands later, but
        // pod_id/execution_id stay: the session is not claimable until the
        // backend confirms the execution is gone (confirmExecutionGone).
        expectFenced(
          await tx
            .update(sessions)
            .set({
              leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
              updatedAt: now,
            })
            .where(fencedSession(fence))
            .returning({ id: sessions.id }),
          "session",
        );
        await tx.delete(workers).where(eq(workers.podId, attempt.executionId));
        if (pause !== undefined) {
          // The pause's stop intent, after the epoch discard above: the
          // scheduler removes the execution, and confirmExecutionGone settles
          // the session paused once it is seen gone.
          await tx
            .update(executions)
            .set({ desiredState: "terminated" })
            .where(eq(executions.id, attempt.executionId));
        }
        return { released: true };
      });
    },

    confirmExecutionGoneAtomic(
      input: ConfirmExecutionGoneInput,
    ): Promise<ConfirmExecutionGoneResult> {
      const { executionId, incarnation, now } = input;
      return db.transaction(async (tx) => {
        const [launch] = await tx
          .select({
            claimedAttemptId: workerLaunches.claimedAttemptId,
            nonceHash: workerLaunches.nonceHash,
            partition: workerLaunches.partition,
            replacementReason: workerLaunches.replacementReason,
          })
          .from(workerLaunches)
          .where(eq(workerLaunches.executionId, executionId))
          .limit(1)
          .for("update");
        if (
          incarnation !== undefined &&
          (!launch ||
            (launch.nonceHash
              ? launchNonceFingerprint(launch.nonceHash)
              : null) !== incarnation.nonceFingerprint ||
            (incarnation.claimed !== undefined &&
              (launch.claimedAttemptId !== null) !== incarnation.claimed))
        ) {
          // Judged under the row lock a create's credential issue and a
          // claim both take, so the caller's resource either is still the
          // launch's incarnation here or has been succeeded by one it never
          // saw — whose binding is not the caller's to end.
          return {
            sessionReleased: false,
            slotReleased: false,
            superseded: true,
          };
        }
        if (
          launch &&
          launch.replacementReason !== null &&
          launch.claimedAttemptId === null
        ) {
          // The scheduler has committed to rebuilding this launch from its
          // intent and may be between the teardown and the create right
          // now. Its resource being gone is that plan in progress, not an
          // exit: releasing here would hand the session a new launch under
          // a new generation, which is exactly what the record exists to
          // prevent. A claimed launch is never rebuilt, so it stays
          // confirmable whatever the column says; so does one asked to go,
          // which is killed rather than rebuilt — a replacement recorded
          // after the terminate would otherwise hold its slot forever.
          const [execution] = await tx
            .select({ desiredState: executions.desiredState })
            .from(executions)
            .where(eq(executions.id, executionId))
            .limit(1);
          if (execution?.desiredState !== "terminated") {
            return {
              deferred: true,
              sessionReleased: false,
              slotReleased: false,
            };
          }
        }
        // One slot returns per launch, however many times the exit is seen.
        const slot = await tx
          .update(workerLaunches)
          .set({ slotReleasedAt: now })
          .where(
            and(
              eq(workerLaunches.executionId, executionId),
              isNull(workerLaunches.slotReleasedAt),
            ),
          )
          .returning({ executionId: workerLaunches.executionId });
        // Every path takes its locks in the same order — launch, session,
        // attempt, execution — so a heartbeat and an exit observation that
        // overlap queue up instead of deadlocking each other.
        const [session] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.executionId, executionId))
          .limit(1)
          .for("update");
        const [observed] = await tx
          .update(executions)
          .set({
            observedState: "terminated",
            desiredState: "terminated",
            observedAt: sql`GREATEST(${executions.observedAt}, ${now})`,
          })
          .where(eq(executions.id, executionId))
          .returning({ observedAt: executions.observedAt });
        await tx.delete(workers).where(eq(workers.podId, executionId));

        if (!session) {
          return { sessionReleased: false, slotReleased: slot.length === 1 };
        }
        const open = await tx
          .update(attempts)
          .set({ state: "lost", endedAt: now, endReason: "execution_gone" })
          .where(
            and(
              eq(attempts.executionId, executionId),
              notInArray(attempts.state, ENDED_ATTEMPT_STATES),
            ),
          )
          .returning({ id: attempts.id });
        for (const attempt of open) {
          await revokeCredentials(tx, attempt.id, now);
        }

        // A turn that was handed to the execution and never finalized has no
        // knowable result now that the execution is gone. Saying nothing
        // would leave it looking like work in progress, so it is recorded as
        // unknown here and its input stays on the queue until an operator
        // decides (94S-140). The judgement lives in the same transaction
        // that removes the binding.
        const unresolved = await tx
          .update(turns)
          .set({
            status: "outcome_unknown",
            outcomeUnknown: true,
            endedAt: now,
            terminalReason: "execution_gone",
          })
          .where(
            and(
              eq(turns.sessionId, session.id),
              inArray(turns.status, OPEN_TURN_STATUSES),
            ),
          )
          .returning({ id: turns.id, sequence: turns.sequence });
        for (const turn of unresolved) {
          await settleTurnInterrupts(tx, {
            turnRowId: turn.id,
            turnSequence: turn.sequence,
            terminal: "outcome_unknown",
            at: now,
          });
        }
        // Requests the gone worker raised can never be answered by it; left
        // open they would keep the session reporting pending input forever.
        await tx
          .update(pendingRequests)
          .set({ resolvedAt: now })
          .where(
            and(
              eq(pendingRequests.sessionId, session.id),
              isNull(pendingRequests.resolvedAt),
            ),
          );
        await abandonUndeliveredAnswers(tx, session.id, now);
        for (const turn of unresolved) {
          // `result` stays the acceptance response (receiptSchema.result).
          await tx
            .update(receipts)
            .set({
              status: "unknown",
              error: {
                code: "RECOVERY_REQUIRED",
                message: "execution ended before the turn was finalized",
              },
              updatedAt: now,
            })
            .where(
              and(
                inArray(receipts.operation, INPUT_RECEIPT_OPERATIONS),
                eq(receipts.status, "accepted"),
                sql`${receipts.targetRef}->>'session_id' = ${session.id}`,
                sql`${receipts.targetRef}->>'turn_id' = ${String(turn.sequence)}`,
              ),
            );
        }

        // A session that asked for this kill (terminate, 94S-139) lands in
        // `stopped`, unless a turn was left unresolved, in which case the
        // recovery decision takes precedence just as for any other exit. A
        // session an operator already closed (94S-140) stays closed: the
        // unknown turn is recorded above, but nothing reopens the session.
        const stopping = session.admissionState === "stopping";
        const closed = session.admissionState === "closed";
        // A pause completes only here, on the observed absence, and only onto
        // a checkpoint that covers every turn that ran. One that cannot stays
        // pausing and says why (PAUSE_BLOCKED); the caller may terminate.
        const paused =
          session.admissionState === "pausing" &&
          unresolved.length === 0 &&
          (await pauseBlocker(tx, session)) === null;
        await tx
          .update(sessions)
          .set({
            podId: null,
            executionId: null,
            leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
            updatedAt: now,
            ...(closed
              ? {}
              : unresolved.length > 0
                ? {
                    status: "failed" as const,
                    admissionState: "recovery_required" as const,
                  }
                : stopping
                  ? {
                      status: "stopped" as const,
                      admissionState: "stopped" as const,
                    }
                  : paused
                    ? { admissionState: "paused" as const }
                    : {}),
          })
          .where(eq(sessions.id, session.id));
        // Stamped no earlier than the observation it rests on.
        const observedAt =
          observed?.observedAt && observed.observedAt > now
            ? observed.observedAt
            : now;
        if (paused) {
          await tx
            .update(receipts)
            .set({
              status: "succeeded",
              error: null,
              result: await pauseReceiptResult(tx, session),
              updatedAt: observedAt,
            })
            .where(openPauseReceipt(session.id));
        } else if (
          session.admissionState === "pausing" &&
          unresolved.length > 0
        ) {
          await tx
            .update(receipts)
            .set({
              status: "failed",
              error: {
                code: "RECOVERY_REQUIRED",
                message:
                  "execution ended before the turn the pause was draining was finalized",
              },
              updatedAt: observedAt,
            })
            .where(openPauseReceipt(session.id));
        }
        // The terminate receipt succeeds only here, on the observed absence;
        // one that already went `unknown` past its deadline is upgraded. The
        // turn it names is the earliest still unknown, whether it became so
        // just now or in an earlier exit the session is still recovering from.
        await tx
          .update(receipts)
          .set({
            status: "succeeded",
            error: null,
            result: terminateReceiptResult({
              checkpointRevision: session.checkpointRevision,
              unconfirmedTurnId: await earliestUnknownTurn(tx, session.id),
            }),
            updatedAt: now,
          })
          .where(
            and(
              eq(receipts.operation, "terminate"),
              inArray(receipts.status, ["accepted", "unknown"]),
              sql`${receipts.targetRef}->>'session_id' = ${session.id}`,
            ),
          );

        // Re-signal only when nothing is left unresolved: an unknown turn
        // must not be re-run by the next claim.
        const [queuedRow] = await tx
          .select({ queued: count() })
          .from(turns)
          .where(
            and(eq(turns.sessionId, session.id), eq(turns.status, "queued")),
          );
        const queued = queuedRow?.queued ?? 0;
        if (
          queued > 0 &&
          unresolved.length === 0 &&
          session.admissionState === "active"
        ) {
          await tx
            .insert(unassignedSessions)
            .values({
              sessionId: session.id,
              signaledAt: now,
              // The session goes back to the partition it was launched in.
              partition: launch?.partition ?? "default",
            })
            .onConflictDoNothing({ target: unassignedSessions.sessionId });
        }
        return { sessionReleased: true, slotReleased: slot.length === 1 };
      });
    },

    async countReservedSlots(partition?: string): Promise<number> {
      const [row] = await db
        .select({ reserved: count() })
        .from(workerLaunches)
        .where(
          and(
            isNull(workerLaunches.slotReleasedAt),
            partition === undefined
              ? undefined
              : eq(workerLaunches.partition, partition),
          ),
        );
      return row?.reserved ?? 0;
    },
  };
}
