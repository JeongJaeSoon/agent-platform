import { describe, expect, test } from "bun:test";
import type {
  EnsureExecutionResult,
  ExecutionBackend,
  ExecutionObservation,
  ExecutionRef,
  LaunchIntent,
  ManagedExecution,
  TerminateExecutionResult,
} from "../ports/execution-backend.ts";
import type {
  ActiveExecution,
  ReserveLaunchInput,
  SchedulerStore,
  StoredLaunchIntent,
} from "../ports/scheduler-store.ts";
import { runScheduler, type SchedulerLogger } from "./session-scheduler.ts";

const RESOURCES = { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 256 };

class MemoryStore implements SchedulerStore {
  readonly executions = new Map<string, ActiveExecution>();
  readonly unassigned = new Set<string>();
  locked = false;
  private sequence = 0;

  async acquirePassLock() {
    if (this.locked) return null;
    this.locked = true;
    return async () => {
      this.locked = false;
    };
  }

  addUnassigned(count: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = crypto.randomUUID();
      this.unassigned.add(id);
      ids.push(id);
    }
    return ids;
  }

  seedActive(overrides: Partial<ActiveExecution> = {}): ActiveExecution {
    const sessionId = overrides.sessionId ?? crypto.randomUUID();
    const execution: ActiveExecution = {
      backend: "local_docker",
      bootstrapNonce: "nonce",
      executionId: `exec-${++this.sequence}`,
      generation: 1,
      observedState: "pending",
      operationId: crypto.randomUUID(),
      providerRef: null,
      sessionId,
      ...overrides,
    };
    this.executions.set(execution.executionId, execution);
    return execution;
  }

  private live(): ActiveExecution[] {
    return [...this.executions.values()].filter(
      (e) => e.observedState !== "terminated",
    );
  }

  async inspectDemand({ limit }: { limit: number }) {
    const liveSessions = new Set(this.live().map((e) => e.sessionId));
    return {
      activeExecutionCount: this.live().length,
      eligibleSessionIds: [...this.unassigned]
        .filter((id) => !liveSessions.has(id))
        .slice(0, limit),
    };
  }

  async reserveLaunch(
    input: ReserveLaunchInput,
  ): Promise<StoredLaunchIntent | null> {
    if (!this.unassigned.has(input.sessionId)) return null;
    if (this.live().some((e) => e.sessionId === input.sessionId)) return null;
    if (this.live().length >= input.slotLimit) return null;
    const generation =
      Math.max(
        0,
        ...[...this.executions.values()]
          .filter((e) => e.sessionId === input.sessionId)
          .map((e) => e.generation),
      ) + 1;
    return this.seedActive({
      backend: input.backend,
      generation,
      sessionId: input.sessionId,
    });
  }

  async listActiveExecutions(backend: ActiveExecution["backend"]) {
    return this.live().filter((e) => e.backend === backend);
  }

  async filterKnown(refs: ExecutionRef[], backend: ActiveExecution["backend"]) {
    return refs.filter((ref) => {
      const row = this.executions.get(ref.executionId);
      return (
        row !== undefined &&
        row.backend === backend &&
        row.generation === ref.generation &&
        row.observedState !== "terminated"
      );
    });
  }

  async recordObservation(
    ref: ExecutionRef,
    observation: ExecutionObservation,
  ) {
    const row = this.executions.get(ref.executionId);
    if (!row) throw new Error(`unknown execution ${ref.executionId}`);
    row.observedState = observation.state;
    row.providerRef = observation.providerRef;
  }
}

type Container = {
  exited: boolean;
  generation: number;
  operationId: string;
  sessionId: string;
  /** false models Docker `created`: create succeeded, start never ran. */
  started?: boolean;
};

function nameOf(ref: ExecutionRef): string {
  return `${ref.executionId}#${ref.generation}`;
}

class FakeBackend implements ExecutionBackend {
  readonly kind = "local_docker" as const;
  /** Keyed like Docker names the containers: execution id plus generation. */
  readonly containers = new Map<string, Container>();
  readonly ensureCalls: LaunchIntent[] = [];
  readonly terminateCalls: ExecutionRef[] = [];
  failEnsureFor = new Set<string>();
  failTerminateFor = new Set<string>();
  mismatchTerminateFor = new Set<string>();

  capabilities() {
    return { suspend: false };
  }

