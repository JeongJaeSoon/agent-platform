import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type ClaimResult,
  type EnsureExecutionResult,
  type ExecutionBackend,
  type ExecutionObservation,
  type ExecutionRef,
  hashWorkerToken,
  type LaunchIntent,
  type ManagedExecution,
  type RunnablePair,
  runScheduler,
  type TerminateExecutionResult,
} from "@agent-platform/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@agent-platform/testkit/postgres";
import { and, asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import { createPostgresSchedulerStore } from "./scheduler-store.ts";
import * as schema from "./schema.ts";
import {
  events,
  executions,
  receipts,
  sessions,
  turns,
  unassignedSessions,
  workerLaunches,
} from "./schema.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const LIMITS = { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 };
const PROFILE_ID = "claude-coding-v1";
const REGISTERED = "https://example.invalid/app.git";
const MOVED_TO = "https://moved.invalid/app.git";
const RESOURCES = { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 64 };

const pairAt = (url: string): RunnablePair => ({
  profileId: PROFILE_ID,
  profileFingerprint: `sha256:${"a".repeat(64)}`,
  repositoryId: "sample-app",
  url,
  branch: "main",
});

/**
 * A daemon whose containers claim once started (`startWorkers`, between
 * passes), against the gateway's catalog as it stands: what a real worker
 * does first, minus the process around it.
 */
class ClaimingBackend implements ExecutionBackend {
  readonly kind = "local_docker" as const;
  readonly running = new Map<string, ManagedExecution>();
  readonly claims: Array<{
    sessionId: string;
    outcome: ClaimResult["outcome"];
  }> = [];
  runnable: RunnablePair[] = [pairAt(REGISTERED)];
  private readonly starting: Array<{ intent: LaunchIntent; nonce: string }> =
    [];

  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  capabilities() {
    return { suspend: false };
  }

  async resolveImage(reference: string): Promise<string> {
    return reference;
  }

  async ensureExecution(intent: LaunchIntent): Promise<EnsureExecutionResult> {
    const nonce = await intent.issueBootstrapNonce();
    const providerRef = `ctr-${intent.executionId}`;
    this.running.set(intent.executionId, {
      executionId: intent.executionId,
      generation: intent.generation,
      providerRef,
      sessionId: intent.sessionId,
      state: "running",
    });
    this.starting.push({ intent, nonce });
    return { created: true, providerRef, state: "running" };
  }

  async startWorkers(): Promise<void> {
    for (const { intent, nonce } of this.starting.splice(0)) {
      const result = await createPostgresWorkerUnitOfWork(this.db).claimAtomic({
        catalogRevision: "catalog-under-test",
        runnable: this.runnable,
        costLimitUsd: 1_000,
        nonceHash: hashWorkerToken(nonce),
        executionId: intent.executionId,
        executionGeneration: intent.generation,
        attemptId: `att_${randomUUID()}`,
        credentialHash: hashWorkerToken(`tok-${randomUUID()}`),
        credentialTtlMs: 60_000,
        egress: {
          providerHash: hashWorkerToken(`wep-${randomUUID()}`),
          repositoryHash: hashWorkerToken(`wer-${randomUUID()}`),
          objectStoreHash: hashWorkerToken(`weo-${randomUUID()}`),
          bindingsOf: () => ({
            provider: "provider",
            repository: "repository",
            object_store: "sessions/s/",
          }),
        },
        leaseTtlMs: 60_000,
        now: new Date(),
      });
      this.claims.push({
        sessionId: intent.sessionId,
        outcome: result.outcome,
      });
    }
  }

  async inspect(ref: ExecutionRef): Promise<ExecutionObservation> {
    const found = this.running.get(ref.executionId);
    return found
      ? {
          found: true,
          observedAt: new Date(),
          providerRef: found.providerRef,
          state: "running",
        }
      : {
          found: false,
          observedAt: new Date(),
          providerRef: null,
          state: "unknown",
        };
  }

  async listManaged(): Promise<ManagedExecution[]> {
    return [...this.running.values()];
  }

  async terminate(ref: ExecutionRef): Promise<TerminateExecutionResult> {
    const found = this.running.get(ref.executionId);
    if (!found) return { outcome: "absent" };
    this.running.delete(ref.executionId);
    return { outcome: "terminated", providerRef: found.providerRef };
  }
}

integration("claim against a catalog that dropped the pair (94S-280)", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  // One database per test: a slot another test left held would decide what
  // the next pass launches.
  beforeEach(async () => {
    database = await createTempDatabase({ prefix: "catalog_mismatch_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterEach(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const inputs = () => createPostgresSessionUnitOfWork(db);
  const store = () =>
    createPostgresSchedulerStore(db, {
      connectForLock: () => pool.connect(),
      sessionCostLimitUsd: 1_000,
    });

  async function queuedSession(url = REGISTERED) {
    const ownerId = `owner-${randomUUID()}`;
    const result = await inputs().acceptInputAtomic({
      principal: { ownerId },
      idempotencyKey: randomUUID(),
      payloadHash: randomUUID(),
      profileId: PROFILE_ID,
      repository: { id: "sample-app", url, branch: "main" },
      message: "first input",
      limits: LIMITS,
    });
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    return { ...result.response, ownerId };
  }

  function append(session: { ownerId: string; session_id: string }) {
    return inputs().appendInputAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.session_id,
      idempotencyKey: randomUUID(),
      payloadHash: randomUUID(),
      message: "again",
      limits: LIMITS,
    });
  }

  const pass = (backend: ClaimingBackend, slotLimit: number) =>
    runScheduler({
      backend,
      image: "worker:test",
      logger: { error: () => {}, info: () => {}, warn: () => {} },
      resources: RESOURCES,
      slotLimit,
      store: store(),
    });

  async function sessionRow(sessionId: string) {
    const [row] = await db
      .select({
        admission: sessions.admissionState,
        podId: sessions.podId,
        status: sessions.status,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    return row;
  }

  test("slot 1: a session the catalog dropped is failed at its first claim and the next session launches in the following pass", async () => {
    const backend = new ClaimingBackend(db);
    // Created against a URL the catalog has since moved away from, and
    // signalled first so it heads the queue.
    const dropped = await queuedSession(MOVED_TO);
    const healthy = await queuedSession();

    const first = await pass(backend, 1);
    expect(first.launched).toHaveLength(1);
    await backend.startWorkers();
    expect(backend.claims).toEqual([
      { sessionId: dropped.session_id, outcome: "catalog_mismatch" },
    ]);

    const second = await pass(backend, 1);
    expect(second.killed).toHaveLength(1);
    expect(second.launched).toHaveLength(1);
    await backend.startWorkers();
    expect(backend.claims.at(-1)).toEqual({
      sessionId: healthy.session_id,
      outcome: "claimed",
    });
    expect(backend.running.size).toBe(1);
    // One launch, not the failure limit's worth of them.
    expect(
      backend.claims.filter((c) => c.sessionId === dropped.session_id),
    ).toHaveLength(1);

    // What the session's reader sees.
    expect(await sessionRow(dropped.session_id)).toEqual({
      admission: "active",
      podId: null,
      status: "failed",
    });
    const [turn] = await db
      .select({ reason: turns.terminalReason, status: turns.status })
      .from(turns)
      .where(eq(turns.sessionId, dropped.session_id));
    expect(turn).toEqual({ reason: "catalog_mismatch", status: "failed" });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, dropped.receipt_id));
    expect(receipt?.status).toBe("failed");
    expect(receipt?.error).toMatchObject({ code: "CATALOG_MISMATCH" });
    const status = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.sessionId, dropped.session_id),
          eq(events.type, "status"),
        ),
      )
      .orderBy(asc(events.id));
    expect(status.at(-1)?.payload).toMatchObject({
      phase: "failed",
      code: "CATALOG_MISMATCH",
      failed_turn_count: 1,
    });
    // The stored URL may carry a credential; only ids are named.
    expect(JSON.stringify([receipt?.error, status])).not.toContain(
      "moved.invalid",
    );
    const [launch] = await db
      .select({
        count: workerLaunches.launchFailureCount,
        error: workerLaunches.lastLaunchError,
        nonce: workerLaunches.nonceHash,
        released: workerLaunches.slotReleasedAt,
      })
      .from(workerLaunches)
      .where(eq(workerLaunches.sessionId, dropped.session_id));
    expect(launch?.count).toBe(1);
    expect(launch?.error).toContain("sample-app");
    expect(launch?.nonce).toBeNull();
    expect(launch?.released).not.toBeNull();
  }, 60_000);

  test("new input runs the session again once the catalog allows it; until then it fails again at once", async () => {
    const backend = new ClaimingBackend(db);
    const dropped = await queuedSession(MOVED_TO);
    await pass(backend, 1);
    await backend.startWorkers();
    await pass(backend, 1);
    await backend.startWorkers();
    expect(backend.running.size).toBe(0);
    expect((await sessionRow(dropped.session_id))?.status).toBe("failed");

    // Nothing reruns on its own, even with the catalog back.
    backend.runnable = [pairAt(REGISTERED), pairAt(MOVED_TO)];
    expect((await pass(backend, 1)).launched).toEqual([]);
    await backend.startWorkers();

    backend.runnable = [pairAt(REGISTERED)];
    expect((await append(dropped)).outcome).toBe("accepted");
    await pass(backend, 1);
    await backend.startWorkers();
    expect(backend.claims.at(-1)?.outcome).toBe("catalog_mismatch");
    await pass(backend, 1);
    await backend.startWorkers();
    expect(backend.running.size).toBe(0);

    backend.runnable = [pairAt(REGISTERED), pairAt(MOVED_TO)];
    expect((await append(dropped)).outcome).toBe("accepted");
    expect((await sessionRow(dropped.session_id))?.status).toBe("queued");
    await pass(backend, 1);
    await backend.startWorkers();
    expect(backend.claims.at(-1)).toEqual({
      sessionId: dropped.session_id,
      outcome: "claimed",
    });
    // The turns that failed stay failed; only the last one is delivered.
    const statuses = await db
      .select({ status: turns.status })
      .from(turns)
      .where(eq(turns.sessionId, dropped.session_id))
      .orderBy(asc(turns.sequence));
    expect(statuses.map((t) => t.status)).toEqual([
      "failed",
      "failed",
      "queued",
    ]);
  }, 60_000);

  test("a resuming session's launch fails the resume to an operator and keeps its input (94S-138)", async () => {
    const session = await queuedSession(MOVED_TO);
    const intent = await store().reserveLaunch({
      backend: "local_docker",
      image: "worker:test",
      now: new Date(),
      resources: RESOURCES,
      sessionId: session.session_id,
      slotLimit: 1_000,
    });
    if (!intent) throw new Error("no reservation");
    const nonce = await store().issueBootstrapNonce(intent);
    await db
      .update(sessions)
      .set({ admissionState: "resuming" })
      .where(eq(sessions.id, session.session_id));

    const result = await createPostgresWorkerUnitOfWork(db).claimAtomic({
      catalogRevision: "catalog-under-test",
      runnable: [pairAt(REGISTERED)],
      costLimitUsd: 1_000,
      nonceHash: hashWorkerToken(nonce),
      executionId: intent.executionId,
      executionGeneration: intent.generation,
      attemptId: `att_${randomUUID()}`,
      credentialHash: hashWorkerToken(`tok-${randomUUID()}`),
      credentialTtlMs: 60_000,
      egress: {
        providerHash: hashWorkerToken(`wep-${randomUUID()}`),
        repositoryHash: hashWorkerToken(`wer-${randomUUID()}`),
        objectStoreHash: hashWorkerToken(`weo-${randomUUID()}`),
        bindingsOf: () => ({
          provider: "provider",
          repository: "repository",
          object_store: "sessions/s/",
        }),
      },
      leaseTtlMs: 60_000,
      now: new Date(),
    });
    expect(result.outcome).toBe("catalog_mismatch");
    expect(await sessionRow(session.session_id)).toEqual({
      admission: "recovery_required",
      podId: null,
      status: "failed",
    });
    const [turn] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    expect(turn?.status).toBe("queued");
    const status = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.sessionId, session.session_id),
          eq(events.type, "status"),
        ),
      )
      .orderBy(asc(events.id));
    expect(status.at(-1)?.payload).toMatchObject({
      admission_state: "recovery_required",
      resume_failed: { code: "CATALOG_MISMATCH" },
    });
    const [execution] = await db
      .select({ desired: executions.desiredState })
      .from(executions)
      .where(eq(executions.id, intent.executionId));
    expect(execution?.desired).toBe("terminated");
  });

  test("a session with a context gap goes to an operator instead, its input kept (94S-288)", async () => {
    const session = await queuedSession(MOVED_TO);
    // Turn 1 ran and no checkpoint covers it; turn 2 waits.
    await db
      .update(turns)
      .set({ status: "completed", deliveryStartedAt: new Date() })
      .where(eq(turns.sessionId, session.session_id));
    const appended = await append(session);
    if (appended.outcome !== "accepted") throw new Error(appended.outcome);
    const intent = await store().reserveLaunch({
      backend: "local_docker",
      image: "worker:test",
      now: new Date(),
      resources: RESOURCES,
      sessionId: session.session_id,
      slotLimit: 1_000,
    });
    if (!intent) throw new Error("no reservation");
    const nonce = await store().issueBootstrapNonce(intent);

    const result = await createPostgresWorkerUnitOfWork(db).claimAtomic({
      catalogRevision: "catalog-under-test",
      runnable: [pairAt(REGISTERED)],
      costLimitUsd: 1_000,
      nonceHash: hashWorkerToken(nonce),
      executionId: intent.executionId,
      executionGeneration: intent.generation,
      attemptId: `att_${randomUUID()}`,
      credentialHash: hashWorkerToken(`tok-${randomUUID()}`),
      credentialTtlMs: 60_000,
      egress: {
        providerHash: hashWorkerToken(`wep-${randomUUID()}`),
        repositoryHash: hashWorkerToken(`wer-${randomUUID()}`),
        objectStoreHash: hashWorkerToken(`weo-${randomUUID()}`),
        bindingsOf: () => ({
          provider: "provider",
          repository: "repository",
          object_store: "sessions/s/",
        }),
      },
      leaseTtlMs: 60_000,
      now: new Date(),
    });
    expect(result.outcome).toBe("context_gap");
    expect(await sessionRow(session.session_id)).toEqual({
      admission: "recovery_required",
      podId: null,
      status: "failed",
    });
    const queued = await db
      .select({ status: turns.status })
      .from(turns)
      .where(
        and(
          eq(turns.sessionId, session.session_id),
          eq(turns.status, "queued"),
        ),
      );
    expect(queued).toHaveLength(1);
    const [launch] = await db
      .select({ failures: workerLaunches.launchFailureCount })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect(launch?.failures).toBe(0);
    const [execution] = await db
      .select({ desired: executions.desiredState })
      .from(executions)
      .where(eq(executions.id, intent.executionId));
    expect(execution?.desired).toBe("terminated");
  });

  describe("leaves everything alone when the pair is not what stops the claim", () => {
    async function reserved(sessionId: string) {
      const intent = await store().reserveLaunch({
        backend: "local_docker",
        image: "worker:test",
        now: new Date(),
        resources: RESOURCES,
        sessionId,
        slotLimit: 1_000,
      });
      if (!intent) throw new Error("no reservation");
      const ref = {
        executionId: intent.executionId,
        generation: intent.generation,
      };
      const nonce = await store().issueBootstrapNonce(ref);
      return { ref, nonce };
    }

    function claim(
      launch: { ref: ExecutionRef; nonce: string },
      costLimitUsd = 1_000,
    ) {
      return createPostgresWorkerUnitOfWork(db).claimAtomic({
        catalogRevision: "catalog-under-test",
        runnable: [pairAt(REGISTERED)],
        costLimitUsd,
        nonceHash: hashWorkerToken(launch.nonce),
        executionId: launch.ref.executionId,
        executionGeneration: launch.ref.generation,
        attemptId: `att_${randomUUID()}`,
        credentialHash: hashWorkerToken(`tok-${randomUUID()}`),
        credentialTtlMs: 60_000,
        egress: {
          providerHash: hashWorkerToken(`wep-${randomUUID()}`),
          repositoryHash: hashWorkerToken(`wer-${randomUUID()}`),
          objectStoreHash: hashWorkerToken(`weo-${randomUUID()}`),
          bindingsOf: () => ({
            provider: "provider",
            repository: "repository",
            object_store: "sessions/s/",
          }),
        },
        leaseTtlMs: 60_000,
        now: new Date(),
      });
    }

    async function untouched(sessionId: string, ref: ExecutionRef) {
      expect((await sessionRow(sessionId))?.status).toBe("queued");
      const [signal] = await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId));
      expect(signal).toBeDefined();
      const [launch] = await db
        .select({
          count: workerLaunches.launchFailureCount,
          nonce: workerLaunches.nonceHash,
        })
        .from(workerLaunches)
        .where(eq(workerLaunches.executionId, ref.executionId));
      expect(launch?.count).toBe(0);
      expect(launch?.nonce).not.toBeNull();
    }

    test("a session that is not active", async () => {
      const session = await queuedSession(MOVED_TO);
      const launch = await reserved(session.session_id);
      await db
        .update(sessions)
        .set({ admissionState: "paused" })
        .where(eq(sessions.id, session.session_id));
      expect((await claim(launch)).outcome).toBe("no_session");
      await untouched(session.session_id, launch.ref);
    });

    test("a launch already asked to go", async () => {
      const session = await queuedSession(MOVED_TO);
      const launch = await reserved(session.session_id);
      await db
        .update(executions)
        .set({ desiredState: "terminated" })
        .where(eq(executions.id, launch.ref.executionId));
      expect((await claim(launch)).outcome).toBe("no_session");
      await untouched(session.session_id, launch.ref);
    });

    test("a session the catalog allows that has spent its budget", async () => {
      const session = await queuedSession();
      const launch = await reserved(session.session_id);
      await db
        .update(sessions)
        .set({ costUsd: 5 })
        .where(eq(sessions.id, session.session_id));
      expect((await claim(launch, 5)).outcome).toBe("no_session");
      await untouched(session.session_id, launch.ref);
    });

    test("a launch not reserved for one session", async () => {
      const session = await queuedSession(MOVED_TO);
      const executionId = `exec-${randomUUID()}`;
      const nonce = `nonce-${randomUUID()}`;
      await createPostgresWorkerUnitOfWork(db).registerLaunchAtomic({
        executionId,
        generation: 1,
        partition: "default",
        sessionId: null,
        backend: "local_docker",
        nonceHash: hashWorkerToken(nonce),
        nonceTtlMs: 60_000,
      });
      const result = await claim({
        ref: { executionId, generation: 1 },
        nonce,
      });
      // Another session may be claimable; this one never is, and stays put.
      if (result.outcome === "claimed") {
        expect(result.binding.sessionId).not.toBe(session.session_id);
      } else {
        expect(result.outcome).toBe("no_session");
      }
      expect((await sessionRow(session.session_id))?.status).toBe("queued");
    });
  });
});
