import { randomUUID } from "node:crypto";
import {
  type ExecutionBackend as ExecutionBackendKind,
  executionBackendSchema,
} from "@agent-platform/contracts";
import type {
  ActiveExecution,
  ExecutionObservation,
  ExecutionRef,
  ReserveLaunchInput,
  SchedulerDemand,
  SchedulerStore,
  StoredLaunchIntent,
} from "@agent-platform/platform";
import {
  DEFAULT_NONCE_TTL_MS,
  generateLaunchNonce,
  hashWorkerToken,
} from "@agent-platform/platform";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  max,
  notExists,
  sql,
} from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  executions,
  sessions,
  unassignedSessions,
  workerLaunches,
} from "./schema.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

/** A connection the pass lock can live on for as long as the pass runs. */
export type PassLockClient = {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(): void;
};

export type PostgresSchedulerStoreOptions = {
  /**
   * Hands out a dedicated client for the session-level advisory lock; the
   * pool's regular clients would return the lock to the pool with them.
   */
  connectForLock: () => Promise<PassLockClient>;
  /** Lifetime of a bootstrap nonce; matches the gateway's own default. */
  nonceTtlMs?: number;
};

const PASS_LOCK_KEY = "scheduler:pass";

const DESIRED_RUNNING = "running";

/**
 * The one ledger. A launch holds its slot — and its session — from the
 * moment it is reserved until `confirmExecutionGone` hands both back, so
 * nothing else gets to count capacity.
 */
function holdsSlot() {
  return isNull(workerLaunches.slotReleasedAt);
}

