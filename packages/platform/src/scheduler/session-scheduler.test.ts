import { describe, expect, test } from "bun:test";
import type {
  EnsureExecutionResult,
  ExecutionBackend,
  ExecutionObservation,
  ExecutionRef,
  LaunchIntent,
  ManagedExecution,
  ManagedWorkspace,
  TerminateExecutionResult,
  WorkspaceRemovalResult,
} from "../ports/execution-backend.ts";
import type {
  ActiveExecution,
  ReplaceReason,
  ReserveLaunchInput,
  SchedulerStore,
  StoredLaunchIntent,
} from "../ports/scheduler-store.ts";
import {
  reclaimWorkspaces,
  runScheduler,
  type SchedulerLogger,
} from "./session-scheduler.ts";

const RESOURCES = { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 256 };
const NONCE_TTL_MS = 10 * 60 * 1000;

/** A launch row: the slot it holds and the credential it has handed out. */
type Launch = ActiveExecution & { slotReleased: boolean; nonce: string | null };

class MemoryStore implements SchedulerStore {
  readonly executions = new Map<string, Launch>();
  readonly unassigned = new Set<string>();
  readonly confirmedGone: string[] = [];
  locked = false;
  /** Models the store itself failing, distinct from one row's provider. */
  failList = false;
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

  seedActive(overrides: Partial<Launch> = {}): Launch {
    const sessionId = overrides.sessionId ?? crypto.randomUUID();
    const execution: Launch = {
      backend: "local_docker",
      claimed: false,
      executionId: `exec-${++this.sequence}`,
      generation: 1,
      nonce: null,
      nonceExpiresAt: null,
      nonceExpired: false,
      observedState: "pending",
      operationId: crypto.randomUUID(),
      pendingReplacement: null,
      providerRef: null,
      replacementCount: 0,
      sessionId,
      slotReleased: false,
      ...overrides,
    };
    this.executions.set(execution.executionId, execution);
    return execution;
  }

  /** The ledger: a launch holds its slot until it is confirmed gone. */
  private live(): Launch[] {
    return [...this.executions.values()].filter((e) => !e.slotReleased);
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
    const seeded = this.seedActive({
      backend: input.backend,
      generation,
      sessionId: input.sessionId,
    });
    if (seeded.operationId === null) {
      throw new Error("seeded intent is complete");
    }
    return { ...seeded, operationId: seeded.operationId };
  }

  async requestReplacement(
    ref: ExecutionRef,
    reason: ReplaceReason,
    expectedCount: number,
  ): Promise<number | null> {
    const row = this.executions.get(ref.executionId);
    if (
      !row ||
      row.generation !== ref.generation ||
      row.claimed ||
      row.slotReleased ||
      row.replacementCount !== expectedCount
    ) {
      return null;
    }
    row.pendingReplacement = reason;
    row.replacementCount += 1;
    // The door shuts with the record, as in the real store.
    row.nonce = null;
    return row.replacementCount;
  }

  async settleReplacement(ref: ExecutionRef): Promise<void> {
    const row = this.executions.get(ref.executionId);
    if (!row || row.generation !== ref.generation) return;
    row.pendingReplacement = null;
  }

  async issueBootstrapNonce(ref: ExecutionRef): Promise<string> {
    const row = this.executions.get(ref.executionId);
    if (
      !row ||
      row.generation !== ref.generation ||
      row.claimed ||
      row.slotReleased
    ) {
      throw new Error(`no credential for ${ref.executionId}`);
    }
    row.nonce = `nonce-${crypto.randomUUID()}`;
    row.nonceExpiresAt = new Date(Date.now() + NONCE_TTL_MS);
    return row.nonce;
  }

  async revokeBootstrapNonce(ref: ExecutionRef): Promise<boolean> {
    const row = this.executions.get(ref.executionId);
    if (
      !row ||
      row.generation !== ref.generation ||
      row.claimed ||
      row.slotReleased ||
      row.nonceExpiresAt === null ||
      row.nonceExpiresAt.getTime() > Date.now()
    ) {
      return false;
    }
    row.nonce = null;
    return true;
  }

  async confirmExecutionGone(executionId: string): Promise<void> {
    this.confirmedGone.push(executionId);
    const row = this.executions.get(executionId);
    if (!row) return;
    row.slotReleased = true;
    row.observedState = "terminated";
  }

  async listActiveExecutions(backend: ActiveExecution["backend"]) {
    if (this.failList) throw new Error("database down");
    // Copies, like a query result: what the caller carries is a snapshot and
    // stays behind whatever the rows do while the pass runs.
    // The store, not the scheduler, judges expiry — on its own clock.
    return this.live()
      .filter((e) => e.backend === backend)
      .map((e) => ({
        ...e,
        nonceExpired:
          e.nonceExpiresAt !== null && e.nonceExpiresAt.getTime() <= Date.now(),
      }));
  }

