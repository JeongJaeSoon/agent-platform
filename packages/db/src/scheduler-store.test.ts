import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createPostgresSchedulerStore } from "./scheduler-store.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  executions,
  sessions,
  unassignedSessions,
  workerLaunches,
} from "./schema.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let store: ReturnType<typeof createPostgresSchedulerStore>;
const NOW = new Date("2026-09-22T00:00:00Z");

async function insertUnassigned(
  overrides: Partial<typeof sessions.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  await db.insert(sessions).values({
    id,
    ownerId: "owner-a",
    repoUrl: "https://example.invalid/repo.git",
    branch: `session/${id}`,
    ...overrides,
  });
  await db.insert(unassignedSessions).values({ sessionId: id });
  return id;
}

/** A launch that predates the intent columns: registered, never relaunchable. */
async function seedLaunch(
  executionId: string,
  sessionId: string,
  backend: string,
): Promise<void> {
  await db.insert(executions).values({
    backend,
    desiredState: "running",
    generation: 1,
    id: executionId,
    observedState: "running",
    sessionId,
  });
  await db.insert(workerLaunches).values({
    backend,
    executionId,
    generation: 1,
    sessionId,
  });
}

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });
  store = createPostgresSchedulerStore(db, {
    connectForLock: async () => ({
      query: async (text: string) => {
        const result = await client.query<Record<string, unknown>>(text);
        return { rows: result.rows };
      },
      release: () => undefined,
    }),
  });
});

afterEach(async () => {
  await client.close();
});

