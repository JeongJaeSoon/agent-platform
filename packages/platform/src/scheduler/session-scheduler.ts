import type {
  ExecutionBackend,
  ExecutionObservation,
  ExecutionRef,
  ExecutionResources,
  LaunchIntent,
} from "../ports/execution-backend.ts";
import type {
  SchedulerStore,
  StoredLaunchIntent,
} from "../ports/scheduler-store.ts";

export const DEFAULT_EXECUTION_SLOT_LIMIT = 10;

export type SchedulerLogger = {
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

export type SchedulerOptions = {
  backend: ExecutionBackend;
  image: string;
  logger: SchedulerLogger;
  now?: () => Date;
  resources: ExecutionResources;
  slotLimit: number;
  store: SchedulerStore;
};

export type SchedulerRunSummary = {
  activeAfter: number;
  activeBefore: number;
  /** Executions whose row lists them as live but the provider had lost. */
  failedLaunches: ExecutionRef[];
  launched: ExecutionRef[];
  orphansTerminated: ExecutionRef[];
  /** Intents re-ensured after the resource was missing or not yet observed. */
  reensured: ExecutionRef[];
  slotLimit: number;
  terminatedObserved: ExecutionRef[];
};

/**
 * One scheduling pass. Each step is its own set of transactions so a crash
 * between them leaves only intents the next pass can pick up again:
 *
 * 1. Every live execution row is inspected; a missing resource is re-ensured
 *    from the stored intent, an exited one is recorded and reclaimed.
 * 2. Provider resources without a matching row are logged and terminated.
 * 3. Remaining slots are filled: reserve (commit) then ensure, never inside
 *    the transaction.
 */
export async function runScheduler(
  options: SchedulerOptions,
): Promise<SchedulerRunSummary> {
  if (!Number.isInteger(options.slotLimit) || options.slotLimit < 0) {
    throw new Error("slotLimit must be a non-negative integer");
  }
  const now = options.now ?? (() => new Date());
  const { backend, logger, store } = options;
  const intentOf = (stored: StoredLaunchIntent): LaunchIntent => ({
    bootstrapNonce: stored.bootstrapNonce,
    executionId: stored.executionId,
    generation: stored.generation,
    image: options.image,
    operationId: stored.operationId,
    resources: options.resources,
    sessionId: stored.sessionId,
  });
  const summary: SchedulerRunSummary = {
    activeAfter: 0,
    activeBefore: 0,
    failedLaunches: [],
    launched: [],
    orphansTerminated: [],
    reensured: [],
    slotLimit: options.slotLimit,
    terminatedObserved: [],
  };

  // 1. Reconcile rows against the provider.
  const active = await store.listActiveExecutions();
  summary.activeBefore = active.length;
  for (const execution of active) {
    const ref = refOf(execution);
    const observed = await backend.inspect(ref);
    if (
      observed.found &&
      observed.state !== "terminated" &&
      observed.state !== "pending"
    ) {
      await store.recordObservation(ref, observed);
      continue;
    }
    if (observed.found && observed.state === "terminated") {
      // Reclaim first: if the stop/remove call fails the row stays live and
      // the next pass retries instead of leaking an exited container.
      try {
        await backend.terminate(ref);
      } catch (error) {
        logger.error("Reclaiming exited execution resource failed", {
          ...fieldsOf(ref),
          error: messageOf(error),
          session_id: execution.sessionId,
        });
        continue;
      }
      await store.recordObservation(ref, observed);
      summary.terminatedObserved.push(ref);
      logger.info("Execution exited; resource reclaimed", {
        ...fieldsOf(ref),
        exit_code: observed.exitCode ?? null,
        session_id: execution.sessionId,
      });
      continue;
    }
    // Row says live but the provider has nothing, or has a resource that was
    // created and never started. The stored intent covers both: ensure is
    // idempotent and starts a pending resource it already owns.
    try {
      const ensured = await backend.ensureExecution(intentOf(execution));
      await store.recordObservation(ref, {
        found: true,
        observedAt: now(),
        providerRef: ensured.providerRef,
        state: ensured.state,
      });
      summary.reensured.push(ref);
      logger.warn("Execution resource was missing; re-created from intent", {
        ...fieldsOf(ref),
        previous_state: execution.observedState,
        provider_ref: ensured.providerRef,
        session_id: execution.sessionId,
      });
    } catch (error) {
      summary.failedLaunches.push(ref);
      await store.recordObservation(ref, unknownObservation(now()));
      logger.error("Re-creating execution resource failed", {
        ...fieldsOf(ref),
        error: messageOf(error),
        session_id: execution.sessionId,
      });
    }
  }

  // 2. Resources nobody owns.
  const managed = await backend.listManaged();
  const known = new Set(
    (await store.filterKnown(managed.map(refOf))).map(keyOf),
  );
  for (const resource of managed) {
    if (known.has(keyOf(resource))) continue;
    logger.warn("Execution resource has no launch intent; terminating", {
      ...fieldsOf(resource),
      provider_ref: resource.providerRef,
      session_id: resource.sessionId,
    });
    await backend.terminate(refOf(resource));
    summary.orphansTerminated.push(refOf(resource));
  }

  // 3. Fill free slots.
  const demand = await store.inspectDemand({ limit: options.slotLimit });
  let free = Math.max(0, options.slotLimit - demand.activeExecutionCount);
  for (const sessionId of demand.eligibleSessionIds) {
    if (free <= 0) break;
    const stored = await store.reserveLaunch({
      backend: backend.kind,
      now: now(),
      sessionId,
    });
    if (stored === null) continue;
    free -= 1;
    const ref = refOf(stored);
    try {
      const ensured = await backend.ensureExecution(intentOf(stored));
      await store.recordObservation(ref, {
        found: true,
        observedAt: now(),
        providerRef: ensured.providerRef,
        state: ensured.state,
      });
      summary.launched.push(ref);
      logger.info("Execution launched", {
        ...fieldsOf(ref),
        created: ensured.created,
        provider_ref: ensured.providerRef,
        session_id: sessionId,
      });
    } catch (error) {
      // The intent stays committed; step 1 of the next pass retries it.
      summary.failedLaunches.push(ref);
      await store.recordObservation(ref, unknownObservation(now()));
      logger.error("Launching execution failed; intent kept for retry", {
        ...fieldsOf(ref),
        error: messageOf(error),
        session_id: sessionId,
      });
    }
  }
  summary.activeAfter = (
    await store.inspectDemand({ limit: 0 })
  ).activeExecutionCount;
  logger.info("Scheduling pass completed", {
    active_after: summary.activeAfter,
    active_before: summary.activeBefore,
    failed_count: summary.failedLaunches.length,
    launched_count: summary.launched.length,
    orphan_count: summary.orphansTerminated.length,
    reensured_count: summary.reensured.length,
    slot_limit: summary.slotLimit,
    terminated_count: summary.terminatedObserved.length,
  });
  return summary;
}

function refOf(ref: ExecutionRef): ExecutionRef {
  return { executionId: ref.executionId, generation: ref.generation };
}

function keyOf(ref: ExecutionRef): string {
  return `${ref.executionId}#${ref.generation}`;
}

function fieldsOf(ref: ExecutionRef) {
  return { execution_id: ref.executionId, generation: ref.generation };
}

function unknownObservation(observedAt: Date): ExecutionObservation {
  return { found: false, observedAt, providerRef: null, state: "unknown" };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
