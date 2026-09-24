import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WorkerScope } from "@agent-platform/contracts";
import {
  type CheckpointProtocol,
  createWorkerGateway,
  type SessionCatalog,
  type WorkerGateway,
  WorkerGatewayError,
  type WorkerPrincipal,
} from "@agent-platform/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@agent-platform/testkit/postgres";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import { createPostgresWorkerPendingStore } from "./pending-control.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import { RESTORE_FAILURE_LIMIT } from "./restore-failures.ts";
import { createPostgresSchedulerStore } from "./scheduler-store.ts";
import * as schema from "./schema.ts";
import { events, sessions, turns, unassignedSessions } from "./schema.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const bootstrap: WorkerPrincipal = { kind: "bootstrap" };
const MANIFEST_SHA = "c".repeat(64);
const FINGERPRINT = {
  engine: "claude",
  sdk_version: "0.3.270",
  cli_version: "2.1.270",
  profile_sha256: "d".repeat(64),
};

const SPEC = {
  image: "sha256:worker",
  resources: { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 256 },
};

const catalog: SessionCatalog = {
  profiles: {
    "claude-coding-v1": {
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read", "Edit", "Bash"],
      permission_mode: "default",
      provider: {
        kind: "litellm",
        endpoint: "https://litellm.invalid",
        auth: {
          kind: "api_key",
          value: "catalog-provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
    },
  },
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: ["claude-coding-v1"],
    },
  },
};

