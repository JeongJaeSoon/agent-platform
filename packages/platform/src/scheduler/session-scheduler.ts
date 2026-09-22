import type {
  ExecutionBackend,
  ExecutionObservation,
  ExecutionRef,
  ExecutionResources,
  LaunchIntent,
  ManagedWorkspace,
  TerminateExecutionResult,
} from "../ports/execution-backend.ts";
import type {
  ActiveExecution,
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
  /** true when another pass held the lock and this one did nothing. */
  skipped: boolean;
  activeAfter: number;
  activeBefore: number;
  /** Executions whose row lists them as live but the provider had lost. */
  failedLaunches: ExecutionRef[];
  launched: ExecutionRef[];
  orphansTerminated: ExecutionRef[];
  /** Orphans the provider would not terminate; each still holds a slot. */
  orphansUnresolved: ExecutionRef[];
  /** Exited resources whose reclaim failed; each row stays `terminating`. */
  reclaimFailed: ExecutionRef[];
  /** Rows whose reconcile threw; they stay live and are retried next pass. */
  reconcileFailed: ExecutionRef[];
  /** Intents re-ensured after the resource was missing or not yet observed. */
  reensured: ExecutionRef[];
  /** Resources torn down because they predate the current isolation contract. */
  replaced: ExecutionRef[];
  slotLimit: number;
  terminatedObserved: ExecutionRef[];
  /**
   * true when GC could not even draw up its candidate list — listing the
   * workspaces or asking the store which sessions are retained threw. Nothing
   * was removed, and unlike the outcomes below this is a fault, not a
   * judgement, so the exit code carries it.
   */
  workspaceScanFailed: boolean;
  /** Workspaces whose removal threw; neither reclaimed nor deliberately kept. */
  workspacesFailed: string[];
  /** Workspaces of finished sessions, reclaimed by this pass. */
  workspacesReclaimed: string[];
  /**
   * Workspaces GC decided to reclaim and deliberately left alone: still
   * mounted, or no longer this installation's. Not part of the exit code — a
   * volume mounted by a container that is still shutting down is the normal
   * state during a teardown, and the next pass takes it.
   */
  workspacesUnresolved: string[];
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
 * 4. Workspaces of sessions nothing will come back to are reclaimed. Last,
 *    so a slow daemon listing never delays a launch.
 */
export async function runScheduler(
  options: SchedulerOptions,
): Promise<SchedulerRunSummary> {
  if (!Number.isInteger(options.slotLimit) || options.slotLimit < 0) {
    throw new Error("slotLimit must be a non-negative integer");
  }
  const release = await options.store.acquirePassLock();
  if (release === null) {
    options.logger.warn("Another scheduling pass holds the lock; skipping");
    return { ...emptySummary(options.slotLimit), skipped: true };
  }
  try {
    return await pass(options);
  } finally {
    await release();
  }
}

function emptySummary(slotLimit: number): SchedulerRunSummary {
  return {
    activeAfter: 0,
    activeBefore: 0,
    failedLaunches: [],
    launched: [],
    orphansTerminated: [],
    orphansUnresolved: [],
    reclaimFailed: [],
    reconcileFailed: [],
    reensured: [],
    replaced: [],
    skipped: false,
    slotLimit,
    terminatedObserved: [],
    workspaceScanFailed: false,
    workspacesFailed: [],
    workspacesReclaimed: [],
    workspacesUnresolved: [],
  };
}

async function pass(options: SchedulerOptions): Promise<SchedulerRunSummary> {
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
  const summary = emptySummary(options.slotLimit);

  // 1. Reconcile rows against the provider.
  const active = await store.listActiveExecutions(backend.kind);
  summary.activeBefore = active.length;
  for (const execution of active) {
    const ref = refOf(execution);
    try {
      await reconcile(execution);
    } catch (error) {
      // A resource-local failure (ownership conflict, a stuck inspect) must
      // not take the rest of the pass down with it. The row stays live, so
      // it keeps its slot until a later pass resolves it.
      summary.reconcileFailed.push(ref);
      logger.error("Reconciling execution failed; row left as is", {
        ...fieldsOf(ref),
        error: messageOf(error),
        session_id: execution.sessionId,
      });
    }
  }

  async function reconcile(execution: ActiveExecution): Promise<void> {
    const ref = refOf(execution);
    if (execution.backend !== backend.kind) {
      // The store is scoped; a row leaking through anyway must never be
      // recreated on this provider.
      logger.error("Execution row belongs to another backend; skipping", {
        ...fieldsOf(ref),
        row_backend: execution.backend,
        session_id: execution.sessionId,
      });
      return;
    }
    const observed = await backend.inspect(ref);
    if (observed.found && observed.stale && observed.state !== "terminated") {
      // The resource runs under an isolation contract this host no longer
      // promises, and an upgrade cannot reach inside a running resource. It
      // is torn down here and re-created from the stored intent.
      logger.warn("Execution resource predates the isolation contract", {
        ...fieldsOf(ref),
        provider_ref: observed.providerRef,
        session_id: execution.sessionId,
        state: observed.state,
      });
      let outcome: TerminateExecutionResult;
      try {
        outcome = await backend.terminate(ref);
      } catch (error) {
        summary.reconcileFailed.push(ref);
        logger.error("Replacing a stale execution resource failed", {
          ...fieldsOf(ref),
          error: messageOf(error),
          session_id: execution.sessionId,
        });
        return;
      }
      if (outcome.outcome !== "terminated") {
        // Left untouched, so the row keeps its slot and the next pass retries.
        summary.reconcileFailed.push(ref);
        logger.error("A stale execution resource would not terminate", {
          ...fieldsOf(ref),
          outcome: outcome.outcome,
          session_id: execution.sessionId,
        });
        return;
      }
      summary.replaced.push(ref);
      await reensure(execution, unknownObservation(now()), "stale_isolation");
      return;
    }
    if (
      observed.found &&
      observed.state !== "terminated" &&
      observed.state !== "pending"
    ) {
      await store.recordObservation(ref, observed);
      return;
    }
    if (observed.found && observed.state === "terminated") {
      // Mark, reclaim, then record. `terminating` keeps the row live so a
      // failed or interrupted removal is retried, and tells the next pass
      // that an absent resource means "reclaimed", not "relaunch me".
      await store.recordObservation(ref, {
        ...observed,
        state: "terminating",
      });
      let outcome: TerminateExecutionResult;
      try {
        outcome = await backend.terminate(ref);
      } catch (error) {
        logger.error("Reclaiming exited execution resource failed", {
          ...fieldsOf(ref),
          error: messageOf(error),
          session_id: execution.sessionId,
        });
        summary.reclaimFailed.push(ref);
        return;
      }
      if (outcome.outcome === "generation_mismatch") {
        // The resource was left untouched, so the slot stays occupied; the
        // row remains `terminating` and the next pass tries again.
        logger.error(
          "Reclaiming exited execution resource hit a generation mismatch",
          {
            ...fieldsOf(ref),
            found_generation: outcome.foundGeneration,
            session_id: execution.sessionId,
          },
        );
        summary.reclaimFailed.push(ref);
        return;
      }
      await store.recordObservation(ref, observed);
      summary.terminatedObserved.push(ref);
      logger.info("Execution exited; resource reclaimed", {
        ...fieldsOf(ref),
        exit_code: observed.exitCode ?? null,
        session_id: execution.sessionId,
      });
      return;
    }
    if (!observed.found && execution.observedState === "terminating") {
      // The previous pass removed the resource but crashed before recording.
      await store.recordObservation(ref, {
        ...observed,
        state: "terminated",
      });
      summary.terminatedObserved.push(ref);
      return;
    }
    // Row says live but the provider has nothing, or has a resource that was
    // created and never started. The stored intent covers both: ensure is
    // idempotent and starts a pending resource it already owns.
    await reensure(execution, observed, "missing");
  }

  async function reensure(
    execution: ActiveExecution,
    observed: ExecutionObservation,
    reason: "missing" | "stale_isolation",
  ): Promise<void> {
    const ref = refOf(execution);
    const stored = storedIntentOf(execution);
    if (stored === null) {
      // Pre-intent row: nothing to relaunch from, so close it out instead of
      // letting it hold a slot forever.
      await store.recordObservation(ref, {
        ...observed,
        state: "terminated",
      });
      summary.terminatedObserved.push(ref);
      logger.warn(
        "Execution row has no launch intent; closed without relaunch",
        {
          ...fieldsOf(ref),
          previous_state: execution.observedState,
          session_id: execution.sessionId,
        },
      );
      return;
    }
    try {
      const ensured = await backend.ensureExecution(intentOf(stored));
      await store.recordObservation(ref, {
        found: true,
        observedAt: now(),
        providerRef: ensured.providerRef,
        state: ensured.state,
      });
      if (!isLaunched(ensured.state)) {
        summary.failedLaunches.push(ref);
        logger.error("Re-created execution resource did not stay up", {
          ...fieldsOf(ref),
          provider_ref: ensured.providerRef,
          session_id: execution.sessionId,
          state: ensured.state,
        });
        return;
      }
      summary.reensured.push(ref);
      logger.warn("Execution resource re-created from intent", {
        ...fieldsOf(ref),
        previous_state: execution.observedState,
        provider_ref: ensured.providerRef,
        reason,
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
    (await store.filterKnown(managed.map(refOf), backend.kind)).map(keyOf),
  );
  for (const resource of managed) {
    if (known.has(keyOf(resource))) continue;
    logger.warn("Execution resource has no launch intent; terminating", {
      ...fieldsOf(resource),
      provider_ref: resource.providerRef,
      session_id: resource.sessionId,
    });
    let outcome: TerminateExecutionResult;
    try {
      outcome = await backend.terminate(refOf(resource));
    } catch (error) {
      // One stuck resource must not stop the rest of the pass; it still
      // occupies the host, so it is counted against capacity below.
      logger.error("Terminating orphan resource failed", {
        ...fieldsOf(resource),
        error: messageOf(error),
        provider_ref: resource.providerRef,
      });
      summary.orphansUnresolved.push(refOf(resource));
      continue;
    }
    if (outcome.outcome !== "terminated") {
      logger.warn("Orphan resource was not terminated", {
        ...fieldsOf(refOf(resource)),
        outcome: outcome.outcome,
      });
      if (outcome.outcome === "generation_mismatch") {
        summary.orphansUnresolved.push(refOf(resource));
      }
      continue;
    }
    summary.orphansTerminated.push(refOf(resource));
  }

  // 3. Fill free slots.
  const demand = await store.inspectDemand({ limit: options.slotLimit });
  // Rows are the ledger, but a still-running orphan occupies the host too.
  let free = Math.max(
    0,
    options.slotLimit -
      demand.activeExecutionCount -
      summary.orphansUnresolved.length,
  );
  for (const sessionId of demand.eligibleSessionIds) {
    if (free <= 0) break;
    const stored = await store.reserveLaunch({
      backend: backend.kind,
      now: now(),
      sessionId,
      slotLimit: options.slotLimit,
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
      if (!isLaunched(ensured.state)) {
        // Created, but already dead (bad image, crashing entrypoint). The row
        // is recorded as observed; next pass reclaims the resource. Not a
        // success, so the process exits non-zero.
        summary.failedLaunches.push(ref);
        logger.error("Execution resource exited right after launch", {
          ...fieldsOf(ref),
          provider_ref: ensured.providerRef,
          session_id: sessionId,
          state: ensured.state,
        });
        continue;
      }
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
  // 4. Workspaces nothing will come back to.
  await collectWorkspaces();

  async function collectWorkspaces(): Promise<void> {
    const { listWorkspaces, removeWorkspace } = backend;
    // A backend whose workspaces it does not own leaves both out; there is
    // then nothing here to reclaim.
    if (!listWorkspaces || !removeWorkspace) return;
    let workspaces: ManagedWorkspace[];
    let retained: Set<string>;
    try {
      // Workspaces first, then the rows. A session created between the two
      // calls is in the retained set, so its brand-new workspace is kept;
      // asking the database first would make that same workspace look
      // unowned by the time it was listed.
      workspaces = await listWorkspaces.call(backend);
      if (workspaces.length === 0) return;
      const labelled = workspaces
        .map((workspace) => workspace.sessionId)
        .filter((sessionId): sessionId is string => sessionId !== null);
      retained =
        labelled.length === 0
          ? new Set<string>()
          : new Set(await store.filterRetainedSessions(labelled));
    } catch (error) {
      // Nothing was removed, so nothing is inconsistent; the next pass
      // reclaims whatever this one could not even look at. It is still a
      // failure, and a pass that keeps failing here keeps leaking disk.
      summary.workspaceScanFailed = true;
      logger.error("Listing workspaces for reclaim failed; none reclaimed", {
        error: messageOf(error),
      });
      return;
    }
    for (const workspace of workspaces) {
      const { id, sessionId } = workspace;
      if (sessionId === null) {
        // Fail-safe, as with an unparseable container: a workspace whose
        // owner cannot be read is left in place and reported, never guessed
        // at from its name.
        logger.warn("Workspace carries no session; left in place", {
          created_at: workspace.createdAt.toISOString(),
          workspace_id: id,
        });
        continue;
      }
      if (retained.has(sessionId)) continue;
      let outcome: string;
      try {
        outcome = (await removeWorkspace.call(backend, id)).outcome;
      } catch (error) {
        summary.workspacesFailed.push(id);
        logger.error("Reclaiming workspace failed", {
          error: messageOf(error),
          session_id: sessionId,
          workspace_id: id,
        });
        continue;
      }
      if (outcome === "removed" || outcome === "absent") {
        summary.workspacesReclaimed.push(id);
        logger.info("Workspace reclaimed", {
          outcome,
          session_id: sessionId,
          workspace_id: id,
        });
        continue;
      }
      summary.workspacesUnresolved.push(id);
      logger.warn("Workspace was not reclaimed", {
        outcome,
        session_id: sessionId,
        workspace_id: id,
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
    orphan_unresolved_count: summary.orphansUnresolved.length,
    reclaim_failed_count: summary.reclaimFailed.length,
    reconcile_failed_count: summary.reconcileFailed.length,
    reensured_count: summary.reensured.length,
    replaced_count: summary.replaced.length,
    slot_limit: summary.slotLimit,
    terminated_count: summary.terminatedObserved.length,
    workspace_failed_count: summary.workspacesFailed.length,
    workspace_reclaimed_count: summary.workspacesReclaimed.length,
    workspace_scan_failed: summary.workspaceScanFailed,
    workspace_unresolved_count: summary.workspacesUnresolved.length,
  });
  return summary;
}

/** Only these states mean the launch took; anything else is a failure. */
function isLaunched(state: ExecutionObservation["state"]): boolean {
  return state === "running" || state === "pending";
}

function storedIntentOf(execution: ActiveExecution): StoredLaunchIntent | null {
  if (execution.operationId === null || execution.bootstrapNonce === null) {
    return null;
  }
  return {
    bootstrapNonce: execution.bootstrapNonce,
    executionId: execution.executionId,
    generation: execution.generation,
    operationId: execution.operationId,
    sessionId: execution.sessionId,
  };
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