describe("PostgresSchedulerStore", () => {
  test("reserveLaunch commits one intent per session and refuses a second live one", async () => {
    const sessionId = await insertUnassigned();
    const first = await store.reserveLaunch({
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    expect(first).toMatchObject({ generation: 1, sessionId });
    expect(first?.executionId).toMatch(/^exec-[0-9a-f-]{36}$/);

    const second = await store.reserveLaunch({
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    expect(second).toBeNull();

    const rows = await db
      .select()
      .from(executions)
      .where(eq(executions.sessionId, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      backend: "local_docker",
      desiredState: "running",
      generation: 1,
      launchOperationId: first?.operationId,
      observedState: "pending",
      providerRef: null,
    });
    // The same transaction registered the launch: one row, one slot, and no
    // credential until a container is created for it.
    const launches = await db.select().from(workerLaunches);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      backend: "local_docker",
      claimedAttemptId: null,
      executionId: first?.executionId,
      generation: 1,
      nonceExpiresAt: null,
      nonceHash: null,
      partition: "default",
      sessionId,
      slotReleasedAt: null,
    });
    const [session] = await db
      .select({ executionId: sessions.executionId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session?.executionId).toBe(first?.executionId ?? "");
    // The signal stays until a worker claims the session.
    expect(await db.select().from(unassignedSessions)).toHaveLength(1);
  });

  test("a new generation follows a terminated one", async () => {
    const sessionId = await insertUnassigned();
    const first = await store.reserveLaunch({
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!first) throw new Error("no intent");
    await store.confirmExecutionGone(first.executionId, NOW);
    const second = await store.reserveLaunch({
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    expect(second).toMatchObject({ generation: 2, sessionId });
    expect(second?.operationId).not.toBe(first.operationId);
    expect(second?.executionId).not.toBe(first.executionId);
  });

  test("reserveLaunch refuses sessions that are not signalled or not admission-active", async () => {
    const paused = await insertUnassigned({ admissionState: "paused" });
    expect(
      await store.reserveLaunch({
        backend: "local_docker",
        now: NOW,
        sessionId: paused,
        slotLimit: 10,
      }),
    ).toBeNull();

    const claimed = await insertUnassigned();
    await db
      .delete(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, claimed));
    expect(
      await store.reserveLaunch({
        backend: "local_docker",
        now: NOW,
        sessionId: claimed,
        slotLimit: 10,
      }),
    ).toBeNull();

    expect(
      await store.reserveLaunch({
        backend: "local_docker",
        now: NOW,
        sessionId: crypto.randomUUID(),
        slotLimit: 10,
      }),
    ).toBeNull();
  });

  test("inspectDemand lists eligible sessions oldest first and counts live executions", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await insertUnassigned());
    await db
      .update(unassignedSessions)
      .set({ signaledAt: new Date("2026-09-21T00:00:00Z") })
      .where(eq(unassignedSessions.sessionId, ids[3] ?? ""));
    await insertUnassigned({ admissionState: "stopping" });

    const launched = await store.reserveLaunch({
      backend: "local_docker",
      now: NOW,
      sessionId: ids[0] ?? "",
      slotLimit: 10,
    });
    if (!launched) throw new Error("no intent");

    const demand = await store.inspectDemand({ limit: 10 });
    expect(demand.activeExecutionCount).toBe(1);
    expect(demand.eligibleSessionIds[0]).toBe(ids[3]);
    expect(demand.eligibleSessionIds).toHaveLength(3);
    expect(demand.eligibleSessionIds).not.toContain(ids[0]);

    expect(await store.inspectDemand({ limit: 2 })).toMatchObject({
      activeExecutionCount: 1,
      eligibleSessionIds: [ids[3], expect.any(String)],
    });
    expect(await store.inspectDemand({ limit: 0 })).toEqual({
      activeExecutionCount: 1,
      eligibleSessionIds: [],
    });

    // Recording the exit is not releasing the slot; only confirming it is.
    await store.recordObservation(launched, {
      found: true,
      observedAt: NOW,
      providerRef: "ctr",
      state: "terminated",
    });
    expect(
      (await store.inspectDemand({ limit: 10 })).activeExecutionCount,
    ).toBe(1);

    await store.confirmExecutionGone(launched.executionId, NOW);
    const after = await store.inspectDemand({ limit: 10 });
    expect(after.activeExecutionCount).toBe(0);
    expect(after.eligibleSessionIds).toContain(ids[0] ?? "");
  });

  test("listActiveExecutions returns open launches and, for this backend, ones without an intent", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    const foreign = await insertUnassigned();
    await seedLaunch("exec-foreign", foreign, "eks_job");
    const legacySession = await insertUnassigned();
    await seedLaunch("exec-legacy", legacySession, "local_docker");
    // An executions row nobody registered is not in the ledger at all: its
    // resource has no launch, so the pass reclaims it as an orphan instead.
    const strandedSession = await insertUnassigned();
    await db.insert(executions).values({
      backend: "local_docker",
      desiredState: "running",
      generation: 1,
      id: "exec-stranded",
      observedState: "running",
      sessionId: strandedSession,
    });

    const active = await store.listActiveExecutions("local_docker");
    expect(active).toEqual([
      {
        backend: "local_docker",
        claimed: false,
        executionId: intent.executionId,
        generation: 1,
        nonceExpiresAt: null,
        observedState: "pending",
        operationId: intent.operationId,
        providerRef: null,
        sessionId,
      },
      {
        backend: "local_docker",
        claimed: false,
        executionId: "exec-legacy",
        generation: 1,
        nonceExpiresAt: null,
        observedState: "running",
        operationId: null,
        providerRef: null,
        sessionId: legacySession,
      },
    ]);
    // Three launches hold slots; the stranded executions row holds none.
    expect((await store.inspectDemand({ limit: 1 })).activeExecutionCount).toBe(
      3,
    );
  });

  test("another backend's intent is not ours", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      backend: "eks_job",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    expect(await store.listActiveExecutions("local_docker")).toEqual([]);
    expect(await store.filterKnown([intent], "local_docker")).toEqual([]);
    expect(await store.filterKnown([intent], "eks_job")).toEqual([intent]);
  });

  test("recordObservation updates state, time and provider ref for the exact generation", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    const at = new Date("2026-09-22T00:01:00Z");
    await store.recordObservation(intent, {
      found: true,
      observedAt: at,
      providerRef: "ctr-abc",
      state: "running",
    });
    await store.recordObservation(
      { ...intent, generation: 9 },
      { found: false, observedAt: at, providerRef: null, state: "unknown" },
    );
    const [row] = await db
      .select()
      .from(executions)
      .where(eq(executions.id, intent.executionId));
    expect(row).toMatchObject({
      observedAt: at,
      observedState: "running",
      providerRef: "ctr-abc",
    });

    // A not-found observation keeps the last provider ref for the audit trail.
    await store.recordObservation(intent, {
      found: false,
      observedAt: at,
      providerRef: null,
      state: "unknown",
    });
    const [again] = await db
      .select({
        providerRef: executions.providerRef,
        state: executions.observedState,
      })
      .from(executions)
      .where(eq(executions.id, intent.executionId));
    expect(again).toEqual({ providerRef: "ctr-abc", state: "unknown" });
  });

  test("reserveLaunch refuses once open launches reach the slot limit", async () => {
    const a = await insertUnassigned();
    const b = await insertUnassigned();
    const first = await store.reserveLaunch({
      backend: "local_docker",
      now: NOW,
      sessionId: a,
      slotLimit: 1,
    });
    expect(first).not.toBeNull();
    expect(
      await store.reserveLaunch({
        backend: "local_docker",
        now: NOW,
        sessionId: b,
        slotLimit: 1,
      }),
    ).toBeNull();
    if (!first) throw new Error("no intent");
    await store.confirmExecutionGone(first.executionId, NOW);
    expect(
      await store.reserveLaunch({
        backend: "local_docker",
        now: NOW,
        sessionId: b,
        slotLimit: 1,
      }),
    ).not.toBeNull();
  });

  test("reserving and releasing in turn always comes back to zero slots", async () => {
    const work = createPostgresWorkerUnitOfWork(db);
    const sessionId = await insertUnassigned();
    for (let round = 0; round < 4; round += 1) {
      const intent = await store.reserveLaunch({
        backend: "local_docker",
        now: NOW,
        sessionId,
        slotLimit: 1,
      });
      if (!intent) throw new Error(`round ${round} reserved nothing`);
      expect(await work.countReservedSlots()).toBe(1);
      // A launch that never came back would be counted twice by anyone
      // keeping a second ledger; with one, the limit of 1 proves it.
      await store.issueBootstrapNonce(intent, NOW);
      expect(await work.countReservedSlots()).toBe(1);
      await store.confirmExecutionGone(intent.executionId, NOW);
      expect(await work.countReservedSlots()).toBe(0);
      expect(
        (await store.inspectDemand({ limit: 0 })).activeExecutionCount,
      ).toBe(0);
    }
  });

  test("issueBootstrapNonce stores only a hash, rotates it, and stops once claimed", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");

    const first = await store.issueBootstrapNonce(intent, NOW);
    expect(first).toMatch(/^wln_/);
    const [stored] = await db
      .select()
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect(stored?.nonceHash).toEqual(sha256(first));
    expect(stored?.nonceExpiresAt).toEqual(new Date(NOW.getTime() + 600_000));
    // Nothing anywhere holds the plaintext.
    expect(JSON.stringify(stored)).not.toContain(first);
    // The scheduler reads the expiry back to decide when a resource that
    // never claimed has to be replaced rather than waited on.
    const [active] = await store.listActiveExecutions("local_docker");
    expect(active?.nonceExpiresAt).toEqual(new Date(NOW.getTime() + 600_000));

    const second = await store.issueBootstrapNonce(intent, NOW);
    expect(second).not.toBe(first);
    const [rotated] = await db
      .select({ nonceHash: workerLaunches.nonceHash })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect(rotated?.nonceHash).toEqual(sha256(second));

    // A generation that is not this launch's, and a launch whose slot is
    // already back, are both refused.
    await expect(
      store.issueBootstrapNonce({ ...intent, generation: 9 }, NOW),
    ).rejects.toThrow("no bootstrap credential was issued");
    await store.confirmExecutionGone(intent.executionId, NOW);
    await expect(store.issueBootstrapNonce(intent, NOW)).rejects.toThrow(
      "no bootstrap credential was issued",
    );
  });

  test("revokeBootstrapNonce shuts the door only while it is still open", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    const nonce = await store.issueBootstrapNonce(intent, NOW);
    const hashOf = async () => {
      const [row] = await db
        .select({ nonceHash: workerLaunches.nonceHash })
        .from(workerLaunches)
        .where(eq(workerLaunches.executionId, intent.executionId));
      return row?.nonceHash ?? null;
    };

    // Inside the window there is nothing to revoke: a worker may still be on
    // its way, and the credential it was built with has to keep working.
    expect(await store.revokeBootstrapNonce(intent, NOW)).toBe(false);
    expect(await hashOf()).toEqual(sha256(nonce));

    const expired = new Date(NOW.getTime() + 600_001);
    expect(await store.revokeBootstrapNonce(intent, expired)).toBe(true);
    expect(await hashOf()).toBeNull();
    // Idempotent on purpose: a teardown that fails after the revoke leaves
    // the launch here, and the next pass has to be able to try again.
    expect(await store.revokeBootstrapNonce(intent, expired)).toBe(true);

    // A claim that committed first wins outright, however stale the expiry.
    const claimed = await insertUnassigned();
    const other = await store.reserveLaunch({
      backend: "local_docker",
      now: NOW,
      sessionId: claimed,
      slotLimit: 10,
    });
    if (!other) throw new Error("no intent");
    await store.issueBootstrapNonce(other, NOW);
    await db.insert(attempts).values({
      authRevision: 1,
      executionGeneration: other.generation,
      executionId: other.executionId,
      id: "att-1",
      leaseEpoch: 1,
      leaseExpiresAt: expired,
      sessionId: claimed,
      state: "running",
    });
    await db
      .update(workerLaunches)
      .set({ claimedAttemptId: "att-1" })
      .where(eq(workerLaunches.executionId, other.executionId));
    expect(await store.revokeBootstrapNonce(other, expired)).toBe(false);

    // So does a launch whose slot already went back, and a stale generation.
    expect(
      await store.revokeBootstrapNonce({ ...intent, generation: 9 }, expired),
    ).toBe(false);
    await store.confirmExecutionGone(intent.executionId, NOW);
    expect(await store.revokeBootstrapNonce(intent, expired)).toBe(false);
  });

  test("acquirePassLock hands out the lock once and releases it", async () => {
    const release = await store.acquirePassLock();
    expect(release).not.toBeNull();
    // PGlite is one session, so the same session re-acquires; the real
    // Postgres race is covered in scheduler-store.integration.test.ts.
    await release?.();
    expect(await store.acquirePassLock()).not.toBeNull();
  });

  test("filterKnown keeps refs whose row exists with the same generation", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    expect(
      await store.filterKnown(
        [
          intent,
          { executionId: intent.executionId, generation: 2 },
          { executionId: "exec-ghost", generation: 1 },
        ],
        "local_docker",
      ),
    ).toEqual([intent]);
    expect(await store.filterKnown([], "local_docker")).toEqual([]);

    // A launch that gave its slot back no longer owns its resource.
    await store.confirmExecutionGone(intent.executionId, NOW);
    expect(await store.filterKnown([intent], "local_docker")).toEqual([]);
  });
});

function sha256(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}