integration(
  "restore failures before ready on PostgreSQL (94S-345)",
  () => {
    let database: TempDatabase;
    let pool: Pool;
    let db: NodePgDatabase<typeof schema>;
    let gateway: WorkerGateway;

    beforeAll(async () => {
      database = await createTempDatabase({ prefix: "restore_fail_it" });
      pool = new Pool({ connectionString: database.url, max: 12 });
      db = drizzle(pool, { schema });
      gateway = createWorkerGateway({
        work: createPostgresWorkerUnitOfWork(db),
        catalog,
        checkpoints: {
          async verify() {
            return { status: "verified" };
          },
        },
        checkpointProtocol: {
          async requestCheckpoint() {
            throw new Error("not used");
          },
          async getRestorePlan() {
            throw new Error("not used");
          },
        },
        pending: createPostgresWorkerPendingStore(db),
        options: {
          sessionCostLimitUsd: 1_000,
          leaseTtlMs: 60_000,
          sleep: async () => {},
        },
      });
    }, 60_000);

    afterAll(async () => {
      await pool.end();
      await database.drop();
    }, 60_000);

    const controls = () => createPostgresSessionControl(db);
    const inputs = () => createPostgresSessionUnitOfWork(db);
    const reader = () => createPostgresSessionReader(db);
    const scheduler = () =>
      createPostgresSchedulerStore(db, {
        connectForLock: () => pool.connect(),
        sessionCostLimitUsd: 1_000,
      });

    type Worker = {
      principal: WorkerPrincipal;
      scope: WorkerScope;
      executionId: string;
    };
    type Session = { sessionId: string; ownerId: string; partition: string };

    async function newSession(name: string): Promise<Session> {
      const partition = `${name}-${crypto.randomUUID()}`;
      const ownerId = `owner-${crypto.randomUUID()}`;
      const accepted = await inputs().acceptInputAtomic({
        principal: { ownerId },
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        profileId: "claude-coding-v1",
        repository: {
          id: "sample-app",
          url: "https://example.invalid/app.git",
          branch: "main",
        },
        message: "first input",
        limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      });
      if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
      const sessionId = accepted.response.session_id;
      await db
        .update(unassignedSessions)
        .set({ partition })
        .where(eq(unassignedSessions.sessionId, sessionId));
      return { sessionId, ownerId, partition };
    }

    function workerOf(
      claimed: Awaited<ReturnType<WorkerGateway["bootstrapClaim"]>>,
      executionId: string,
    ): Worker {
      return {
        principal: {
          kind: "session",
          attemptId: claimed.attempt_id,
          sessionId: claimed.session_id,
          leaseEpoch: claimed.lease_epoch,
          executionGeneration: claimed.execution_generation,
          authRevision: claimed.auth_revision,
        },
        scope: {
          session_id: claimed.session_id,
          turn_id: null,
          attempt_id: claimed.attempt_id,
          lease_epoch: claimed.lease_epoch,
          execution_generation: claimed.execution_generation,
          auth_revision: claimed.auth_revision,
        },
        executionId,
      };
    }

    // The scheduler's own path: demand, reservation, nonce, claim.
    async function claimReserved(session: Session) {
      const store = scheduler();
      const demand = await store.inspectDemand({ limit: 1_000 });
      expect(demand.eligibleSessionIds).toContain(session.sessionId);
      const intent = await store.reserveLaunch({
        ...SPEC,
        backend: "local_docker",
        now: new Date(),
        sessionId: session.sessionId,
        slotLimit: 1_000,
      });
      if (!intent) throw new Error("no reservation");
      const nonce = await store.issueBootstrapNonce({
        executionId: intent.executionId,
        generation: intent.generation,
      });
      const claimed = await gateway.bootstrapClaim(bootstrap, {
        execution_id: intent.executionId,
        execution_generation: intent.generation,
        credential: { kind: "launch_nonce", nonce },
      });
      expect(claimed.session_id).toBe(session.sessionId);
      return { worker: workerOf(claimed, intent.executionId), claimed };
    }

    async function launchable(session: Session): Promise<boolean> {
      const demand = await scheduler().inspectDemand({ limit: 1_000 });
      return demand.eligibleSessionIds.includes(session.sessionId);
    }

    async function sessionRow(id: string) {
      const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
      if (!row) throw new Error("session vanished");
      return row;
    }

    async function queuedTurns(sessionId: string) {
      return (
        await db
          .select({ status: turns.status })
          .from(turns)
          .where(eq(turns.sessionId, sessionId))
          .orderBy(asc(turns.sequence))
      ).filter(({ status }) => status === "queued").length;
    }

    async function systemEvents(sessionId: string, subtype: string) {
      const rows = await db
        .select({ payload: events.payload })
        .from(events)
        .where(eq(events.sessionId, sessionId))
        .orderBy(asc(events.id));
      return rows
        .map(({ payload }) => payload as Record<string, unknown>)
        .filter((payload) => payload.subtype === subtype);
    }

    /** The backoff the last failure started, spent on the database clock. */
    async function spendBackoff(session: Session) {
      await db
        .update(sessions)
        .set({ restoreRetryAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(sessions.id, session.sessionId));
    }

    /**
     * Turn 1 ran and committed checkpoint 0 and its worker went idle; a
     * second input now waits for a worker that has to restore checkpoint 0.
     */
    async function checkpointedSession(name: string): Promise<Session> {
      const session = await newSession(name);
      const { worker } = await claimReserved(session);
      const next = await gateway.nextInput(worker.principal, worker.scope);
      if (!next.input) throw new Error("no input delivered");
      await gateway.finalize(worker.principal, {
        ...worker.scope,
        turn_id: next.input.turn_id,
        finalize_key: `${worker.scope.attempt_id}:${next.input.turn_id}`,
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: {
          revision: 0,
          manifest_ref: `manifests/${session.sessionId}/0`,
          manifest_sha256: MANIFEST_SHA,
        },
      });
      await gateway.release(worker.principal, {
        ...worker.scope,
        reason: "idle",
      });
      await gateway.confirmExecutionGone(worker.executionId);
      const appended = await inputs().appendInputAtomic({
        principal: { ownerId: session.ownerId },
        sessionId: session.sessionId,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        message: "second input needs the restore",
        limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      });
      expect(appended.outcome).toBe("accepted");
      expect((await sessionRow(session.sessionId)).restoreAttemptId).toBeNull();
      return session;
    }

    const REFUSED =
      "Checkpoint restore refused (CHECKPOINT_UNAVAILABLE): manifests/x/0 arrived damaged: it fails the store's own checksum";

    /** A worker claims with the restore, fails it, releases, and is seen gone. */
    async function failRestore(session: Session, release = true) {
      const { worker, claimed } = await claimReserved(session);
      expect(claimed.restore?.revision).toBe(0);
      expect((await sessionRow(session.sessionId)).restoreAttemptId).toBe(
        claimed.attempt_id,
      );
      if (release) {
        await gateway.release(worker.principal, {
          ...worker.scope,
          reason: REFUSED,
        });
      }
      await gateway.confirmExecutionGone(worker.executionId);
      return claimed;
    }

    test("counts restores that end before ready, backs off between them, and holds the session for an operator at the limit", async () => {
      const session = await checkpointedSession("limit");
      const start = (await sessionRow(session.sessionId)).executionGeneration;

      const first = await failRestore(session);
      const backingOff = await sessionRow(session.sessionId);
      expect(backingOff.admissionState).toBe("active");
      expect(backingOff.restoreFailureCount).toBe(1);
      expect(backingOff.restoreFailureReason).toBe(REFUSED);
      expect(backingOff.restoreAttemptId).toBeNull();
      // 94S-207's first backoff, on the database clock.
      const [clock] = await db
        .execute<{ now: string }>(sql`SELECT clock_timestamp()::text AS now`)
        .then((result) => result.rows);
      const wait =
        (backingOff.restoreRetryAt?.getTime() ?? 0) -
        new Date(String(clock?.now)).getTime();
      expect(wait).toBeGreaterThan(25_000);
      expect(wait).toBeLessThanOrEqual(30_000);
      // Signalled again, but no launch until the backoff ends.
      expect(
        await db
          .select()
          .from(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, session.sessionId)),
      ).toHaveLength(1);
      expect(await launchable(session)).toBe(false);
      expect(
        await scheduler().reserveLaunch({
          ...SPEC,
          backend: "local_docker",
          now: new Date(),
          sessionId: session.sessionId,
          slotLimit: 1_000,
        }),
      ).toBeNull();
      const detail = await reader().getSession(
        session.ownerId,
        session.sessionId,
      );
      expect(detail?.attention).toEqual({
        code: "RESTORE_FAILED",
        reason: REFUSED,
        failures: 1,
        retry_at: backingOff.restoreRetryAt?.toISOString() ?? null,
      });

      for (let failures = 2; failures < RESTORE_FAILURE_LIMIT; failures++) {
        await spendBackoff(session);
        await failRestore(session);
        const row = await sessionRow(session.sessionId);
        expect(row.admissionState).toBe("active");
        expect(row.restoreFailureCount).toBe(failures);
        expect(await launchable(session)).toBe(false);
      }

      // The last allowed one fails too, this time without releasing: a
      // worker killed in the middle of its restore counts the same.
      await spendBackoff(session);
      await failRestore(session, false);
      const held = await sessionRow(session.sessionId);
      expect(held.admissionState).toBe("recovery_required");
      expect(held.status).toBe("failed");
      expect(held.restoreFailureCount).toBe(RESTORE_FAILURE_LIMIT);
      expect(held.restoreFailureReason).toBe("execution_gone");
      expect(held.restoreRetryAt).toBeNull();
      // One generation per allowed restore, and none after.
      expect(held.executionGeneration).toBe(start + RESTORE_FAILURE_LIMIT);
      expect(await launchable(session)).toBe(false);
      expect(
        await db
          .select()
          .from(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, session.sessionId)),
      ).toHaveLength(0);
      // The input is kept for whatever the operator decides.
      expect(await queuedTurns(session.sessionId)).toBe(1);
      expect(
        (await reader().getSession(session.ownerId, session.sessionId))
          ?.attention,
      ).toEqual({
        code: "RESTORE_FAILED",
        reason: "execution_gone",
        failures: RESTORE_FAILURE_LIMIT,
        retry_at: null,
      });
      const failed = await systemEvents(
        session.sessionId,
        "checkpoint_restore_failed",
      );
      expect(failed.map(({ failures }) => failures)).toEqual([1, 2, 3]);
      expect(failed[0]).toMatchObject({
        checkpoint_revision: 0,
        limit: RESTORE_FAILURE_LIMIT,
        reason: REFUSED,
      });
      expect(failed.at(-1)?.retry_at).toBeNull();
      expect(first.attempt_id).not.toBe(held.restoreAttemptId);

      // start_fresh goes on without the checkpoint, and the count with it.
      const decided = await controls().decideRecoveryAtomic({
        principal: { ownerId: session.ownerId },
        sessionId: session.sessionId,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        decision: {
          decision: "start_fresh",
          expected_revision: held.revision,
          reason: "the checkpoint keeps failing to restore",
        },
        now: new Date(),
      });
      expect(decided.outcome).toBe("accepted");
      const fresh = await sessionRow(session.sessionId);
      expect(fresh.admissionState).toBe("active");
      expect(fresh.restoreFailureCount).toBe(0);
      expect(fresh.restoreFailureReason).toBeNull();
      expect(await launchable(session)).toBe(true);
      const { claimed } = await claimReserved(session);
      expect(claimed.restore).toBeNull();
      expect((await sessionRow(session.sessionId)).restoreAttemptId).toBeNull();
    });

    test("a restore reported ready clears the count, and its later exit is not a restore failure", async () => {
      const session = await checkpointedSession("ready");
      await failRestore(session);
      await spendBackoff(session);

      const { worker } = await claimReserved(session);
      // Not the revision it was handed: proves nothing.
      await gateway.ready(worker.principal, {
        ...worker.scope,
        restored_revision: null,
      });
      expect((await sessionRow(session.sessionId)).restoreFailureCount).toBe(1);

      expect(
        await gateway.ready(worker.principal, {
          ...worker.scope,
          restored_revision: 0,
        }),
      ).toEqual({ activated: false });
      const ready = await sessionRow(session.sessionId);
      expect(ready.restoreFailureCount).toBe(0);
      expect(ready.restoreRetryAt).toBeNull();
      expect(ready.restoreFailureReason).toBeNull();
      expect(ready.restoreAttemptId).toBeNull();
      expect(
        (await reader().getSession(session.ownerId, session.sessionId))
          ?.attention,
      ).toBeNull();

      await gateway.release(worker.principal, {
        ...worker.scope,
        reason: "drain",
      });
      await gateway.confirmExecutionGone(worker.executionId);
      const after = await sessionRow(session.sessionId);
      expect(after.restoreFailureCount).toBe(0);
      expect(after.restoreRetryAt).toBeNull();
      expect(await launchable(session)).toBe(true);
    });

    test("a claim with nothing to restore is never counted", async () => {
      const session = await newSession("fresh");
      const { worker, claimed } = await claimReserved(session);
      expect(claimed.restore).toBeNull();
      await gateway.release(worker.principal, {
        ...worker.scope,
        reason: "workspace clone failed",
      });
      await gateway.confirmExecutionGone(worker.executionId);
      const row = await sessionRow(session.sessionId);
      expect(row.restoreFailureCount).toBe(0);
      expect(await launchable(session)).toBe(true);
    });
  },
  120_000,
);