  async filterKnown(refs: ExecutionRef[], backend: ActiveExecution["backend"]) {
    return refs.filter((ref) => {
      const row = this.executions.get(ref.executionId);
      return (
        row !== undefined &&
        row.backend === backend &&
        row.generation === ref.generation &&
        !row.slotReleased
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

  /** Sessions whose workspace must survive; everything else is reclaimable. */
  readonly retainedSessions = new Set<string>();
  /** What GC asked about, in order, so the ordering can be asserted. */
  readonly retainedQueries: string[][] = [];
  failRetained = false;

  async filterRetainedSessions(sessionIds: string[]): Promise<string[]> {
    this.retainedQueries.push([...sessionIds]);
    if (this.failRetained) throw new Error("database down");
    return sessionIds.filter((id) => this.retainedSessions.has(id));
  }
}

type Container = {
  exited: boolean;
  generation: number;
  /**
   * What the resource was built with, exactly as an env var would be. Only
   * containers this backend created have one; a hand-seeded fixture stands
   * for a container that was already there.
   */
  nonce?: string;
  operationId: string;
  /** true models Docker `removing`: a teardown the daemon has not finished. */
  removing?: boolean;
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
  readonly assertReplaceableCalls: LaunchIntent[] = [];
  failEnsureFor = new Set<string>();
  /** Session ids whose container dies right after start (bad image). */
  exitOnStartFor = new Set<string>();
  /** Session ids whose create is taken but whose start the daemon cannot show. */
  createPendingFor = new Set<string>();
  /** Execution ids whose inspect throws (ownership conflict, stuck daemon call). */
  failInspectFor = new Set<string>();
  failTerminateFor = new Set<string>();
  /** Containers whose `stop` succeeds and whose `remove` then fails. */
  failRemoveFor = new Set<string>();
  /** Containers the provider reports as built on an older isolation contract. */
  staleFor = new Set<string>();
  /** Session ids whose replacement the provider says it could not create. */
  refuseReplacementFor = new Set<string>();
  mismatchTerminateFor = new Set<string>();
  duringInspect: ((ref: ExecutionRef) => void) | null = null;
  /** Volume name -> the session label on it, null when it carries none. */
  readonly workspaces = new Map<string, string | null>();
  readonly workspacesInUse = new Set<string>();
  failListWorkspaces = false;
  failRemoveWorkspaceFor = new Set<string>();
  listWorkspaces?: () => Promise<ManagedWorkspace[]>;
  removeWorkspace?: (id: string) => Promise<WorkspaceRemovalResult>;

  /** `workspaceGc: false` is a backend that does not own its workspaces. */
  constructor(options: { workspaceGc?: boolean } = {}) {
    if (options.workspaceGc === false) return;
    this.listWorkspaces = async () => {
      if (this.failListWorkspaces) throw new Error("daemon unreachable");
      return [...this.workspaces.entries()].map(([id, sessionId]) => ({
        createdAt: new Date(0),
        id,
        sessionId,
      }));
    };
    this.removeWorkspace = async (id) => {
      if (this.failRemoveWorkspaceFor.has(id)) {
        throw new Error("volume remove failed");
      }
      if (this.workspacesInUse.has(id)) return { outcome: "in_use" };
      if (!this.workspaces.has(id)) return { outcome: "absent" };
      this.workspaces.delete(id);
      return { outcome: "removed" };
    };
  }

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
    const exited = this.exitOnStartFor.has(intent.sessionId);
    const pending = this.createPendingFor.has(intent.sessionId);
    // A fresh container is built on the contract this backend speaks now.
    this.staleFor.delete(nameOf(intent));
    this.containers.set(nameOf(intent), {
      exited,
      generation: intent.generation,
      // Only the create path asks for one, like the real backend.
      nonce: await intent.issueBootstrapNonce(),
      operationId: intent.operationId,
      sessionId: intent.sessionId,
      ...(pending ? { started: false } : {}),
    });
    return {
      created: true,
      providerRef: `ctr-${intent.executionId}`,
      state: exited ? "terminated" : pending ? "pending" : "running",
    };
  }

  async assertReplaceable(intent: LaunchIntent): Promise<void> {
    this.assertReplaceableCalls.push(intent);
    if (this.refuseReplacementFor.has(intent.sessionId)) {
      throw new Error("Image worker:test is not on this daemon");
    }
  }

  async inspect(ref: ExecutionRef): Promise<ExecutionObservation> {
    // The one place a pass is demonstrably out on the network, and so the
    // place a test can make the rows move underneath it.
    this.duringInspect?.(ref);
    if (this.failInspectFor.has(ref.executionId)) {
      throw new Error("ownership conflict");
    }
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
      ...(this.staleFor.has(nameOf(ref)) ? { stale: true } : {}),
      found: true,
      observedAt: new Date(),
      providerRef: `ctr-${ref.executionId}`,
      state: container.exited
        ? "terminated"
        : container.removing
          ? "terminating"
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
    const stopped = this.containers.get(nameOf(ref));
    if (stopped && this.failRemoveFor.has(nameOf(ref))) {
      // Half a teardown: the container is exited and still there.
      stopped.exited = true;
      throw new Error("docker rm failed");
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

function harness(slotLimit = 10, options: { workspaceGc?: boolean } = {}) {
  const store = new MemoryStore();
  const backend = new FakeBackend(options);
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
  const reclaim = () => reclaimWorkspaces({ backend, logger, store });
  return { backend, reclaim, records, run, store };
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

    const firstNonce = [...backend.containers.values()][0]?.nonce;
    expect(firstNonce).toBeString();

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
    // The identity is the same launch; the credential is not. The container
    // that held the old nonce is gone, so nothing is cut off by rotating it.
    const replacement = [...backend.containers.values()][0];
    expect(replacement?.nonce).not.toBe(firstNonce);
    expect(store.executions.get(intent.executionId)?.nonce).toBe(
      replacement?.nonce,
    );
    expect(
      records.some(
        (r) =>
          r.level === "warn" && r.message.includes("re-created from intent"),
      ),
    ).toBe(true);
  });

  test("a running resource on an older isolation contract is replaced", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    if (!intent) throw new Error("no intent");
    const ref = { executionId: intent.executionId, generation: 1 };

    // The control host was upgraded; the container it launched was not.
    backend.staleFor.add(`${intent.executionId}#1`);
    const summary = await run();

    expect(summary.replaced).toEqual([ref]);
    expect(summary.reensured).toEqual([ref]);
    expect(backend.terminateCalls).toEqual([ref]);
    expect(backend.containers.size).toBe(1);
    const [again] = backend.ensureCalls.slice(-1);
    expect(again?.operationId).toBe(intent.operationId);
    expect(store.executions.get(intent.executionId)?.observedState).toBe(
      "running",
    );
    expect(
      records.some((r) =>
        r.message.includes("predates the isolation contract"),
      ),
    ).toBe(true);

    // The replacement is current, so the next pass leaves it alone.
    const after = await run();
    expect(after.replaced).toHaveLength(0);
    expect(after.reensured).toHaveLength(0);
  });

  test("a stale resource whose replacement cannot be built is left running", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    if (!intent) throw new Error("no intent");
    const ref = { executionId: intent.executionId, generation: 1 };

    // The upgrade marks it stale, but the image it would be rebuilt from is
    // gone. Tearing it down here would leave the session with no worker and
    // nothing to retry into, so the stale one keeps running.
    backend.staleFor.add(`${intent.executionId}#1`);
    backend.refuseReplacementFor.add(intent.sessionId);
    const summary = await run();

    expect(summary.reconcileFailed).toEqual([ref]);
    expect(summary.replaced).toHaveLength(0);
    expect(backend.terminateCalls).toHaveLength(0);
    expect(backend.containers.size).toBe(1);
    expect(backend.ensureCalls).toHaveLength(1);
    expect(
      records.some((r) => r.message.includes("Replacement would not launch")),
    ).toBe(true);

    // The image comes back and the same pass replaces it.
    backend.refuseReplacementFor.clear();
    const after = await run();
    expect(after.replaced).toEqual([ref]);
    expect(after.reensured).toEqual([ref]);
  });

  test("a stale resource the provider will not terminate keeps its slot", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    if (!intent) throw new Error("no intent");
    const ref = { executionId: intent.executionId, generation: 1 };

    backend.staleFor.add(`${intent.executionId}#1`);
    backend.failTerminateFor.add(`${intent.executionId}#1`);
    const summary = await run();

    expect(summary.reconcileFailed).toEqual([ref]);
    expect(summary.replaced).toHaveLength(0);
    expect(backend.containers.size).toBe(1);
    expect(backend.ensureCalls).toHaveLength(1);
  });

  test("a replacement whose teardown only half happened is finished by the next pass with the same intent", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    if (!intent) throw new Error("no intent");
    const ref = { executionId: intent.executionId, generation: 1 };
    const name = `${intent.executionId}#1`;

    // `stop` goes through, `rm` does not: the container is left exited.
    backend.staleFor.add(name);
    backend.failRemoveFor.add(name);
    const first = await run();
    expect(first.reconcileFailed).toEqual([ref]);
    expect(first.replaced).toHaveLength(0);
    expect(backend.containers.get(name)?.exited).toBe(true);
    // The intent to rebuild was written before the teardown began.
    const row = store.executions.get(intent.executionId);
    expect(row?.pendingReplacement).toBe("stale_isolation");
    expect(row?.replacementCount).toBe(1);
    expect(row?.slotReleased).toBe(false);
    expect(store.confirmedGone).toEqual([]);

    // The next pass sees an exited container. Without the record it would
    // close the launch and reschedule the session under generation 2.
    backend.failRemoveFor.clear();
    const second = await run();
    expect(second.replaced).toEqual([ref]);
    expect(second.reensured).toEqual([ref]);
    expect(second.terminatedObserved).toEqual([]);
    expect(store.confirmedGone).toEqual([]);
    const [again] = backend.ensureCalls.slice(-1);
    expect(again?.executionId).toBe(intent.executionId);
    expect(again?.generation).toBe(1);
    expect(again?.operationId).toBe(intent.operationId);
    expect(backend.containers.size).toBe(1);
    expect(backend.containers.get(name)?.exited).toBe(false);
    expect(store.executions.size).toBe(1);
    expect(row?.pendingReplacement).toBeNull();
    expect(row?.replacementCount).toBe(2);
    expect(row?.observedState).toBe("running");

    // Settled: the next pass leaves the replacement alone.
    const third = await run();
    expect(third.replaced).toHaveLength(0);
    expect(third.reensured).toHaveLength(0);
    expect(backend.terminateCalls).toHaveLength(2);
  });

