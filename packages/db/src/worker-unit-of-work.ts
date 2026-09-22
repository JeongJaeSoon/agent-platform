import {
  type CheckpointRef,
  type TerminalTurnStatus,
  terminalTurnStatusSchema,
} from "@agent-platform/contracts";
import {
  type ClaimInput,
  type ClaimResult,
  type CommitEventsInput,
  type CommitEventsResult,
  type ConfirmExecutionGoneInput,
  type ConfirmExecutionGoneResult,
  type FenceRejection,
  type FinalizeInput,
  type FinalizeResult,
  type HeartbeatInput,
  type HeartbeatResult,
  type NextInputInput,
  type NextInputResult,
  payloadHash,
  type RegisterLaunchInput,
  type ReleaseInput,
  type ReleaseResult,
  type ResolvedCredential,
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
import type { Database } from "./queries.ts";
import {
  attempts,
  checkpoints,
  events,
  executions,
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
  workerCredentials,
  workerLaunches,
  workers,
} from "./schema.ts";

const ENDED_ATTEMPT_STATES = ["exited", "lost"];
const OPEN_TURN_STATUSES = ["running", "needs_input"];
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

function fencedAttempt(fence: WorkerFence, now: Date) {
  return and(ownedAttempt(fence), gt(attempts.leaseExpiresAt, now));
}

function expectFenced(rows: unknown[], what: string) {
  if (rows.length !== 1) {
    throw new Error(`Fenced ${what} write affected ${rows.length} rows`);
  }
}

type Fenced =
  | { outcome: "ok"; session: SessionRow; attempt: AttemptRow }
  | FenceRejection;

// Locks the session and attempt rows and classifies why the fence does not
// hold: an expired lease on the current epoch is LEASE_EXPIRED, anything
// else (bumped epoch, ended attempt, unknown binding) is STALE_EPOCH.
async function acquireFence(
  tx: Database,
  fence: WorkerFence,
  now: Date,
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
  if (attempt.leaseExpiresAt.getTime() <= now.getTime()) {
    return { outcome: "lease_expired" };
  }
  return { outcome: "ok", session, attempt };
}

function parseTurnId(turnId: string): number | null {
  if (!TURN_ID.test(turnId)) return null;
  const sequence = Number(turnId);
  return sequence <= SEQUENCE_MAX ? sequence : null;
}

function encodeEventCursor(id: number) {
  return `ev_${id.toString(36)}`;
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
      }
    : null;
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
    restore: await latestCheckpoint(tx, session.id),
  };
}

