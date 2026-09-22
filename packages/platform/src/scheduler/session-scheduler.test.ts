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
  private sequence = 0;

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
    const generation =
      Math.max(
        0,
        ...[...this.executions.values()]
          .filter((e) => e.sessionId === input.sessionId)
          .map((e) => e.generation),
      ) + 1;
    return this.seedActive({ generation, sessionId: input.sessionId });
  }

  async listActiveExecutions() {
    return this.live();
  }

  async filterKnown(refs: ExecutionRef[]) {
    return refs.filter((ref) => {
      const row = this.executions.get(ref.executionId);
      return row !== undefined && row.generation === ref.generation;
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
      state: container.exited ? "terminated" : "running",
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
