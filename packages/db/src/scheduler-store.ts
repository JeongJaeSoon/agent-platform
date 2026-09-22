import { randomBytes, randomUUID } from "node:crypto";
import type {
  ActiveExecution,
  ExecutionObservation,
  ExecutionRef,
  ReserveLaunchInput,
  SchedulerDemand,
  SchedulerStore,
  StoredLaunchIntent,
} from "@agent-platform/platform";
import { and, asc, eq, inArray, max, ne, notExists, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { executions, sessions, unassignedSessions } from "./schema.ts";

const DESIRED_RUNNING = "running";
const OBSERVED_TERMINATED = "terminated";

/** A row still counts against the slot limit until it is seen terminated. */
function isLive() {
  return and(
    eq(executions.desiredState, DESIRED_RUNNING),
    ne(executions.observedState, OBSERVED_TERMINATED),
  );
}

export function createPostgresSchedulerStore(db: Database): SchedulerStore {
  return {
    async inspectDemand({ limit }): Promise<SchedulerDemand> {
      const [active] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(executions)
        .where(isLive());
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
                .from(executions)
                .where(and(eq(executions.sessionId, sessions.id), isLive())),
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
        // The session row lock serializes concurrent schedulers for one
        // session; everything below re-checks eligibility under it.
        const [session] = await tx
          .select({ admissionState: sessions.admissionState })
          .from(sessions)
          .where(eq(sessions.id, input.sessionId))
          .limit(1)
          .for("update");
        if (!session || session.admissionState !== "active") return null;
        const [signal] = await tx
          .select({ sessionId: unassignedSessions.sessionId })
          .from(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, input.sessionId))
          .limit(1);
        if (!signal) return null;
        const [live] = await tx
          .select({ id: executions.id })
          .from(executions)
          .where(and(eq(executions.sessionId, input.sessionId), isLive()))
          .limit(1);
        if (live) return null;
        const [latest] = await tx
          .select({ generation: max(executions.generation) })
          .from(executions)
          .where(eq(executions.sessionId, input.sessionId));
        const intent: StoredLaunchIntent = {
          bootstrapNonce: randomBytes(32).toString("base64url"),
          executionId: `exec-${randomUUID()}`,
          generation: (latest?.generation ?? 0) + 1,
          operationId: randomUUID(),
          sessionId: input.sessionId,
        };
        await tx.insert(executions).values({
          backend: input.backend,
          bootstrapNonce: intent.bootstrapNonce,
          createdAt: input.now,
          desiredState: DESIRED_RUNNING,
          generation: intent.generation,
          id: intent.executionId,
          launchOperationId: intent.operationId,
          observedState: "pending",
          sessionId: intent.sessionId,
        });
        await tx
          .update(sessions)
          .set({ executionId: intent.executionId, updatedAt: input.now })
          .where(eq(sessions.id, input.sessionId));
        return intent;
      });
    },

    async listActiveExecutions(): Promise<ActiveExecution[]> {
      const rows = await db
        .select({
          bootstrapNonce: executions.bootstrapNonce,
          executionId: executions.id,
          generation: executions.generation,
          observedState: executions.observedState,
          operationId: executions.launchOperationId,
          providerRef: executions.providerRef,
          sessionId: executions.sessionId,
        })
        .from(executions)
        .where(isLive())
        .orderBy(asc(executions.createdAt), asc(executions.id));
      const active: ActiveExecution[] = [];
      for (const row of rows) {
        // Rows written by other backends (or before this column existed)
        // carry no intent this scheduler could relaunch; they still count as
        // live via inspectDemand but are not reconciled here.
        if (row.operationId === null || row.bootstrapNonce === null) continue;
        active.push({
          bootstrapNonce: row.bootstrapNonce,
          executionId: row.executionId,
          generation: row.generation,
          observedState: observedStateOf(row.observedState),
          operationId: row.operationId,
          providerRef: row.providerRef,
          sessionId: row.sessionId,
        });
      }
      return active;
    },

    async filterKnown(refs: ExecutionRef[]): Promise<ExecutionRef[]> {
      if (refs.length === 0) return [];
      const rows = await db
        .select({ id: executions.id, generation: executions.generation })
        .from(executions)
        .where(
          inArray(
            executions.id,
            refs.map((ref) => ref.executionId),
          ),
        );
      const generations = new Map(rows.map((r) => [r.id, r.generation]));
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

function observedStateOf(value: string): ExecutionObservation["state"] {
  return OBSERVED_STATES.has(value as ExecutionObservation["state"])
    ? (value as ExecutionObservation["state"])
    : "unknown";
}