async function issueCredential(
  tx: Database,
  input: Pick<
    ClaimInput,
    "attemptId" | "credentialHash" | "credentialExpiresAt"
  >,
) {
  await tx.insert(workerCredentials).values({
    tokenHash: input.credentialHash,
    attemptId: input.attemptId,
    expiresAt: input.credentialExpiresAt,
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
          backend: input.backend,
          nonceHash: input.nonceHash,
          nonceExpiresAt: input.nonceExpiresAt,
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
        if (
          !launch ||
          launch.executionId !== input.executionId ||
          launch.generation !== input.executionGeneration ||
          // The backend already observed this execution end and took its slot
          // back, so a straggler must not claim a session with its nonce.
          launch.slotReleasedAt !== null ||
          // Applies to the replay path too: after the nonce lifetime the
          // bootstrap door is shut, and re-entering it would revoke the
          // session token of the worker that is still running.
          launch.nonceExpiresAt.getTime() <= input.now.getTime()
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
          await revokeCredentials(tx, bound.attempt.id, input.now);
          await issueCredential(tx, {
            attemptId: bound.attempt.id,
            credentialHash: input.credentialHash,
            credentialExpiresAt: input.credentialExpiresAt,
          });
          return {
            outcome: "replayed",
            binding: await bindingOf(tx, bound.session, bound.attempt),
          };
        }
        // Server-side selection: the worker never names a session. SKIP
        // LOCKED lets concurrent claims in one partition pick different
        // heads instead of serialising on the oldest signal.
        const [candidate] = await tx
          .select({ sessionId: unassignedSessions.sessionId })
          .from(unassignedSessions)
          .innerJoin(sessions, eq(sessions.id, unassignedSessions.sessionId))
          .where(
            and(
              eq(unassignedSessions.partition, launch.partition),
              isNull(sessions.podId),
              eq(sessions.admissionState, "active"),
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
            and(eq(sessions.id, candidate.sessionId), isNull(sessions.podId)),
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
            leaseExpiresAt: input.leaseExpiresAt,
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
      now: Date,
    ): Promise<ResolvedCredential> {
      const [session] = await db
        .select({ attemptId: attempts.id, sessionId: attempts.sessionId })
        .from(workerCredentials)
        .innerJoin(attempts, eq(attempts.id, workerCredentials.attemptId))
        .where(
          and(
            eq(workerCredentials.tokenHash, tokenHash),
            isNull(workerCredentials.revokedAt),
            gt(workerCredentials.expiresAt, now),
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
        const fenced = await acquireFence(tx, fence, now);
        if (fenced.outcome !== "ok") return fenced;
        const leaseExpiresAt = fenced.attempt.leaseExpiresAt;

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
        if (!head) return { outcome: "ok", input: null, leaseExpiresAt };
        const { message, turn } = head;

        // The head was delivered to an earlier attempt and never finalized:
        // its outcome is unknown, and only the reconciler (94S-139) may
        // decide; a fresh delivery here would re-run its side effects.
        const redelivery =
          turn.attemptId === fence.attemptId &&
          OPEN_TURN_STATUSES.includes(turn.status);
        if (turn.status !== "queued" && !redelivery) {
          return { outcome: "ok", input: null, leaseExpiresAt };
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
              .where(fencedAttempt(fence, now))
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
        const fenced = await acquireFence(tx, fence, now);
        if (fenced.outcome !== "ok") return fenced;
        const updated = await tx
          .update(attempts)
          .set({
            leaseExpiresAt: input.leaseExpiresAt,
            lastHeartbeatAt: now,
            state: input.attemptState,
          })
          .where(fencedAttempt(fence, now))
          .returning({ leaseExpiresAt: attempts.leaseExpiresAt });
        expectFenced(updated, "attempt");
        await tx
          .update(executions)
          .set({ observedAt: now, observedState: "running" })
          .where(eq(executions.id, fenced.attempt.executionId));
        // The legacy orphan reconciler keys on workers.last_seen by pod_id.
        await tx
          .insert(workers)
          .values({ podId: fenced.attempt.executionId, lastSeen: now })
          .onConflictDoUpdate({
            target: workers.podId,
            set: { lastSeen: now },
          });
        return {
          outcome: "ok",
          leaseExpiresAt: input.leaseExpiresAt,
          authRevision: fenced.session.authRevision,
        };
      });
    },

    commitEventsAtomic(input: CommitEventsInput): Promise<CommitEventsResult> {
      const { fence, now } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence, now);
        if (fenced.outcome !== "ok") return fenced;

        let turnRowId: number | null = null;
        if (input.turnId !== null) {
          const sequence = parseTurnId(input.turnId);
          // Only the turn this attempt is running: the fence alone would let
          // a live worker write history onto a queued or foreign turn.
          const [turn] = sequence
            ? await tx
                .select({ id: turns.id })
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
        }

        // (session_id, attempt_id, source_sequence) is unique, so a batch
        // the worker re-sends after a lost response inserts nothing.
        const inserted = await tx
          .insert(events)
          .values(
            input.events.map((event) => ({
              sessionId: fence.sessionId,
              type: event.event,
              payload: event.data,
              turnId: turnRowId,
              attemptId: fence.attemptId,
              sourceSequence: event.source_sequence,
              occurredAt: new Date(event.occurred_at),
            })),
          )
          .onConflictDoNothing()
          .returning({ sourceSequence: events.sourceSequence });
        // A sequence the insert skipped already exists. Saying "accepted"
        // while the stored event says something else would hand the worker a
        // cursor for data the stream does not contain.
        if (inserted.length !== input.events.length) {
          const kept = new Set(inserted.map((row) => row.sourceSequence));
          const replayed = input.events.filter(
            (event) => !kept.has(event.source_sequence),
          );
          const existing = await tx
            .select({
              type: events.type,
              payload: events.payload,
              sourceSequence: events.sourceSequence,
            })
            .from(events)
            .where(
              and(
                eq(events.sessionId, fence.sessionId),
                eq(events.attemptId, fence.attemptId),
                inArray(
                  events.sourceSequence,
                  replayed.map((event) => event.source_sequence),
                ),
              ),
            );
          const stored = new Map(
            existing.map((row) => [row.sourceSequence, row]),
          );
          for (const event of replayed) {
            const row = stored.get(event.source_sequence);
            if (
              !row ||
              row.type !== event.event ||
              payloadHash(row.payload) !== payloadHash(event.data)
            ) {
              return { outcome: "event_conflict" };
            }
          }
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
          acceptedThrough: Math.max(
            ...input.events.map((event) => event.source_sequence),
          ),
          cursor: encodeEventCursor(latest?.id ?? 0),
        };
      });
    },

    finalizeAtomic(input: FinalizeInput): Promise<FinalizeResult> {
      const { fence, now } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence, now);
        if (fenced.outcome !== "ok") return fenced;

        const sequence = parseTurnId(input.turnId);
        const [turn] = sequence
          ? await tx
              .select()
              .from(turns)
              .where(
                and(
                  eq(turns.sessionId, fence.sessionId),
                  eq(turns.sequence, sequence),
                ),
              )
              .limit(1)
              .for("update")
          : [];
        if (!turn || turn.attemptId !== fence.attemptId) {
          return { outcome: "turn_not_found" };
        }
        const terminalHash = payloadHash(input.terminal);
        const stored = (turn.resultJson ?? {}) as {
          finalize_key?: unknown;
          finalize_hash?: unknown;
        };
        if (!OPEN_TURN_STATUSES.includes(turn.status)) {
          // A replay carries the same key and the same body; anything else
          // would report a terminal the stored turn does not have.
          if (
            stored.finalize_key !== input.finalizeKey ||
            stored.finalize_hash !== terminalHash
          ) {
            return { outcome: "finalize_conflict" };
          }
          const [checkpoint] = await tx
            .select({ revision: max(checkpoints.revision) })
            .from(checkpoints)
            .where(eq(checkpoints.turnId, turn.id));
          return {
            outcome: "replayed",
            result: {
              turnId: input.turnId,
              status: workerTerminalSchema.parse(turn.status),
              checkpointRevision: checkpoint?.revision ?? null,
            },
          };
        }

        let checkpointRevision: number | null = null;
        if (input.checkpoint) {
          const current = fenced.session.checkpointRevision ?? -1;
          if (input.checkpoint.revision <= current) {
            return {
              outcome: "checkpoint_rejected",
              reason: `revision ${input.checkpoint.revision} is not above ${current}`,
            };
          }
          await tx.insert(checkpoints).values({
            sessionId: fence.sessionId,
            revision: input.checkpoint.revision,
            manifestRef: input.checkpoint.manifest_ref,
            manifestSha256: input.checkpoint.manifest_sha256,
            turnId: turn.id,
            committedAt: now,
          });
          checkpointRevision = input.checkpoint.revision;
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
          .returning({ id: turns.id });
        expectFenced([terminal].filter(Boolean), "turn");

        const receiptStatus = RECEIPT_STATUS_BY_TERMINAL[input.terminal.status];
        const succeeded = receiptStatus === "succeeded";
        await tx
          .update(receipts)
          .set({
            status: receiptStatus,
            result: succeeded
              ? { turn_id: input.turnId, status: input.terminal.status }
              : null,
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
              ...(checkpointRevision === null
                ? {}
                : { checkpointRevision, checkpointCommittedAt: now }),
            })
            .where(fencedSession(fence))
            .returning({ id: sessions.id }),
          "session",
        );
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

    releaseAtomic(input: ReleaseInput): Promise<ReleaseResult> {
      const { fence, now } = input;
      return db.transaction(async (tx) => {
        // An expired lease on the current epoch may still release: the
        // worker is giving the binding up, which only advances the fence.
        // A superseded epoch cannot; that binding is not its to release.
        const fenced = await acquireFence(tx, fence, now);
        if (fenced.outcome === "stale_epoch") return { released: false };
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
        return { released: true };
      });
    },

    confirmExecutionGoneAtomic(
      input: ConfirmExecutionGoneInput,
    ): Promise<ConfirmExecutionGoneResult> {
      const { executionId, now } = input;
      return db.transaction(async (tx) => {
        const [launch] = await tx
          .select({ partition: workerLaunches.partition })
          .from(workerLaunches)
          .where(eq(workerLaunches.executionId, executionId))
          .limit(1)
          .for("update");
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
        await tx
          .update(executions)
          .set({
            observedState: "terminated",
            desiredState: "terminated",
            observedAt: now,
          })
          .where(eq(executions.id, executionId));
        await tx.delete(workers).where(eq(workers.podId, executionId));

        const [session] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.executionId, executionId))
          .limit(1)
          .for("update");
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
        await tx
          .update(sessions)
          .set({
            podId: null,
            executionId: null,
            leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
            updatedAt: now,
          })
          .where(eq(sessions.id, session.id));

        // Re-signal only when nothing delivered is left unresolved: a turn
        // that started but never finalized is outcome-unknown and must not
        // be re-run by the next claim (94S-139 decides it).
        const [queuedRow] = await tx
          .select({ queued: count() })
          .from(turns)
          .where(
            and(eq(turns.sessionId, session.id), eq(turns.status, "queued")),
          );
        const [unknownRow] = await tx
          .select({ unknown: count() })
          .from(turns)
          .where(
            and(
              eq(turns.sessionId, session.id),
              inArray(turns.status, OPEN_TURN_STATUSES),
            ),
          );
        const queued = queuedRow?.queued ?? 0;
        const unknown = unknownRow?.unknown ?? 0;
        if (
          queued > 0 &&
          unknown === 0 &&
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