  async ensureExecution(intent: LaunchIntent): Promise<EnsureExecutionResult> {
    this.ensureCalls.push(intent);
    if (this.failEnsureFor.has(intent.sessionId)) {
      throw new Error("docker unavailable");
    }
    const existing = this.containers.get(nameOf(intent));
    if (existing) {
      if (existing.operationId !== intent.operationId) {
        throw new Error("operation id mismatch");
      }
      existing.started = true;
      return {
        created: false,
        providerRef: `ctr-${intent.executionId}`,
        state: "running",
      };
    }
    this.containers.set(nameOf(intent), {
      exited: false,
      generation: intent.generation,
      operationId: intent.operationId,
      sessionId: intent.sessionId,
    });
    return {
      created: true,
      providerRef: `ctr-${intent.executionId}`,
      state: "running",
    };
  }

  async inspect(ref: ExecutionRef): Promise<ExecutionObservation> {
    const container = this.containers.get(nameOf(ref));
    if (!container) {
      return {
        found: false,
        observedAt: new Date(),
        providerRef: null,
        state: "unknown",
      };
    }
    return {
      ...(container.exited ? { exitCode: 0 } : {}),
      found: true,
      observedAt: new Date(),
      providerRef: `ctr-${ref.executionId}`,
      state: container.exited
        ? "terminated"
        : container.started === false
          ? "pending"
          : "running",
    };
  }

  async listManaged(): Promise<ManagedExecution[]> {
    return [...this.containers.entries()].map(([name, c]) => ({
      executionId: name.split("#")[0] ?? name,
      generation: c.generation,
      providerRef: `ctr-${name}`,
      sessionId: c.sessionId,
      state: c.exited ? "terminated" : "running",
    }));
  }

  async terminate(ref: ExecutionRef): Promise<TerminateExecutionResult> {
    this.terminateCalls.push(ref);
    if (this.failTerminateFor.has(nameOf(ref))) {
      throw new Error("docker stop failed");
    }
    if (this.mismatchTerminateFor.has(nameOf(ref))) {
      return { foundGeneration: 99, outcome: "generation_mismatch" };
    }
    const container = this.containers.get(nameOf(ref));
    if (!container) {
      const other = [...this.containers.entries()].find(([name]) =>
        name.startsWith(`${ref.executionId}#`),
      );
      return other
        ? {
            foundGeneration: other[1].generation,
            outcome: "generation_mismatch",
          }
        : { outcome: "absent" };
    }
    this.containers.delete(nameOf(ref));
    return { outcome: "terminated", providerRef: `ctr-${nameOf(ref)}` };
  }
}

function recordingLogger() {
  const records: Array<{ level: string; message: string; fields?: unknown }> =
    [];
  const logger: SchedulerLogger = {
    error: (message, fields) =>
      records.push({ level: "error", message, fields }),
    info: (message, fields) => records.push({ level: "info", message, fields }),
    warn: (message, fields) => records.push({ level: "warn", message, fields }),
  };
  return { logger, records };
}

function harness(slotLimit = 10) {
  const store = new MemoryStore();
  const backend = new FakeBackend();
  const { logger, records } = recordingLogger();
  const run = () =>
    runScheduler({
      backend,
      image: "worker:test",
      logger,
      resources: RESOURCES,
      slotLimit,
      store,
    });
  return { backend, records, run, store };
}