  test("an expired-nonce replacement survives a half teardown and gets a fresh credential", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    if (!intent) throw new Error("no intent");
    const name = `${intent.executionId}#1`;
    const row = store.executions.get(intent.executionId);
    if (!row?.nonceExpiresAt) throw new Error("no nonce");
    const oldNonce = backend.containers.get(name)?.nonce;
    row.nonceExpiresAt = new Date(Date.now() - 1);

    backend.failRemoveFor.add(name);
    const first = await run();
    expect(first.reconcileFailed).toHaveLength(1);
    expect(row.pendingReplacement).toBe("nonce_expired");

    backend.failRemoveFor.clear();
    const second = await run();
    expect(second.reensured).toEqual([
      { executionId: intent.executionId, generation: 1 },
    ]);
    expect(store.confirmedGone).toEqual([]);
    expect(backend.containers.get(name)?.nonce).not.toBe(oldNonce);
    expect(row.nonceExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.pendingReplacement).toBeNull();
  });

  test("a control host that died between the record and the teardown loses nothing", async () => {
    const { backend, run, store } = harness();
    // Recorded, never torn down: the stale container is still running.
    const row = store.seedActive({
      executionId: "exec-1",
      observedState: "running",
      replacementCount: 1,
      pendingReplacement: "stale_isolation",
    });
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      operationId: row.operationId ?? "op",
      sessionId: row.sessionId,
    });
    backend.staleFor.add("exec-1#1");
    const ref = { executionId: "exec-1", generation: 1 };

    const summary = await run();
    expect(summary.replaced).toEqual([ref]);
    expect(summary.reensured).toEqual([ref]);
    expect(store.confirmedGone).toEqual([]);
    const [again] = backend.ensureCalls.slice(-1);
    expect(again?.operationId).toBe(row.operationId ?? undefined);
    expect(row.pendingReplacement).toBeNull();
    expect(row.replacementCount).toBe(2);
  });

  test("a control host that died after the teardown rebuilds instead of closing the launch", async () => {
    const { backend, run, store } = harness();
    // Torn down, not rebuilt, not recorded: nothing on the provider, and
    // the row still says running. Without the record this is "missing" and
    // would be re-ensured anyway; with the row saying `terminating` it would
    // be read as reclaimed and closed.
    const row = store.seedActive({
      executionId: "exec-1",
      observedState: "terminating",
      replacementCount: 1,
      pendingReplacement: "stale_isolation",
    });
    const ref = { executionId: "exec-1", generation: 1 };

    const summary = await run();
    expect(summary.reensured).toEqual([ref]);
    expect(summary.terminatedObserved).toEqual([]);
    expect(store.confirmedGone).toEqual([]);
    expect(backend.terminateCalls).toEqual([]);
    const [again] = backend.ensureCalls.slice(-1);
    expect(again?.operationId).toBe(row.operationId ?? undefined);
    expect(row.pendingReplacement).toBeNull();
  });

  test("a replacement that landed before the host died is settled, not rebuilt again", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({
      executionId: "exec-1",
      observedState: "running",
      replacementCount: 1,
      pendingReplacement: "stale_isolation",
    });
    // Current contract, running: this is the replacement itself.
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      operationId: row.operationId ?? "op",
      sessionId: row.sessionId,
    });

    const summary = await run();
    expect(summary.replaced).toHaveLength(0);
    expect(summary.reensured).toHaveLength(0);
    expect(backend.terminateCalls).toEqual([]);
    expect(backend.ensureCalls).toEqual([]);
    expect(row.pendingReplacement).toBeNull();
    expect(row.replacementCount).toBe(1);
  });

  test("a replacement caught on its way out is rebuilt, not settled into an exit", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({
      executionId: "exec-1",
      observedState: "running",
      pendingReplacement: "stale_isolation",
      replacementCount: 1,
    });
    // Docker `removing`: the half-torn-down old container, still visible.
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      operationId: row.operationId ?? "op",
      removing: true,
      sessionId: row.sessionId,
    });
    const ref = { executionId: "exec-1", generation: 1 };

    const summary = await run();
    expect(summary.replaced).toEqual([ref]);
    expect(summary.reensured).toEqual([ref]);
    expect(store.confirmedGone).toEqual([]);
    expect(row.pendingReplacement).toBeNull();
    expect(row.replacementCount).toBe(2);
    expect(backend.containers.get("exec-1#1")?.removing).toBeUndefined();
  });

  test("a replacement created but never started is started, not rebuilt or counted", async () => {
    const { backend, run, store } = harness();
    // The host died between Docker create and start, with the count already
    // at the limit: tearing this one down would strand a startable
    // container behind an exhausted launch.
    const row = store.seedActive({
      executionId: "exec-1",
      observedState: "running",
      pendingReplacement: "stale_isolation",
      replacementCount: 3,
    });
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      operationId: row.operationId ?? "op",
      sessionId: row.sessionId,
      started: false,
    });
    const ref = { executionId: "exec-1", generation: 1 };

    const summary = await run();
    expect(summary.reensured).toEqual([ref]);
    expect(summary.replaced).toEqual([]);
    expect(summary.replacementsExhausted).toEqual([]);
    expect(backend.terminateCalls).toEqual([]);
    expect(backend.containers.get("exec-1#1")?.started).toBe(true);
    expect(row.pendingReplacement).toBeNull();
    expect(row.replacementCount).toBe(3);
  });

  test("a rebuilt resource the daemon cannot yet show running keeps the intent until it can", async () => {
    const { backend, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    if (!intent || !sessionId) throw new Error("no intent");
    const name = `${intent.executionId}#1`;
    const row = store.executions.get(intent.executionId);
    if (!row) throw new Error("no row");

    // Start accepted, post-start inspect comes back `created`: launched,
    // but not yet proven. Settling here would make a container that dies
    // in the next second an ordinary exit.
    backend.staleFor.add(name);
    backend.createPendingFor.add(sessionId);
    const first = await run();
    expect(first.reensured).toEqual([
      { executionId: intent.executionId, generation: 1 },
    ]);
    expect(row.pendingReplacement).toBe("stale_isolation");
    expect(row.replacementCount).toBe(1);

    // Next pass: still `created`, adopted and started, and only then settled.
    backend.createPendingFor.clear();
    const second = await run();
    expect(second.reensured).toHaveLength(1);
    expect(second.replaced).toHaveLength(0);
    expect(backend.containers.get(name)?.started).toBe(true);
    expect(row.pendingReplacement).toBeNull();
    expect(row.replacementCount).toBe(1);
  });

  test("a claimed launch ignores a pending replacement and is closed like any exit", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({
      claimed: true,
      executionId: "exec-1",
      observedState: "running",
      replacementCount: 1,
      pendingReplacement: "stale_isolation",
    });
    backend.containers.set("exec-1#1", {
      exited: true,
      generation: 1,
      operationId: row.operationId ?? "op",
      sessionId: row.sessionId,
    });

    const summary = await run();
    expect(summary.terminatedObserved).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(summary.reensured).toHaveLength(0);
    expect(store.confirmedGone).toEqual(["exec-1"]);
    expect(backend.ensureCalls).toEqual([]);
  });

  test("a launch that keeps needing replacement is left alone at the limit", async () => {
    const { backend, records, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    await run();
    const [intent] = backend.ensureCalls;
    if (!intent || !sessionId) throw new Error("no intent");
    const ref = { executionId: intent.executionId, generation: 1 };
    const name = `${intent.executionId}#1`;
    const row = store.executions.get(intent.executionId);
    if (!row) throw new Error("no row");

    // Every rebuild dies on start, so every pass finds an exited resource
    // with a replacement still pending.
    backend.staleFor.add(name);
    backend.exitOnStartFor.add(sessionId);
    const first = await run();
    expect(first.replaced).toEqual([ref]);
    expect(first.failedLaunches).toEqual([ref]);
    expect(row.replacementCount).toBe(1);
    expect(row.pendingReplacement).toBe("stale_isolation");

    const second = await run();
    expect(second.replaced).toEqual([ref]);
    expect(row.replacementCount).toBe(2);
    const third = await run();
    expect(third.replaced).toEqual([ref]);
    expect(row.replacementCount).toBe(3);
    expect(store.confirmedGone).toEqual([]);

    // DEFAULT_REPLACEMENT_LIMIT rebuilds are spent. Nothing is torn down,
    // nothing is built, nothing is released: the launch keeps its slot and
    // the pass keeps failing until someone looks.
    backend.exitOnStartFor.clear();
    for (const _ of [1, 2]) {
      const exhausted = await run();
      expect(exhausted.replacementsExhausted).toEqual([ref]);
      expect(exhausted.replaced).toHaveLength(0);
      expect(exhausted.reensured).toHaveLength(0);
      expect(exhausted.terminatedObserved).toHaveLength(0);
      expect(exhausted.launched).toHaveLength(0);
    }
    expect(store.confirmedGone).toEqual([]);
    expect(row.replacementCount).toBe(3);
    expect(row.slotReleased).toBe(false);
    expect(backend.containers.get(name)?.exited).toBe(true);
    expect(backend.terminateCalls).toHaveLength(3);
    expect(backend.ensureCalls).toHaveLength(4);
    expect(
      records.filter((r) => r.message.includes("Replacement limit reached")),
    ).toHaveLength(2);
  });

  test("the replacement count survives a settle, so a launch cannot be rebuilt forever", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({
      executionId: "exec-1",
      observedState: "running",
      pendingReplacement: null,
      replacementCount: 3,
    });
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      operationId: row.operationId ?? "op",
      sessionId: row.sessionId,
    });
    // Rebuilt three times already, judged stale once more.
    backend.staleFor.add("exec-1#1");

    const summary = await run();
    expect(summary.replacementsExhausted).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(backend.terminateCalls).toEqual([]);
    expect(backend.containers.get("exec-1#1")?.exited).toBe(false);
  });

  test("a created-but-never-started resource is started through the same intent", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({ executionId: "exec-1" });
    backend.containers.set("exec-1#1", {
      exited: false,
      generation: 1,
      operationId: row.operationId ?? "op",
      sessionId: row.sessionId,
      started: false,
    });
    const summary = await run();
    expect(summary.reensured).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(backend.containers.get("exec-1#1")?.started).toBe(true);
    expect(store.executions.get("exec-1")?.observedState).toBe("running");
    // Adopting is not creating: the container's own nonce is still the only
    // credential for this launch, so nothing was issued behind its back.
    expect(store.executions.get("exec-1")?.nonce).toBeNull();
  });

  test("a running resource whose nonce expired before it claimed is replaced", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    const first = container.nonce;

    // The bootstrap door shut and nobody came through it. The container still
    // runs, so without this it would hold its slot and its session for good.
    row.nonceExpiresAt = new Date(Date.now() - 1);
    const summary = await run();

    expect(summary.replaced).toEqual([
      { executionId: row.executionId, generation: 1 },
    ]);
    expect(summary.reensured).toHaveLength(1);
    expect(store.confirmedGone).toEqual([]);
    const replacement = [...backend.containers.values()][0];
    expect(replacement?.nonce).not.toBe(first);
    expect(row.nonceExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(
      records.some(
        (r) => r.level === "warn" && r.message.includes("Launch nonce expired"),
      ),
    ).toBe(true);
  });

  test("an expired nonce on a claimed launch is left alone", async () => {
    const { backend, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name] = [...backend.containers.keys()];
    const row = store.executions.get(name?.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    // A worker already traded the nonce: its expiry says nothing any more.
    row.claimed = true;
    row.nonceExpiresAt = new Date(Date.now() - 1);

    const summary = await run();
    expect(summary.replaced).toEqual([]);
    expect(store.confirmedGone).toEqual([]);
    expect(backend.terminateCalls).toEqual([]);
  });

  test("a claim that lands mid-pass keeps its container off the replacement path", async () => {
    const { backend, records, run, store } = harness();
    store.addUnassigned(1);
    await run();
    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    const claimedNonce = container.nonce;
    row.nonceExpiresAt = new Date(Date.now() - 1);
    // A worker gets through the door after the pass read the rows and before
    // it decides: the expiry the pass is holding is already out of date.
    backend.duringInspect = () => {
      row.claimed = true;
      backend.duringInspect = null;
    };

    const summary = await run();

    expect(summary.replaced).toEqual([]);
    expect(backend.terminateCalls).toEqual([]);
    expect(store.confirmedGone).toEqual([]);
    // Same container, same credential: the binding it made still stands.
    expect([...backend.containers.keys()]).toEqual([name]);
    expect(row.nonce).toBe(claimedNonce ?? null);
    expect(
      records.some(
        (r) => r.level === "info" && r.message.includes("already been claimed"),
      ),
    ).toBe(true);
  });

  test("a claimed launch whose resource vanished is confirmed gone, never re-created", async () => {
    const { backend, records, run, store } = harness();
    store.seedActive({
      claimed: true,
      executionId: "exec-1",
      observedState: "running",
    });
    const summary = await run();
    expect(store.confirmedGone).toEqual(["exec-1"]);
    expect(summary.terminatedObserved).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(summary.reensured).toEqual([]);
    expect(backend.ensureCalls).toEqual([]);
    expect(
      records.some((r) => r.level === "warn" && r.message.includes("vanished")),
    ).toBe(true);
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

  test("a resource whose launch already gave its slot back is an orphan", async () => {
    const { backend, run, store } = harness();
    const row = store.seedActive({
      executionId: "exec-1",
      observedState: "terminated",
      slotReleased: true,
    });
    backend.containers.set("exec-1#1", {
      exited: true,
      generation: 1,
      operationId: row.operationId ?? "op",
      sessionId: row.sessionId,
    });
    const summary = await run();
    expect(summary.orphansTerminated).toEqual([
      { executionId: "exec-1", generation: 1 },
    ]);
    expect(backend.containers.size).toBe(0);
  });

  test("a terminated observation does not free the slot; only confirming it gone does", async () => {
    const { backend, run, store } = harness(1);
    // Two sessions, one slot: the second can only start once the first
    // launch's slot comes back, and the ledger is the launch row alone.
    store.addUnassigned(2);
    const first = await run();
    expect(first.launched).toHaveLength(1);

    const [name, container] = [...backend.containers.entries()][0] ?? [];
    if (!name || !container) throw new Error("no container");
    // A row recorded terminated by hand is not a released slot.
    const row = store.executions.get(name.split("#")[0] ?? "");
    if (!row) throw new Error("no row");
    row.observedState = "terminated";
    expect((await run()).launched).toEqual([]);

    container.exited = true;
    const third = await run();
    expect(store.confirmedGone).toEqual([row.executionId]);
    expect(third.terminatedObserved).toHaveLength(1);
    expect(third.launched).toHaveLength(1);
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

  test("a resource that dies right after launch is a failed launch, not a success", async () => {
    const { backend, records, run, store } = harness();
    const [sessionId] = store.addUnassigned(1);
    if (!sessionId) throw new Error("no session");
    backend.exitOnStartFor.add(sessionId);

    const summary = await run();
    expect(summary.launched).toEqual([]);
    expect(summary.failedLaunches).toHaveLength(1);
    expect(
      records.some(
        (r) => r.level === "error" && r.message.includes("right after launch"),
      ),
    ).toBe(true);
    // The launch still holds its slot, so the next pass reclaims the dead
    // resource as its own and only then hands the slot back.
    backend.exitOnStartFor.clear();
    const next = await run();
    expect(next.terminatedObserved).toHaveLength(1);
    expect(next.orphansTerminated).toEqual([]);
    expect(store.confirmedGone).toHaveLength(1);
  });

  test("an orphan whose termination throws is unresolved and holds a slot", async () => {
    const { backend, records, run, store } = harness(1);
    backend.containers.set("stray#1", {
      exited: false,
      generation: 1,
      operationId: "op-stray",
      sessionId: "s-stray",
    });
    backend.failTerminateFor.add("stray#1");
    store.addUnassigned(1);

    const summary = await run();
    expect(summary.orphansUnresolved).toEqual([
      { executionId: "stray", generation: 1 },
    ]);
    expect(summary.launched).toEqual([]);
    expect(
      records.some((r) => r.level === "error" && r.message.includes("orphan")),
    ).toBe(true);
  });

  test("a legacy row without an intent is inspected and closed, never relaunched", async () => {
    const { backend, run, store } = harness();
    const gone = store.seedActive({
      executionId: "legacy-gone",
      observedState: "running",
      operationId: null,
    });
    const exited = store.seedActive({
      executionId: "legacy-exited",
      observedState: "running",
      operationId: null,
    });
    backend.containers.set("legacy-exited#1", {
      exited: true,
      generation: 1,
      operationId: "op-old",
      sessionId: exited.sessionId,
    });

    const summary = await run();
    expect(backend.ensureCalls).toEqual([]);
    expect(summary.terminatedObserved.map((r) => r.executionId).sort()).toEqual(
      ["legacy-exited", "legacy-gone"],
    );
    expect(store.executions.get(gone.executionId)?.observedState).toBe(
      "terminated",
    );
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
    const { run, store } = harness();
    store.failList = true;
    await expect(run()).rejects.toThrow("database down");
    expect(store.locked).toBe(false);
  });

  test("one row's inspect failure does not stop the rest of the pass", async () => {
    const { backend, records, run, store } = harness();
    const bad = store.seedActive({
      executionId: "exec-bad",
      observedState: "running",
    });
    const good = store.seedActive({
      executionId: "exec-good",
      observedState: "running",
    });
    backend.containers.set("exec-good#1", {
      exited: false,
      generation: 1,
      operationId: good.operationId ?? "op",
      sessionId: good.sessionId,
    });
    backend.failInspectFor.add(bad.executionId);
    store.addUnassigned(1);

    const summary = await run();
    expect(summary.reconcileFailed).toEqual([
      { executionId: "exec-bad", generation: 1 },
    ]);
    expect(summary.launched).toHaveLength(1);
    expect(store.executions.get("exec-bad")?.observedState).toBe("running");
    expect(
      records.some(
        (r) => r.level === "error" && r.message.includes("Reconciling"),
      ),
    ).toBe(true);
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

describe("reclaimWorkspaces", () => {
  test("frees finished workspaces without starting or replacing anything", async () => {
    // The caller has just been refused admission. A pass with no free slots
    // would still re-ensure the missing container below and replace the stale
    // one; this must do neither.
    const { backend, reclaim, store } = harness();
    store.addUnassigned(2);
    await harness().run();
    const [live] = store.addUnassigned(1);
    if (live === undefined) throw new Error("fixture has no session");
    const intent = await store.reserveLaunch({
      backend: "local_docker",
      now: new Date(),
      sessionId: live,
      slotLimit: 10,
    });
    if (!intent) throw new Error("reservation refused");
    backend.ensureCalls.length = 0;
    backend.workspaces.set("ap-ws-done", "session-done");
    backend.workspaces.set("ap-ws-live", live);
    store.retainedSessions.add(live);

    const summary = await reclaim();

    expect(summary.workspacesReclaimed).toEqual(["ap-ws-done"]);
    expect(backend.workspaces.has("ap-ws-live")).toBe(true);
    // Nothing was launched, adopted or torn down.
    expect(backend.ensureCalls).toEqual([]);
    expect(backend.terminateCalls).toEqual([]);
    expect(summary.launched).toEqual([]);
    expect(summary.reensured).toEqual([]);
    expect(summary.replaced).toEqual([]);
  });

  test("a held lock skips it, as it does a whole pass", async () => {
    const { backend, reclaim, store } = harness();
    backend.workspaces.set("ap-ws-done", "session-done");
    await store.acquirePassLock();

    const summary = await reclaim();

    expect(summary.skipped).toBe(true);
    expect(backend.workspaces.has("ap-ws-done")).toBe(true);
  });

  test("a failed scan is reported, not swallowed", async () => {
    const { backend, reclaim } = harness();
    backend.failListWorkspaces = true;

    expect((await reclaim()).workspaceScanFailed).toBe(true);
  });
});

describe("runScheduler workspace GC", () => {
  test("reclaims a finished session's workspace and keeps a live one's", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-live", "session-live");
    backend.workspaces.set("ap-ws-done", "session-done");
    store.retainedSessions.add("session-live");

    const summary = await run();

    expect(summary.workspacesReclaimed).toEqual(["ap-ws-done"]);
    expect([...backend.workspaces.keys()]).toEqual(["ap-ws-live"]);
  });

  test("asks the daemon before the database, never the other way round", async () => {
    // A session created between the two calls has to land in the retained
    // set. Listing after the query would make its brand-new workspace look
    // unowned by the time it was seen.
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-1", "session-1");
    const order: string[] = [];
    const listed = backend.listWorkspaces;
    if (!listed) throw new Error("fixture has no workspace GC");
    backend.listWorkspaces = async () => {
      order.push("list");
      return listed();
    };
    const filter = store.filterRetainedSessions.bind(store);
    store.filterRetainedSessions = async (ids) => {
      order.push("query");
      return filter(ids);
    };

    await run();

    expect(order).toEqual(["list", "query"]);
  });

  test("a workspace with no session label is left alone and reported", async () => {
    const { backend, records, run, store } = harness();
    backend.workspaces.set("ap-ws-unlabelled", null);

    const summary = await run();

    expect(summary.workspacesReclaimed).toEqual([]);
    expect(summary.workspacesUnresolved).toEqual([]);
    expect(backend.workspaces.has("ap-ws-unlabelled")).toBe(true);
    // Never asked about: nothing here can turn it into a session id.
    expect(store.retainedQueries).toEqual([]);
    expect(records.some((r) => r.message.includes("carries no session"))).toBe(
      true,
    );
  });

  test("a mounted workspace stays and is counted unresolved", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-busy", "session-busy");
    backend.workspacesInUse.add("ap-ws-busy");
    void store;

    const summary = await run();

    expect(summary.workspacesUnresolved).toEqual(["ap-ws-busy"]);
    expect(backend.workspaces.has("ap-ws-busy")).toBe(true);
  });

  test("a removal that throws leaves the rest of GC running", async () => {
    const { backend, run } = harness();
    backend.workspaces.set("ap-ws-a", "session-a");
    backend.workspaces.set("ap-ws-b", "session-b");
    backend.failRemoveWorkspaceFor.add("ap-ws-a");

    const summary = await run();

    // A removal that threw is a fault, not a decision to leave it.
    expect(summary.workspacesFailed).toEqual(["ap-ws-a"]);
    expect(summary.workspacesUnresolved).toEqual([]);
    expect(summary.workspacesReclaimed).toEqual(["ap-ws-b"]);
  });

  test("a daemon that will not list reclaims nothing and does not fail the pass", async () => {
    const { backend, run, store } = harness();
    backend.failListWorkspaces = true;
    store.addUnassigned(1);

    const summary = await run();

    expect(summary.workspacesReclaimed).toEqual([]);
    expect(summary.workspaceScanFailed).toBe(true);
    // The launches still happened; GC is the last step for exactly this reason.
    expect(summary.launched).toHaveLength(1);
  });

  test("a database that will not answer reclaims nothing", async () => {
    const { backend, run, store } = harness();
    backend.workspaces.set("ap-ws-done", "session-done");
    store.failRetained = true;

    const summary = await run();

    expect(summary.workspacesReclaimed).toEqual([]);
    expect(summary.workspaceScanFailed).toBe(true);
    expect(backend.workspaces.has("ap-ws-done")).toBe(true);
  });

  test("a backend that does not own its workspaces runs no GC", async () => {
    const { backend, run, store } = harness(10, { workspaceGc: false });
    expect(backend.listWorkspaces).toBeUndefined();

    const summary = await run();

    expect(summary.workspacesReclaimed).toEqual([]);
    expect(store.retainedQueries).toEqual([]);
  });

  test("a workspace whose volume is already gone counts as reclaimed", async () => {
    // The scheduler asks for a removal it cannot know has already happened;
    // `absent` is the same end state, not a failure to report.
    const { backend, run } = harness();
    backend.workspaces.set("ap-ws-gone", "session-gone");
    backend.workspaces.delete("ap-ws-gone");
    const listed = backend.listWorkspaces;
    if (!listed) throw new Error("fixture has no workspace GC");
    backend.listWorkspaces = async () => [
      { createdAt: new Date(0), id: "ap-ws-gone", sessionId: "session-gone" },
    ];

    const summary = await run();

    expect(summary.workspacesReclaimed).toEqual(["ap-ws-gone"]);
  });
});