export function createPostgresSchedulerStore(
  db: Database,
  options: PostgresSchedulerStoreOptions,
): SchedulerStore {
  const nonceTtlMs = options.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS;
  const work = createPostgresWorkerUnitOfWork(db);
  return {
    async acquirePassLock() {
      const client = await options.connectForLock();
      try {
        const result = await client.query(
          `SELECT pg_try_advisory_lock(hashtext('${PASS_LOCK_KEY}')) AS locked`,
        );
        if (result.rows[0]?.locked !== true) {
          client.release();
          return null;
        }
      } catch (error) {
        client.release();
        throw error;
      }
      return async () => {
        try {
          await client.query(
            `SELECT pg_advisory_unlock(hashtext('${PASS_LOCK_KEY}'))`,
          );
        } finally {
          client.release();
        }
      };
    },

    async inspectDemand({ limit }): Promise<SchedulerDemand> {
      const [active] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(workerLaunches)
        .where(holdsSlot());
      if (limit <= 0) {
        return {
          activeExecutionCount: active?.count ?? 0,
          eligibleSessionIds: [],
        };
      }
      const eligible = await db
        .select({ sessionId: unassignedSessions.sessionId })
        .from(unassignedSessions)
        .innerJoin(sessions, eq(sessions.id, unassignedSessions.sessionId))
        .where(
          and(
            eq(sessions.admissionState, "active"),
            notExists(
              db
                .select({ one: sql`1` })
                .from(workerLaunches)
                .where(
                  and(eq(workerLaunches.sessionId, sessions.id), holdsSlot()),
                ),
            ),
          ),
        )
        .orderBy(
          asc(unassignedSessions.signaledAt),
          asc(unassignedSessions.sessionId),
        )
        .limit(limit);
      return {
        activeExecutionCount: active?.count ?? 0,
        eligibleSessionIds: eligible.map((row) => row.sessionId),
      };
    },

    async reserveLaunch(
      input: ReserveLaunchInput,
    ): Promise<StoredLaunchIntent | null> {
      return db.transaction(async (tx) => {
        // One advisory lock serializes every reservation so the capacity
        // check below cannot be raced by another scheduler pass; the session
        // row lock then covers the per-session checks.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('executions:reserve_launch'))`,
        );
        const [capacity] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(workerLaunches)
          .where(holdsSlot());
        if ((capacity?.count ?? 0) >= input.slotLimit) return null;
        const [session] = await tx
          .select({ admissionState: sessions.admissionState })
          .from(sessions)
          .where(eq(sessions.id, input.sessionId))
          .limit(1)
          .for("update");
        if (!session || session.admissionState !== "active") return null;
        const [signal] = await tx
          .select({ partition: unassignedSessions.partition })
          .from(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, input.sessionId))
          .limit(1);
        if (!signal) return null;
        const [open] = await tx
          .select({ executionId: workerLaunches.executionId })
          .from(workerLaunches)
          .where(
            and(eq(workerLaunches.sessionId, input.sessionId), holdsSlot()),
          )
          .limit(1);
        if (open) return null;
        // Generations are per session and every reservation writes both rows
        // together, so the executions history is the whole of it.
        const [latest] = await tx
          .select({ generation: max(executions.generation) })
          .from(executions)
          .where(eq(executions.sessionId, input.sessionId));
        const intent: StoredLaunchIntent = {
          executionId: `exec-${randomUUID()}`,
          generation: (latest?.generation ?? 0) + 1,
          operationId: randomUUID(),
          sessionId: input.sessionId,
        };
        await tx.insert(executions).values({
          backend: input.backend,
          createdAt: input.now,
          desiredState: DESIRED_RUNNING,
          generation: intent.generation,
          id: intent.executionId,
          launchOperationId: intent.operationId,
          observedState: "pending",
          sessionId: intent.sessionId,
        });
        // The launch is registered in the same transaction that takes the
        // slot: there is no window where capacity is spent but the worker
        // that spends it could not claim. The nonce columns stay null until
        // a container is actually created for this launch.
        await tx.insert(workerLaunches).values({
          backend: input.backend,
          createdAt: input.now,
          executionId: intent.executionId,
          generation: intent.generation,
          // The claim has to find the session where it is waiting.
          partition: signal.partition,
          sessionId: intent.sessionId,
          slotReservedAt: input.now,
        });
        await tx
          .update(sessions)
          .set({ executionId: intent.executionId, updatedAt: input.now })
          .where(eq(sessions.id, input.sessionId));
        return intent;
      });
    },

    async issueBootstrapNonce(ref: ExecutionRef, now: Date): Promise<string> {
      const nonce = generateLaunchNonce();
      const rotated = await db
        .update(workerLaunches)
        .set({
          nonceHash: hashWorkerToken(nonce),
          nonceExpiresAt: new Date(now.getTime() + nonceTtlMs),
        })
        .where(
          and(
            eq(workerLaunches.executionId, ref.executionId),
            eq(workerLaunches.generation, ref.generation),
            // Issuing invalidates whatever this launch held before, so it is
            // refused once a worker has traded the nonce for a binding or
            // the slot has gone back.
            isNull(workerLaunches.claimedAttemptId),
            holdsSlot(),
          ),
        )
        .returning({ executionId: workerLaunches.executionId });
      if (rotated.length !== 1) {
        throw new Error(
          `Launch ${ref.executionId} generation ${ref.generation} is claimed, released or unknown; no bootstrap credential was issued`,
        );
      }
      return nonce;
    },

    async listActiveExecutions(backend): Promise<ActiveExecution[]> {
      const rows = await db
        .select({
          backend: workerLaunches.backend,
          claimedAttemptId: workerLaunches.claimedAttemptId,
          executionId: workerLaunches.executionId,
          generation: workerLaunches.generation,
          observedState: executions.observedState,
          operationId: executions.launchOperationId,
          providerRef: executions.providerRef,
          sessionId: executions.sessionId,
        })
        .from(workerLaunches)
        // A launch with no execution row has not been claimed and was not
        // reserved here; whoever registered it owns its resource.
        .innerJoin(executions, eq(executions.id, workerLaunches.executionId))
        .where(and(holdsSlot(), eq(workerLaunches.backend, backend)))
        .orderBy(asc(workerLaunches.slotReservedAt), asc(executions.id));
      // Rows written before the intent columns existed come back with a null
      // operation id; the scheduler closes them out rather than relaunching.
      return rows.map((row) => ({
        backend: backendKindOf(row.backend),
        claimed: row.claimedAttemptId !== null,
        executionId: row.executionId,
        generation: row.generation,
        observedState: observedStateOf(row.observedState),
        operationId: row.operationId,
        providerRef: row.providerRef,
        sessionId: row.sessionId,
      }));
    },

    async filterKnown(refs, backend): Promise<ExecutionRef[]> {
      if (refs.length === 0) return [];
      const rows = await db
        .select({
          executionId: workerLaunches.executionId,
          generation: workerLaunches.generation,
        })
        .from(workerLaunches)
        .where(
          and(
            inArray(
              workerLaunches.executionId,
              refs.map((ref) => ref.executionId),
            ),
            holdsSlot(),
            eq(workerLaunches.backend, backend),
          ),
        );
      const generations = new Map(
        rows.map((r) => [r.executionId, r.generation]),
      );
      return refs.filter(
        (ref) => generations.get(ref.executionId) === ref.generation,
      );
    },

    async recordObservation(
      ref: ExecutionRef,
      observation: ExecutionObservation,
    ): Promise<void> {
      await db
        .update(executions)
        .set({
          observedAt: observation.observedAt,
          observedState: observation.state,
          ...(observation.providerRef === null
            ? {}
            : { providerRef: observation.providerRef }),
        })
        .where(
          and(
            eq(executions.id, ref.executionId),
            eq(executions.generation, ref.generation),
          ),
        );
    },

    async confirmExecutionGone(executionId: string, now: Date): Promise<void> {
      await work.confirmExecutionGoneAtomic({ executionId, now });
    },
  };
}

const OBSERVED_STATES = new Set<ExecutionObservation["state"]>([
  "pending",
  "running",
  "suspended",
  "terminating",
  "terminated",
  "unknown",
]);

function backendKindOf(value: string): ExecutionBackendKind {
  const parsed = executionBackendSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`worker_launches.backend holds unknown value ${value}`);
  }
  return parsed.data;
}

function observedStateOf(value: string): ExecutionObservation["state"] {
  return OBSERVED_STATES.has(value as ExecutionObservation["state"])
    ? (value as ExecutionObservation["state"])
    : "unknown";
}