describe("runScheduler", () => {
  test("never launches past the slot limit and fills freed slots later", async () => {
    const { backend, run, store } = harness(10);
    store.addUnassigned(15);

    const first = await run();
    expect(first.launched).toHaveLength(10);
    expect(backend.containers.size).toBe(10);
    expect(first.activeAfter).toBe(10);

    const second = await run();
    expect(second.launched).toHaveLength(0);
    expect(backend.containers.size).toBe(10);

    for (const container of [...backend.containers.values()].slice(0, 3)) {
      container.exited = true;
    }
    const third = await run();
    expect(third.terminatedObserved).toHaveLength(3);
    expect(third.launched).toHaveLength(3);
    expect(backend.containers.size).toBe(10);
    expect(
      [...store.executions.values()].filter(
        (e) => e.observedState === "terminated",
      ),
    ).toHaveLength(3);
  });

  test("a session with a live execution is not launched twice", async () => {
    const { backend, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    await run();
    await run();
    await run();
    expect(
      backend.ensureCalls.filter((i) => i.sessionId === sessionId).length,
    ).toBeGreaterThan(0);
    expect(backend.containers.size).toBe(1);
    expect(
      [...store.executions.values()].filter((e) => e.sessionId === sessionId),
    ).toHaveLength(1);
  });

  test("an intent whose resource is missing is re-created with the same intent", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    expect(intent).toBeDefined();
    if (!intent) throw new Error("no intent");

    // Control host restart after commit but before Docker created anything.
    backend.containers.clear();
    const summary = await run();

    expect(summary.reensured).toEqual([
      { executionId: intent.executionId, generation: intent.generation },
    ]);
    expect(summary.launched).toHaveLength(0);
    expect(backend.containers.size).toBe(1);
    const [again] = backend.ensureCalls.slice(-1);
    expect(again?.operationId).toBe(intent.operationId);
    expect(again?.bootstrapNonce).toBe(intent.bootstrapNonce);
    expect(
      records.some(
        (r) =>
          r.level === "warn" && r.message.includes("re-created from intent"),
      ),
    ).toBe(true);
  });

  test("a created-but-never-started resource is started through the same intent", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({ executionId: "exec-1" });
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      operationId: row.operationId,
      sessionId: row.sessionId,
      started: false,
    });
    const summary = await run();
    expect(summary.reensured).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(backend.containers.get("exec-1#1")?.started).toBe(true);
    expect(store.executions.get("exec-1")?.observedState).toBe("running");
  });

  test("an exited resource whose removal fails stays live and is retried", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    container.exited = true;
    backend.failTerminateFor.add(name);

    const first = await run();
    expect(first.terminatedObserved).toEqual([]);
    expect(first.reclaimFailed).toHaveLength(1);
    expect(backend.containers.has(name)).toBe(true);
    expect([...store.executions.values()][0]?.observedState).not.toBe(
      "terminated",
    );
    expect(
      records.some(
        (r) => r.level === "error" && r.message.includes("Reclaiming"),
      ),
    ).toBe(true);
    // The slot is still held, so nothing new is launched meanwhile.
    expect(first.launched).toEqual([]);

    backend.failTerminateFor.clear();
    const second = await run();
    expect(second.terminatedObserved).toHaveLength(1);
    expect(backend.containers.has(name)).toBe(false);
    expect([...store.executions.values()][0]?.observedState).toBe("terminated");
  });

  test("a generation mismatch on reclaim keeps the slot occupied", async () => {
    const { backend, records, run, store } = harness(1);
    store.addUnassigned(2);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    container.exited = true;
    backend.mismatchTerminateFor.add(name);

    const summary = await run();
    expect(summary.terminatedObserved).toEqual([]);
    expect(summary.reclaimFailed).toHaveLength(1);
    expect(summary.launched).toEqual([]);
    expect([...store.executions.values()][0]?.observedState).toBe(
      "terminating",
    );
    expect(
      records.some(
        (r) => r.level === "error" && r.message.includes("generation mismatch"),
      ),
    ).toBe(true);
  });

  test("an absent resource after a terminating mark is recorded terminated, not relaunched", async () => {
    const { backend, run, store } = harness();
    // Previous pass: marked terminating, removed the container, then crashed.
    store.seedActive({ executionId: "exec-1", observedState: "terminating" });
    const summary = await run();
    expect(summary.terminatedObserved).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(summary.reensured).toEqual([]);
    expect(backend.ensureCalls).toEqual([]);
    expect(store.executions.get("exec-1")?.observedState).toBe("terminated");
  });

  test("a resource whose row is already terminated is reclaimed as an orphan", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({
      executionId: "exec-1",
      observedState: "terminated",
    });
    backend.containers.set("exec-1#1", {
      exited: true,
      generation: 1,
      operationId: row.operationId,
      sessionId: row.sessionId,
    });
    const summary = await run();
    expect(summary.orphansTerminated).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(backend.containers.size).toBe(0);
  });

  test("the store refuses a reservation past the slot limit even when the pass thought a slot was free", async () => {
    const { backend, run, store } = harness(2);
    store.addUnassigned(3);
    // Another pass took a slot between this pass's demand check and reserve.
    const original = store.reserveLaunch.bind(store);
    let injected = false;
    store.reserveLaunch = async (input) => {
      if (!injected) {
        injected = true;
        store.seedActive({ observedState: "running" });
      }
      return original(input);
    };
    const summary = await run();
    expect(summary.launched).toHaveLength(1);
    expect(store.executions.size).toBe(2);
    expect(backend.containers.size).toBe(1);
  });

  test("a resource with no launch intent is logged and terminated", async () => {
    const { backend, records, run, store } = harness();
    backend.containers.set("exec-ghost#4", {
      exited: false,
      generation: 4,
      operationId: "op-ghost",
      sessionId: "session-ghost",
    });
    const summary = await run();
    expect(summary.orphansTerminated).toEqual([
      { executionId: "exec-ghost", generation: 4 },
    ]);
    expect(backend.containers.has("exec-ghost#4")).toBe(false);
    expect(store.executions.size).toBe(0);
    expect(
      records.find((r) => r.message.includes("no launch intent")),
    ).toMatchObject({
      level: "warn",
      fields: expect.objectContaining({
        execution_id: "exec-ghost",
        generation: 4,
        session_id: "session-ghost",
      }),
    });
  });

  test("a resource whose generation does not match its row is an orphan", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({ executionId: "exec-1", generation: 2 });
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      operationId: "stale",
      sessionId: row.sessionId,
    });
    const summary = await run();
    // Generation 2 had no resource, so it was re-ensured, and the stale
    // generation-1 container was terminated as an orphan.
    expect(summary.orphansTerminated).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(summary.reensured).toEqual([
      { executionId: "exec-1", generation: 2 },
    ]);
  });

  test("an orphan the provider will not terminate still occupies a slot", async () => {
    const { backend, run, store } = harness(1);
    backend.containers.set("stray#1", {
      exited: false,
      generation: 1,
      operationId: "op-stray",
      sessionId: "s-stray",
    });
    backend.mismatchTerminateFor.add("stray#1");
    store.addUnassigned(1);

    const summary = await run();
    expect(summary.orphansTerminated).toEqual([]);
    expect(summary.orphansUnresolved).toEqual([
      { executionId: "stray", generation: 1 },
    ]);
    expect(summary.launched).toEqual([]);
    expect(backend.containers.size).toBe(1);

    backend.mismatchTerminateFor.clear();
    const next = await run();
    expect(next.orphansTerminated).toHaveLength(1);
    expect(next.launched).toHaveLength(1);
  });

  test("another backend's intent is never recreated on this provider", async () => {
    const { backend, run, store } = harness();
    store.seedActive({ backend: "eks_job", observedState: "running" });
    const summary = await run();
    expect(summary.activeBefore).toBe(0);
    expect(summary.reensured).toEqual([]);
    expect(backend.ensureCalls).toEqual([]);
    expect(backend.containers.size).toBe(0);
  });

  test("a failed launch keeps the intent and is retried next pass", async () => {
    const { backend, records, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    if (!sessionId) throw new Error("no session");
    backend.failEnsureFor.add(sessionId);

    const first = await run();
    expect(first.failedLaunches).toHaveLength(1);
    expect(first.launched).toHaveLength(0);
    const [row] = store.executions.values();
    expect(row?.observedState).toBe("unknown");
    expect(
      records.some((r) => r.level === "error" && r.message.includes("kept")),
    ).toBe(true);

    backend.failEnsureFor.clear();
    const second = await run();
    expect(second.reensured).toHaveLength(1);
    expect(second.launched).toHaveLength(0);
    expect(store.executions.size).toBe(1);
    expect(backend.containers.size).toBe(1);
  });

  test("a pass that cannot take the lock does nothing and says so", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(2);
    store.locked = true;
    const summary = await run();
    expect(summary.skipped).toBe(true);
    expect(summary.launched).toEqual([]);
    expect(backend.ensureCalls).toEqual([]);
    expect(records.some((r) => r.message.includes("holds the lock"))).toBe(
      true,
    );

    store.locked = false;
    const next = await run();
    expect(next.skipped).toBe(false);
    expect(next.launched).toHaveLength(2);
    expect(store.locked).toBe(false);
  });

  test("the lock is released even when the pass throws", async () => {
    const { backend, run, store } = harness();
    store.seedActive({ executionId: "exec-1" });
    backend.inspect = async () => {
      throw new Error("daemon down");
    };
    await expect(run()).rejects.toThrow("daemon down");
    expect(store.locked).toBe(false);
  });

  test("rejects a negative or fractional slot limit", async () => {
    const { backend, store } = harness();
    const { logger } = recordingLogger();
    for (const slotLimit of [-1, 1.5]) {
      await expect(
        runScheduler({
          backend,
          image: "worker:test",
          logger,
          resources: RESOURCES,
          slotLimit,
          store,
        }),
      ).rejects.toThrow("slotLimit");
    }
  });
});
